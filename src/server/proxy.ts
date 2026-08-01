import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import { decryptSecret } from "./crypto.js";
import { estimateSpendCents, refreshLiveBalances } from "./balance.js";
import { nextRoundRobinIndex, selectAccount } from "./selector.js";
import { deferGatewayUpdate } from "./store.js";
import { detectEndpointProvider } from "../shared/providers.js";
import type { ClientProtocol } from "../shared/constants.js";
import type {
  EndpointProviderDefinition,
  GatewayStored,
  ModelCompanyDefinition,
  ProviderAccountStored
} from "../shared/types.js";
import {
  incomingProtocol,
  ProtocolError,
  protocolEndpoint,
  translateErrorResponse,
  translateJsonResponse,
  translateRequestBody,
  translateSseStream
} from "./protocol.js";
import { env } from "./config.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function accountBaseUrl(modelCompany: ModelCompanyDefinition, account: ProviderAccountStored) {
  return account.baseUrl || modelCompany.defaultBaseUrl;
}

function accountEndpointProvider(modelCompany: ModelCompanyDefinition, account: ProviderAccountStored) {
  return detectEndpointProvider(accountBaseUrl(modelCompany, account), modelCompany.defaultEndpointProviderId);
}

function accountProtocol(modelCompany: ModelCompanyDefinition, account: ProviderAccountStored): ClientProtocol {
  if (account.upstreamProtocol) return account.upstreamProtocol;
  return accountEndpointProvider(modelCompany, account).compatibility === "native-adapter" ? "anthropic" : "openai";
}

function buildUpstreamUrl(
  modelCompany: ModelCompanyDefinition,
  account: ProviderAccountStored,
  endpoint: string,
  search: string
) {
  return `${trimTrailingSlash(accountBaseUrl(modelCompany, account))}/${endpoint.replace(/^\/+/, "")}${search}`;
}

function endpointHeaders(
  protocol: ClientProtocol,
  endpointProvider: EndpointProviderDefinition,
  apiKey: string,
  account: ProviderAccountStored,
  request: FastifyRequest
) {
  const headers: Record<string, string> = {
    accept: String(request.headers.accept ?? "application/json"),
    "content-type": String(request.headers["content-type"] ?? "application/json"),
    ...account.customHeaders
  };

  if (protocol === "anthropic" || endpointProvider.authType === "x-api-key") {
    delete headers.authorization;
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = String(
      request.headers["anthropic-version"] ?? account.customHeaders?.["anthropic-version"] ?? "2023-06-01"
    );
    if (request.headers["anthropic-beta"]) headers["anthropic-beta"] = String(request.headers["anthropic-beta"]);
  } else {
    delete headers["x-api-key"];
    headers.authorization = `Bearer ${apiKey}`;
    for (const name of ["openai-organization", "openai-project", "openai-beta"] as const) {
      if (request.headers[name]) headers[name] = String(request.headers[name]);
    }
  }
  return headers;
}

function rawRequestBody(request: FastifyRequest) {
  if (request.method === "GET" || request.method === "HEAD" || request.body === undefined) return undefined;
  if (typeof request.body === "string" || request.body instanceof Uint8Array) return request.body;
  return JSON.stringify(request.body);
}

function parsedRequestBody(request: FastifyRequest) {
  const raw = rawRequestBody(request);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
  } catch {
    throw new ProtocolError("Cross-protocol requests require a valid JSON body.");
  }
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

function retryAfterMs(response: Response, fallbackSeconds: number) {
  const value = response.headers.get("retry-after");
  if (!value) return fallbackSeconds * 1000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : fallbackSeconds * 1000;
}

function markAttempt(
  gateway: GatewayStored,
  accountId: string,
  patch: Partial<ProviderAccountStored>,
  spendCents = 0,
  success = false
) {
  return {
    ...gateway,
    accounts: gateway.accounts.map((account) => {
      if (account.id !== accountId) return account;
      const nextBalance = typeof account.estimatedBalanceCents === "number"
        ? Math.max(0, account.estimatedBalanceCents - spendCents)
        : account.estimatedBalanceCents;
      return {
        ...account,
        ...patch,
        requestCount: account.requestCount + 1,
        spentCents: account.spentCents + spendCents,
        estimatedBalanceCents: nextBalance,
        consecutiveFailures: success ? 0 : (account.consecutiveFailures ?? 0) + 1,
        ...(success ? { lastSuccessAt: new Date().toISOString(), cooldownUntil: undefined } : {})
      };
    })
  };
}

