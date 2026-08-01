import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import { nanoid } from "nanoid";
import { z } from "zod";
import { env, rootDir } from "./config.js";
import { createOwnerApiKey, encryptSecret, hashSecret, previewSecret } from "./crypto.js";
import { balanceSnapshots, refreshLiveBalances } from "./balance.js";
import { buildGatewayDiagnostics } from "./diagnostics.js";
import {
  deleteGateway,
  findGatewayByOwnerHash,
  flushStore,
  getGateway,
  listGateways,
  readStore,
  toPublicGateway,
  updateGateway,
  upsertGateway
} from "./store.js";
import { proxyUniversalV1 } from "./proxy.js";
import {
  defaultFailover,
  detectEndpointProvider,
  endpointProviders,
  getModelCompany,
  modelCompanies,
  policies,
  providers
} from "../shared/providers.js";
import type { FailoverOptions, GatewayCreateInput, GatewayStored, LoadBalancingStrategy } from "../shared/types.js";
import {
  APP_VERSION,
  LAST_PREFERRED_DESKTOP_PORT,
  MAX_ACCOUNTS_PER_GATEWAY,
  MAX_FAILOVER_RETRIES,
  PREFERRED_DESKTOP_PORT,
  type ClientProtocol
} from "../shared/constants.js";
import { getBaseUrls, getRuntimeMetadata, setBoundPort } from "./runtime.js";

const failoverSchema = z.object({
  switchOnLowBalance: z.boolean().default(defaultFailover.switchOnLowBalance),
  lowBalanceCents: z.coerce.number().int().min(0).default(defaultFailover.lowBalanceCents),
  switchOnRateLimit: z.boolean().default(defaultFailover.switchOnRateLimit),
  switchOnServerError: z.boolean().default(defaultFailover.switchOnServerError),
  switchOnNetworkError: z.boolean().default(defaultFailover.switchOnNetworkError),
  switchOnAuthError: z.boolean().default(defaultFailover.switchOnAuthError),
  cooldownSeconds: z.coerce.number().int().min(0).max(3600).default(defaultFailover.cooldownSeconds),
  maxRetries: z.coerce.number().int().min(0).max(MAX_FAILOVER_RETRIES).default(defaultFailover.maxRetries)
});

const strategySchema = z.enum(["priority-failover", "round-robin", "weighted", "least-used"]) satisfies z.ZodType<LoadBalancingStrategy>;

const accountCreateSchema = z.object({
  label: z.string().trim().min(1),
  apiKey: z.string().trim().min(1),
  baseUrl: z.string().trim().url().optional().or(z.literal("")),
  estimatedBalanceCents: z.coerce.number().int().min(0).optional(),
  balanceFloorCents: z.coerce.number().int().min(0).optional(),
  weight: z.coerce.number().int().min(1).max(100).default(1),
  priority: z.coerce.number().int().min(1).max(100).default(1),
  upstreamProtocol: z.enum(["openai", "anthropic"]).optional(),
  customHeaders: z.record(z.string()).optional()
});

const gatewayCreateSchema = z.object({
  name: z.string().trim().min(1),
  modelCompanyId: z.string().trim().min(1).optional(),
  providerId: z.string().trim().min(1).optional(),
  strategy: strategySchema,
  failover: failoverSchema,
  accounts: z.array(accountCreateSchema).min(1).max(MAX_ACCOUNTS_PER_GATEWAY)
}).transform((input) => ({ ...input, modelCompanyId: input.modelCompanyId ?? input.providerId ?? "" }));

const gatewayPatchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  strategy: strategySchema.optional(),
  failover: failoverSchema.partial().optional()
});

const accountPatchSchema = z.object({
  label: z.string().trim().min(1).optional(),
  status: z.enum(["active", "paused", "cooldown", "exhausted", "invalid"]).optional(),
  baseUrl: z.string().trim().url().optional().or(z.literal("")),
  estimatedBalanceCents: z.coerce.number().int().min(0).optional(),
  balanceFloorCents: z.coerce.number().int().min(0).optional(),
  weight: z.coerce.number().int().min(1).max(100).optional(),
  priority: z.coerce.number().int().min(1).max(100).optional(),
  upstreamProtocol: z.enum(["openai", "anthropic"]).optional(),
  customHeaders: z.record(z.string()).optional()
});

const ownerKeyCheckSchema = z.object({ ownerApiKey: z.string().trim().min(1) });

class AccountLimitError extends Error {
  statusCode = 409;
  code = "account_limit_reached";
}

