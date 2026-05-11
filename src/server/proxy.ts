import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { decryptSecret } from "./crypto.js";
import { estimateSpendCents, refreshLiveBalances } from "./balance.js";
import { nextRoundRobinIndex, selectAccount } from "./selector.js";
import { updateGateway } from "./store.js";
import { detectEndpointProvider } from "../shared/providers.js";
import type {
  EndpointProviderDefinition,
  GatewayStored,
  ModelCompanyDefinition,
  ProviderAccountStored
} from "../shared/types.js";

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function accountBaseUrl(modelCompany: ModelCompanyDefinition, account: ProviderAccountStored) {
  return account.baseUrl || modelCompany.defaultBaseUrl;
}

function accountEndpointProvider(modelCompany: ModelCompanyDefinition, account: ProviderAccountStored) {
  return detectEndpointProvider(accountBaseUrl(modelCompany, account), modelCompany.defaultEndpointProviderId);
}

function buildUpstreamUrl(modelCompany: ModelCompanyDefinition, account: ProviderAccountStored, requestUrl: string) {
  const parsed = new URL(requestUrl, "http://gateway.local");
  const upstreamPath = parsed.pathname.replace(/^\/v1\/?/, "");
  const baseUrl = trimTrailingSlash(accountBaseUrl(modelCompany, account));
  return `${baseUrl}${upstreamPath ? `/${upstreamPath}` : ""}${parsed.search}`;
}

function endpointHeaders(endpointProvider: EndpointProviderDefinition, apiKey: string, account: ProviderAccountStored, request: FastifyRequest) {
  const incomingContentType = request.headers["content-type"];
  const incomingAccept = request.headers.accept;
  const headers: Record<string, string> = {
    ...(incomingAccept ? { accept: String(incomingAccept) } : {}),
    ...(incomingContentType ? { "content-type": String(incomingContentType) } : { "content-type": "application/json" }),
    ...account.customHeaders
  };

  if (endpointProvider.authType === "x-api-key") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = account.customHeaders?.["anthropic-version"] ?? "2023-06-01";
  } else {
    headers.authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

function requestBody(request: FastifyRequest) {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  if (typeof request.body === "undefined") return undefined;
  if (typeof request.body === "string" || request.body instanceof Uint8Array) return request.body;
  return JSON.stringify(request.body);
}

function shouldRetryStatus(gateway: GatewayStored, status: number) {
  if (status === 429) return gateway.failover.switchOnRateLimit;
  if (status === 401 || status === 403) return gateway.failover.switchOnAuthError;
  if (status === 402) return gateway.failover.switchOnLowBalance;
  if (status >= 500) return gateway.failover.switchOnServerError;
  return false;
}

function statusMessage(status: number, body: string) {
  if (body) {
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
      return parsed.error?.message || parsed.message || `Upstream returned HTTP ${status}`;
    } catch {
      return body.slice(0, 240);
    }
  }
  return `Upstream returned HTTP ${status}`;
}

function markAttempt(
  gateway: GatewayStored,
  accountId: string,
  patch: Partial<ProviderAccountStored>,
  spendCents = 0
) {
  return {
    ...gateway,
    accounts: gateway.accounts.map((account) => {
      if (account.id !== accountId) return account;
      const nextBalance =
        typeof account.estimatedBalanceCents === "number"
          ? Math.max(0, account.estimatedBalanceCents - spendCents)
          : account.estimatedBalanceCents;
      return {
        ...account,
        ...patch,
        spentCents: account.spentCents + spendCents,
        estimatedBalanceCents: nextBalance
      };
    })
  };
}

function copyResponseHeaders(upstream: Response) {
  const headers: Record<string, string> = {};
  for (const [key, value] of upstream.headers.entries()) {
    const lower = key.toLowerCase();
    if (["content-length", "transfer-encoding", "content-encoding", "connection", "keep-alive"].includes(lower)) continue;
    headers[key] = value;
  }
  headers["x-accel-buffering"] = "no";
  return headers;
}

function isStreamingResponse(request: FastifyRequest, upstream: Response) {
  const contentType = upstream.headers.get("content-type") ?? "";
  const body = request.body as { stream?: unknown } | undefined;
  return contentType.includes("text/event-stream") || Boolean(body?.stream);
}