function recordAttempt(
  gateway: GatewayStored,
  accountId: string,
  patch: Partial<ProviderAccountStored>,
  spendCents = 0,
  success = false
) {
  const updater = (stored: GatewayStored) => ({
    ...markAttempt(stored, accountId, patch, spendCents, success),
    ...(success ? { lastRoundRobinIndex: nextRoundRobinIndex(stored, accountId) } : {})
  });
  deferGatewayUpdate(gateway.id, updater);
  return updater(gateway);
}

function copyResponseHeaders(upstream: Response, streaming = false) {
  const headers: Record<string, string> = {};
  for (const [key, value] of upstream.headers.entries()) {
    const lower = key.toLowerCase();
    if (["content-length", "transfer-encoding", "content-encoding", "connection", "keep-alive"].includes(lower)) continue;
    headers[key] = value;
  }
  if (streaming) {
    headers["content-type"] = "text/event-stream; charset=utf-8";
    headers["cache-control"] = "no-cache";
    headers["x-accel-buffering"] = "no";
  }
  return headers;
}

function applyResponseHeaders(reply: FastifyReply, upstream: Response, streaming = false) {
  for (const [key, value] of Object.entries(copyResponseHeaders(upstream, streaming))) reply.header(key, value);
}

async function sendStreamingResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  upstream: Response,
  source: ClientProtocol,
  target: ClientProtocol
) {
  reply.hijack();
  reply.raw.writeHead(upstream.status, copyResponseHeaders(upstream, true));
  if (!upstream.body) {
    reply.raw.end();
    return reply;
  }

  try {
    const stream = source === target
      ? Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream)
      : Readable.from(translateSseStream(source, target, upstream.body));
    await pipeline(stream, reply.raw);
  } catch (error) {
    request.log.warn({ err: error }, "Upstream stream terminated before completion");
    if (!reply.raw.destroyed) reply.raw.destroy();
  }
  return reply;
}

function protocolErrorBody(protocol: ClientProtocol, message: string, code = "unsupported_feature") {
  return protocol === "anthropic"
    ? { type: "error", error: { type: "invalid_request_error", message } }
    : { error: { message, type: "invalid_request_error", code } };
}

function unavailableBody(protocol: ClientProtocol, message: string) {
  return protocol === "anthropic"
    ? { type: "error", error: { type: "api_error", message } }
    : { error: { message, type: "gateway_unavailable", code: "no_available_key" } };
}