function gatewayModelCompanyId(gateway: Pick<GatewayStored, "modelCompanyId" | "providerId">) {
  return gateway.modelCompanyId ?? gateway.providerId ?? "openai";
}

function requireModelCompany(modelCompanyId: string) {
  const modelCompany = getModelCompany(modelCompanyId);
  if (!modelCompany) {
    const error = new Error(`Unsupported model company: ${modelCompanyId}`);
    Object.assign(error, { statusCode: 400 });
    throw error;
  }
  return modelCompany;
}

function upstreamProtocol(modelCompanyId: string, baseUrl?: string): ClientProtocol {
  const company = requireModelCompany(modelCompanyId);
  const endpoint = detectEndpointProvider(baseUrl || company.defaultBaseUrl, company.defaultEndpointProviderId);
  return endpoint.compatibility === "native-adapter" ? "anthropic" : "openai";
}

function newStoredAccount(
  modelCompanyId: string,
  account: GatewayCreateInput["accounts"][number],
  index: number
): GatewayStored["accounts"][number] {
  return {
    id: nanoid(),
    label: account.label,
    encryptedApiKey: encryptSecret(account.apiKey),
    apiKeyPreview: previewSecret(account.apiKey),
    baseUrl: account.baseUrl || undefined,
    status: "active",
    estimatedBalanceCents: account.estimatedBalanceCents,
    balanceFloorCents: account.balanceFloorCents,
    spentCents: 0,
    weight: account.weight ?? 1,
    priority: account.priority ?? index + 1,
    requestCount: 0,
    consecutiveFailures: 0,
    upstreamProtocol: account.upstreamProtocol ?? upstreamProtocol(modelCompanyId, account.baseUrl || undefined),
    customHeaders: account.customHeaders
  };
}

function buildGateway(input: GatewayCreateInput) {
  const ownerApiKey = createOwnerApiKey();
  const now = new Date().toISOString();
  const gateway: GatewayStored = {
    id: nanoid(),
    name: input.name,
    modelCompanyId: input.modelCompanyId,
    providerId: input.modelCompanyId,
    ownerKeyHash: hashSecret(ownerApiKey),
    ownerKeyPreview: previewSecret(ownerApiKey),
    strategy: input.strategy,
    failover: input.failover,
    lastRoundRobinIndex: -1,
    createdAt: now,
    updatedAt: now,
    accounts: input.accounts.map((account, index) => newStoredAccount(input.modelCompanyId, account, index))
  };
  return { gateway, ownerApiKey };
}

function ownerTokens(request: { headers: Record<string, unknown> }) {
  const authorization = typeof request.headers.authorization === "string"
    ? request.headers.authorization.replace(/^Bearer\s+/i, "").trim()
    : "";
  const xApiKey = typeof request.headers["x-api-key"] === "string" ? request.headers["x-api-key"].trim() : "";
  return { authorization, xApiKey };
}

async function authenticateOwner(request: { headers: Record<string, unknown> }) {
  const { authorization, xApiKey } = ownerTokens(request);
  if (authorization && xApiKey && authorization !== xApiKey) return { conflict: true as const };
  const token = authorization || xApiKey;
  if (!token) return {};
  return { gateway: await findGatewayByOwnerHash(hashSecret(token)) };
}

function authenticationError(protocol: ClientProtocol, conflict: boolean) {
  const message = conflict
    ? "Bearer authorization and x-api-key contain different owner keys. Send only one owner key."
    : "Invalid or missing owner API key.";
  return protocol === "anthropic"
    ? { type: "error", error: { type: "authentication_error", message } }
    : { error: { message, type: "authentication_error", code: "invalid_api_key" } };
}

function isAllowedOrigin(origin?: string) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