async function sendTextResponse(reply: FastifyReply, upstream: Response, text: string) {
  for (const [key, value] of Object.entries(copyResponseHeaders(upstream))) {
    reply.header(key, value);
  }
  reply.code(upstream.status);
  return reply.send(text);
}

export async function proxyUniversalV1(
  gateway: GatewayStored,
  modelCompany: ModelCompanyDefinition,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const attempted = new Set<string>();
  const maxAttempts = Math.max(1, Math.min(gateway.accounts.length, gateway.failover.maxRetries + 1));
  let currentGateway = await refreshLiveBalances(gateway, modelCompany);
  let lastError = "No endpoint account was attempted.";

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const account = selectAccount(currentGateway, attempted);
    if (!account) break;
    attempted.add(account.id);

    const endpointProvider = accountEndpointProvider(modelCompany, account);
    const started = Date.now();
    const apiKey = decryptSecret(account.encryptedApiKey);
    const upstreamUrl = buildUpstreamUrl(modelCompany, account, request.url);

    try {
      const upstream = await fetch(upstreamUrl, {
        method: request.method,
        headers: endpointHeaders(endpointProvider, apiKey, account, request),
        body: requestBody(request)
      });

      const latencyMs = Date.now() - started;

      if (!upstream.ok && shouldRetryStatus(currentGateway, upstream.status)) {
        const errorText = await upstream.text();
        lastError = statusMessage(upstream.status, errorText);
        const cooldownUntil = new Date(Date.now() + currentGateway.failover.cooldownSeconds * 1000).toISOString();
        const updated = await updateGateway(currentGateway.id, (stored) =>
          markAttempt(stored, account.id, {
            status: upstream.status === 402 ? "exhausted" : account.status,
            lastError,
            cooldownUntil,
            latencyMs,
            requestCount: account.requestCount + 1,
            lastUsedAt: new Date().toISOString()
          })
        );
        if (updated) currentGateway = updated;
        continue;
      }

      if (isStreamingResponse(request, upstream) && upstream.body) {
        await updateGateway(currentGateway.id, (stored) => ({
          ...markAttempt(stored, account.id, {
            status: upstream.ok ? "active" : account.status,
            lastError: upstream.ok ? undefined : `Upstream returned HTTP ${upstream.status}`,
            latencyMs,
            requestCount: account.requestCount + 1,
            lastUsedAt: new Date().toISOString()
          }),
          lastRoundRobinIndex: nextRoundRobinIndex(stored, account.id)
        }));

        reply.raw.writeHead(upstream.status, copyResponseHeaders(upstream));
        Readable.fromWeb(upstream.body).pipe(reply.raw);
        return reply;
      }

      const text = await upstream.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = text;
      }

      const spendCents = upstream.ok ? estimateSpendCents(endpointProvider, parsed) : 0;
      await updateGateway(currentGateway.id, (stored) => ({
        ...markAttempt(
          stored,
          account.id,
          {
            status: upstream.ok ? "active" : account.status,
            lastError: upstream.ok ? undefined : statusMessage(upstream.status, text),
            latencyMs,
            requestCount: account.requestCount + 1,
            lastUsedAt: new Date().toISOString()
          },
          spendCents
        ),
        lastRoundRobinIndex: nextRoundRobinIndex(stored, account.id)
      }));

      if (typeof parsed === "string") return sendTextResponse(reply, upstream, parsed);

      for (const [key, value] of Object.entries(copyResponseHeaders(upstream))) {
        reply.header(key, value);
      }
      return reply.code(upstream.status).send(parsed);
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Network error";
      if (!currentGateway.failover.switchOnNetworkError) break;

      const cooldownUntil = new Date(Date.now() + currentGateway.failover.cooldownSeconds * 1000).toISOString();
      const updated = await updateGateway(currentGateway.id, (stored) =>
        markAttempt(stored, account.id, {
          lastError,
          cooldownUntil,
          requestCount: account.requestCount + 1,
          lastUsedAt: new Date().toISOString()
        })
      );
      if (updated) currentGateway = updated;
    }
  }

  return reply.code(503).send({
    error: {
      message: `No healthy endpoint account is available. Last error: ${lastError}`,
      type: "gateway_unavailable",
      code: "no_available_key"
    }
  });
}