export async function proxyUniversalV1(
  gateway: GatewayStored,
  modelCompany: ModelCompanyDefinition,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const parsedUrl = new URL(request.url, "http://gateway.local");
  const clientProtocol = incomingProtocol(parsedUrl.pathname, Boolean(request.headers["x-api-key"]));
  const isModels = parsedUrl.pathname === "/v1/models";
  const supportedCrossEndpoint = isModels || parsedUrl.pathname === "/v1/chat/completions" || parsedUrl.pathname === "/v1/messages";
  const attempted = new Set<string>();
  const maxAttempts = Math.max(1, Math.min(gateway.accounts.length, gateway.failover.maxRetries + 1));
  let currentGateway = await refreshLiveBalances(gateway, modelCompany);
  let lastError = "No endpoint account was attempted.";
  let unsupportedError: ProtocolError | undefined;
  let hadUpstreamAttempt = false;
  let parsedBody: unknown;
  let requestParseError: ProtocolError | undefined;
  if (rawRequestBody(request) !== undefined) {
    try { parsedBody = parsedRequestBody(request); }
    catch (error) { requestParseError = error as ProtocolError; }
  }
  const deadlineAt = Date.now() + env.requestDeadlineMs;
  const clientAbort = new AbortController();
  const abortForDisconnect = () => {
    if (!reply.raw.writableEnded) clientAbort.abort(new Error("Client disconnected"));
  };
  request.raw.once("aborted", abortForDisconnect);
  reply.raw.once("close", abortForDisconnect);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const account = selectAccount(currentGateway, attempted);
    if (!account) break;
    attempted.add(account.id);
    const endpointProvider = accountEndpointProvider(modelCompany, account);
    const targetProtocol = accountProtocol(modelCompany, account);

    if (clientProtocol !== targetProtocol && !supportedCrossEndpoint) {
      unsupportedError = new ProtocolError(
        `${parsedUrl.pathname} cannot be translated from ${clientProtocol} to ${targetProtocol}. Add a native ${clientProtocol} upstream account.`
      );
      continue;
    }

    if (isModels && targetProtocol === "anthropic") {
      return reply.send({
        object: "list",
        data: [{ id: modelCompany.id, object: "model", created: 0, owned_by: modelCompany.name }]
      });
    }

    const started = Date.now();
    const apiKey = decryptSecret(account.encryptedApiKey);
    const endpoint = clientProtocol === targetProtocol
      ? parsedUrl.pathname.replace(/^\/v1/, "")
      : protocolEndpoint(targetProtocol, parsedUrl.pathname);
    const upstreamUrl = buildUpstreamUrl(modelCompany, account, endpoint, parsedUrl.search);
    let outgoingBody: string | Uint8Array | undefined;
    try {
      if (clientProtocol !== targetProtocol && requestParseError) throw requestParseError;
      outgoingBody = clientProtocol === targetProtocol
        ? rawRequestBody(request)
        : JSON.stringify(translateRequestBody(clientProtocol, targetProtocol, parsedBody));
    } catch (error) {
      if (error instanceof ProtocolError) {
        unsupportedError = error;
        continue;
      }
      throw error;
    }

    const attemptAbort = new AbortController();
    const remaining = Math.max(1, deadlineAt - Date.now());
    const headerTimeout = setTimeout(
      () => attemptAbort.abort(new Error("Upstream response-header timeout")),
      Math.min(env.upstreamHeaderTimeoutMs, remaining)
    );

    try {
      hadUpstreamAttempt = true;
      const upstream = await fetch(upstreamUrl, {
        method: request.method,
        headers: endpointHeaders(targetProtocol, endpointProvider, apiKey, account, request),
        body: outgoingBody,
        signal: AbortSignal.any([attemptAbort.signal, clientAbort.signal, AbortSignal.timeout(remaining)])
      });
      clearTimeout(headerTimeout);
      const latencyMs = Date.now() - started;

      if (!upstream.ok && shouldRetryStatus(currentGateway, upstream.status)) {
        const errorText = await upstream.text();
        lastError = statusMessage(upstream.status, errorText);
        const cooldownUntil = new Date(Date.now() + retryAfterMs(upstream, currentGateway.failover.cooldownSeconds)).toISOString();
        currentGateway = recordAttempt(currentGateway, account.id, {
          status: upstream.status === 402 ? "exhausted" : upstream.status === 401 || upstream.status === 403 ? "invalid" : "cooldown",
          lastError,
          cooldownUntil,
          latencyMs,
          lastUsedAt: new Date().toISOString()
        });
        continue;
      }

      const isStreaming = upstream.headers.get("content-type")?.includes("text/event-stream") || record(parsedBody).stream === true;
      if (isStreaming && upstream.body) {
        currentGateway = recordAttempt(currentGateway, account.id, {
          status: upstream.ok ? "active" : account.status,
          lastError: upstream.ok ? undefined : `Upstream returned HTTP ${upstream.status}`,
          latencyMs,
          lastUsedAt: new Date().toISOString()
        }, 0, upstream.ok);
        return sendStreamingResponse(request, reply, upstream, targetProtocol, clientProtocol);
      }

      const bytes = Buffer.from(await upstream.arrayBuffer());
      const responseText = bytes.toString("utf8");
      let parsedResponse: unknown;
      try { parsedResponse = responseText ? JSON.parse(responseText) : {}; }
      catch { parsedResponse = responseText; }
      const spendCents = upstream.ok ? estimateSpendCents(endpointProvider, parsedResponse) : 0;
      currentGateway = recordAttempt(currentGateway, account.id, {
        status: upstream.ok ? "active" : account.status,
        lastError: upstream.ok ? undefined : statusMessage(upstream.status, responseText),
        latencyMs,
        lastUsedAt: new Date().toISOString()
      }, spendCents, upstream.ok);

      applyResponseHeaders(reply, upstream);
      reply.code(upstream.status);
      if (clientProtocol === targetProtocol) return reply.send(bytes);
      const translated = upstream.ok
        ? translateJsonResponse(targetProtocol, clientProtocol, parsedResponse)
        : translateErrorResponse(targetProtocol, clientProtocol, upstream.status, parsedResponse);
      return reply.send(translated);
    } catch (error) {
      clearTimeout(headerTimeout);
      if (clientAbort.signal.aborted) return reply;
      lastError = error instanceof Error ? error.message : "Network error";
      if (!currentGateway.failover.switchOnNetworkError || Date.now() >= deadlineAt) break;
      const cooldownUntil = new Date(Date.now() + currentGateway.failover.cooldownSeconds * 1000).toISOString();
      currentGateway = recordAttempt(currentGateway, account.id, {
        status: "cooldown",
        lastError,
        cooldownUntil,
        lastUsedAt: new Date().toISOString()
      });
    }
  }

  if (unsupportedError && !hadUpstreamAttempt) {
    return reply.code(400).send(protocolErrorBody(clientProtocol, unsupportedError.message, unsupportedError.code));
  }
  return reply.code(503).send(unavailableBody(
    clientProtocol,
    `No healthy endpoint account is available. Last error: ${lastError}`
  ));
}