export async function createGatewayApp() {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test", bodyLimit: 25 * 1024 * 1024 });
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  await app.register(cors, {
    origin(origin, callback) {
      callback(null, isAllowedOrigin(origin));
    }
  });
  await app.register(rateLimit, {
    max: 240,
    timeWindow: "1 minute",
    allowList: (request) => !request.url.startsWith("/api/")
  });

  const builtClientDir = path.join(rootDir, "dist-web");
  const hasBuiltClient = await fs.access(path.join(builtClientDir, "index.html")).then(() => true).catch(() => false);
  if (hasBuiltClient) await app.register(staticPlugin, { root: builtClientDir, prefix: "/" });

  app.get("/health", async () => {
    await readStore();
    const runtime = getRuntimeMetadata();
    return { ok: true, ready: true, name: "AI Load Balancer", version: APP_VERSION, store: runtime.store };
  });
  app.get("/runtime", async () => {
    await readStore();
    return getRuntimeMetadata();
  });
  app.get("/api/runtime", async () => {
    await readStore();
    return getRuntimeMetadata();
  });

  app.get("/api/providers", async () => ({
    providers,
    modelCompanies,
    endpointProviders,
    policies,
    defaultFailover,
    limits: { accountsPerGateway: MAX_ACCOUNTS_PER_GATEWAY, maxRetries: MAX_FAILOVER_RETRIES }
  }));
  app.get("/api/gateways", async () => ({ gateways: await listGateways() }));

  app.post("/api/owner-key/check", async (request) => {
    const input = ownerKeyCheckSchema.parse(request.body);
    const gateway = await findGatewayByOwnerHash(hashSecret(input.ownerApiKey));
    const checkedAt = new Date().toISOString();
    if (!gateway) return { valid: false, checkedAt, message: "Owner API key is not valid for any local gateway." };
    return {
      valid: true,
      checkedAt,
      gateway: {
        id: gateway.id,
        name: gateway.name,
        ownerKeyPreview: gateway.ownerKeyPreview,
        modelCompanyId: gatewayModelCompanyId(gateway),
        accountCount: gateway.accounts.length
      },
      message: `Owner API key is valid for ${gateway.name}.`
    };
  });

  app.post("/api/gateways", async (request, reply) => {
    const input = gatewayCreateSchema.parse(request.body);
    requireModelCompany(input.modelCompanyId);
    const { gateway, ownerApiKey } = buildGateway(input);
    await upsertGateway(gateway);
    const baseUrls = getBaseUrls();
    return reply.code(201).send({ gateway: toPublicGateway(gateway), ownerApiKey, baseUrl: baseUrls.openai, baseUrls });
  });

  app.get<{ Params: { id: string } }>("/api/gateways/:id", async (request, reply) => {
    const gateway = await getGateway(request.params.id);
    if (!gateway) return reply.code(404).send({ error: "Gateway not found" });
    return { gateway: toPublicGateway(gateway) };
  });

  app.patch<{ Params: { id: string } }>("/api/gateways/:id", async (request, reply) => {
    const input = gatewayPatchSchema.parse(request.body);
    const gateway = await updateGateway(request.params.id, (stored) => ({
      ...stored,
      name: input.name ?? stored.name,
      strategy: input.strategy ?? stored.strategy,
      failover: { ...stored.failover, ...input.failover }
    }));
    if (!gateway) return reply.code(404).send({ error: "Gateway not found" });
    return { gateway: toPublicGateway(gateway) };
  });

  app.delete<{ Params: { id: string } }>("/api/gateways/:id", async (request, reply) => {
    const deleted = await deleteGateway(request.params.id);
    if (!deleted) return reply.code(404).send({ error: "Gateway not found" });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/gateways/:id/accounts", async (request, reply) => {
    const input = accountCreateSchema.parse(request.body);
    const existing = await getGateway(request.params.id);
    if (!existing) return reply.code(404).send({ error: "Gateway not found" });
    if (existing.accounts.length >= MAX_ACCOUNTS_PER_GATEWAY) throw new AccountLimitError("This gateway already has 50 provider keys.");
    const gateway = await updateGateway(request.params.id, (stored) => {
      if (stored.accounts.length >= MAX_ACCOUNTS_PER_GATEWAY) throw new AccountLimitError("This gateway already has 50 provider keys.");
      return {
        ...stored,
        accounts: [...stored.accounts, newStoredAccount(gatewayModelCompanyId(stored), input, stored.accounts.length)]
      };
    });
    return reply.code(201).send({ gateway: toPublicGateway(gateway!) });
  });

  app.patch<{ Params: { id: string; accountId: string } }>("/api/gateways/:id/accounts/:accountId", async (request, reply) => {
    const input = accountPatchSchema.parse(request.body);
    const gateway = await updateGateway(request.params.id, (stored) => ({
      ...stored,
      accounts: stored.accounts.map((account) => {
        if (account.id !== request.params.accountId) return account;
        const baseUrl = input.baseUrl === "" ? undefined : input.baseUrl ?? account.baseUrl;
        return {
          ...account,
          ...input,
          baseUrl,
          upstreamProtocol: input.upstreamProtocol ?? upstreamProtocol(gatewayModelCompanyId(stored), baseUrl)
        };
      })
    }));
    if (!gateway) return reply.code(404).send({ error: "Gateway not found" });
    return { gateway: toPublicGateway(gateway) };
  });

  app.delete<{ Params: { id: string; accountId: string } }>("/api/gateways/:id/accounts/:accountId", async (request, reply) => {
    const gateway = await updateGateway(request.params.id, (stored) => ({
      ...stored,
      accounts: stored.accounts.filter((account) => account.id !== request.params.accountId)
    }));
    if (!gateway) return reply.code(404).send({ error: "Gateway not found" });
    return { gateway: toPublicGateway(gateway) };
  });

  app.post<{ Params: { id: string } }>("/api/gateways/:id/rotate-owner-key", async (request, reply) => {
    const ownerApiKey = createOwnerApiKey();
    const gateway = await updateGateway(request.params.id, (stored) => ({
      ...stored,
      ownerKeyHash: hashSecret(ownerApiKey),
      ownerKeyPreview: previewSecret(ownerApiKey)
    }));
    if (!gateway) return reply.code(404).send({ error: "Gateway not found" });
    const baseUrls = getBaseUrls();
    return { gateway: toPublicGateway(gateway), ownerApiKey, baseUrl: baseUrls.openai, baseUrls };
  });

  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>("/api/gateways/:id/balances", async (request, reply) => {
    const gateway = await getGateway(request.params.id);
    if (!gateway) return reply.code(404).send({ error: "Gateway not found" });
    const modelCompany = requireModelCompany(gatewayModelCompanyId(gateway));
    const refreshedGateway = await refreshLiveBalances(gateway, modelCompany, { force: request.query.refresh === "1" || request.query.refresh === "true" });
    return { modelCompany, balances: balanceSnapshots(refreshedGateway, modelCompany) };
  });

  app.post<{ Params: { id: string } }>("/api/gateways/:id/diagnostics", async (request, reply) => {
    const gateway = await getGateway(request.params.id);
    if (!gateway) return reply.code(404).send({ error: "Gateway not found" });
    const modelCompany = requireModelCompany(gatewayModelCompanyId(gateway));
    const { diagnostics } = await buildGatewayDiagnostics(gateway, modelCompany, { forceBalance: true });
    return { diagnostics };
  });

  app.all("/v1/*", async (request, reply) => {
    const authentication = await authenticateOwner(request as unknown as { headers: Record<string, unknown> });
    const anthropicClient = Boolean(request.headers["x-api-key"]);
    if (!authentication.gateway) return reply.code(401).send(authenticationError(anthropicClient ? "anthropic" : "openai", Boolean(authentication.conflict)));
    const modelCompany = requireModelCompany(gatewayModelCompanyId(authentication.gateway));
    return proxyUniversalV1(authentication.gateway, modelCompany, request, reply);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: { message: "Validation failed", type: "invalid_request_error", details: error.flatten() }
      });
    }
    const caught = error as Error & { statusCode?: number; code?: string };
    const statusCode = caught.statusCode ?? 500;
    request.log.error(caught);
    return reply.code(statusCode).send({
      error: {
        message: caught.message,
        type: statusCode >= 500 ? "server_error" : "invalid_request_error",
        ...(caught.code ? { code: caught.code } : {})
      }
    });
  });

  app.setNotFoundHandler((request, reply) => {
    if (hasBuiltClient && request.method === "GET" && !request.url.startsWith("/api") && !request.url.startsWith("/v1") && request.url !== "/runtime") {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: { message: "Route not found", type: "not_found" } });
  });
  app.addHook("onClose", async () => flushStore());
  return app;
}

async function canBind(host: string, port: number) {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export async function chooseGatewayPort(host = env.host) {
  if (env.portWasExplicit) return env.port;
  for (let port = PREFERRED_DESKTOP_PORT; port <= LAST_PREFERRED_DESKTOP_PORT; port += 1) {
    if (await canBind(host, port)) return port;
  }
  return 0;
}

export async function startGatewayServer(options?: { host?: string; port?: number }) {
  const app = await createGatewayApp();
  const host = options?.host ?? env.host;
  const port = options?.port ?? await chooseGatewayPort(host);
  await app.listen({ host, port });
  const address = app.server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  setBoundPort(actualPort);
  app.log.info({ port: actualPort, baseUrls: getBaseUrls() }, "Gateway backend ready");
  return app;
}

function isMainModule() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry!).href;
}

if (isMainModule()) {
  let app: FastifyInstance | undefined;
  const shutdown = async () => {
    await app?.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  startGatewayServer().then((server) => { app = server; }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
