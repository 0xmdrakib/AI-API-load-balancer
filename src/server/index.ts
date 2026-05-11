import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import { nanoid } from "nanoid";
import { z } from "zod";
import { env, rootDir } from "./config.js";
import { createOwnerApiKey, encryptSecret, hashSecret, previewSecret } from "./crypto.js";
import { balanceSnapshots, refreshLiveBalances } from "./balance.js";
import { buildGatewayDiagnostics } from "./diagnostics.js";
import { deleteGateway, findGatewayByOwnerHash, getGateway, listGateways, toPublicGateway, updateGateway, upsertGateway } from "./store.js";
import { proxyUniversalV1 } from "./proxy.js";
import { defaultFailover, endpointProviders, getModelCompany, modelCompanies, policies, providers } from "../shared/providers.js";
import type { FailoverOptions, GatewayCreateInput, GatewayStored, LoadBalancingStrategy } from "../shared/types.js";

const app = Fastify({
  logger: true,
  bodyLimit: 25 * 1024 * 1024
});

app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
  done(null, body);
});

const failoverSchema = z.object({
  switchOnLowBalance: z.boolean().default(defaultFailover.switchOnLowBalance),
  lowBalanceCents: z.coerce.number().int().min(0).default(defaultFailover.lowBalanceCents),
  switchOnRateLimit: z.boolean().default(defaultFailover.switchOnRateLimit),
  switchOnServerError: z.boolean().default(defaultFailover.switchOnServerError),
  switchOnNetworkError: z.boolean().default(defaultFailover.switchOnNetworkError),
  switchOnAuthError: z.boolean().default(defaultFailover.switchOnAuthError),
  cooldownSeconds: z.coerce.number().int().min(0).max(3600).default(defaultFailover.cooldownSeconds),
  maxRetries: z.coerce.number().int().min(0).max(10).default(defaultFailover.maxRetries)
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
  customHeaders: z.record(z.string()).optional()
});

const gatewayCreateSchema = z.object({
  name: z.string().trim().min(1),
  modelCompanyId: z.string().trim().min(1).optional(),
  providerId: z.string().trim().min(1).optional(),
  strategy: strategySchema,
  failover: failoverSchema,
  accounts: z.array(accountCreateSchema).min(1).max(50)
}).transform((input) => ({
  ...input,
  modelCompanyId: input.modelCompanyId ?? input.providerId ?? ""
}));

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
  customHeaders: z.record(z.string()).optional()
});

const ownerKeyCheckSchema = z.object({
  ownerApiKey: z.string().trim().min(1)
});

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
    accounts: input.accounts.map((account, index) => ({
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
      customHeaders: account.customHeaders
    }))
  };

  return { gateway, ownerApiKey };
}

async function authenticateOwner(authorization?: string) {
  const token = authorization?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return undefined;
  return findGatewayByOwnerHash(hashSecret(token));
}

await app.register(cors, {
  origin: true
});

await app.register(rateLimit, {
  max: 240,
  timeWindow: "1 minute"
});

const builtClientDir = path.join(rootDir, "dist-web");
const hasBuiltClient = await fs
  .access(path.join(builtClientDir, "index.html"))
  .then(() => true)
  .catch(() => false);

if (hasBuiltClient) {
  await app.register(staticPlugin, {
    root: builtClientDir,
    prefix: "/"
  });
}

app.get("/health", async () => ({
  ok: true,
  name: "AI Key Gateway",
  time: new Date().toISOString()
}));

app.get("/api/providers", async () => ({
  providers,
  modelCompanies,
  endpointProviders,
  policies,
  defaultFailover
}));

app.get("/api/gateways", async () => ({
  gateways: await listGateways()
}));

app.post("/api/owner-key/check", async (request) => {
  const input = ownerKeyCheckSchema.parse(request.body);
  const gateway = await findGatewayByOwnerHash(hashSecret(input.ownerApiKey));
  const checkedAt = new Date().toISOString();
  if (!gateway) {
    return {
      valid: false,
      checkedAt,
      message: "Owner API key is not valid for any local gateway."
    };
  }

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

  return reply.code(201).send({
    gateway: toPublicGateway(gateway),
    ownerApiKey,
    baseUrl: `${env.publicBaseUrl}/v1`
  });
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
    failover: {
      ...stored.failover,
      ...input.failover
    }
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
  const gateway = await updateGateway(request.params.id, (stored) => ({
    ...stored,
    accounts: [
      ...stored.accounts,
      {
        id: nanoid(),
        label: input.label,
        encryptedApiKey: encryptSecret(input.apiKey),
        apiKeyPreview: previewSecret(input.apiKey),
        baseUrl: input.baseUrl || undefined,
        status: "active",
        estimatedBalanceCents: input.estimatedBalanceCents,
        balanceFloorCents: input.balanceFloorCents,
        spentCents: 0,
        weight: input.weight,
        priority: input.priority,
        requestCount: 0,
        customHeaders: input.customHeaders
      }
    ]
  }));

  if (!gateway) return reply.code(404).send({ error: "Gateway not found" });
  return reply.code(201).send({ gateway: toPublicGateway(gateway) });
});

app.patch<{ Params: { id: string; accountId: string } }>("/api/gateways/:id/accounts/:accountId", async (request, reply) => {
  const input = accountPatchSchema.parse(request.body);
  const gateway = await updateGateway(request.params.id, (stored) => ({
    ...stored,
    accounts: stored.accounts.map((account) =>
      account.id === request.params.accountId
        ? {
            ...account,
            ...input,
            baseUrl: input.baseUrl === "" ? undefined : input.baseUrl ?? account.baseUrl
          }
        : account
    )
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
  return {
    gateway: toPublicGateway(gateway),
    ownerApiKey,
    baseUrl: `${env.publicBaseUrl}/v1`
  };
});

app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>("/api/gateways/:id/balances", async (request, reply) => {
  const gateway = await getGateway(request.params.id);
  if (!gateway) return reply.code(404).send({ error: "Gateway not found" });
  const modelCompany = requireModelCompany(gatewayModelCompanyId(gateway));
  const refreshedGateway = await refreshLiveBalances(gateway, modelCompany, {
    force: request.query.refresh === "1" || request.query.refresh === "true"
  });
  return {
    modelCompany,
    balances: balanceSnapshots(refreshedGateway, modelCompany)
  };
});

app.post<{ Params: { id: string } }>("/api/gateways/:id/diagnostics", async (request, reply) => {
  const gateway = await getGateway(request.params.id);
  if (!gateway) return reply.code(404).send({ error: "Gateway not found" });
  const modelCompany = requireModelCompany(gatewayModelCompanyId(gateway));
  const { diagnostics } = await buildGatewayDiagnostics(gateway, modelCompany, { forceBalance: true });
  return { diagnostics };
});

app.all("/v1/*", async (request, reply) => {
  const gateway = await authenticateOwner(request.headers.authorization);
  if (!gateway) {
    return reply.code(401).send({
      error: {
        message: "Invalid or missing owner API key.",
        type: "authentication_error",
        code: "invalid_api_key"
      }
    });
  }

  const modelCompany = requireModelCompany(gatewayModelCompanyId(gateway));
  return proxyUniversalV1(gateway, modelCompany, request, reply);
});

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof z.ZodError) {
    return reply.code(400).send({
      error: {
        message: "Validation failed",
        type: "invalid_request_error",
        details: error.flatten()
      }
    });
  }

  const caught = error as Error & { statusCode?: number };
  const statusCode = caught.statusCode ?? 500;
  app.log.error(caught);
  return reply.code(statusCode).send({
    error: {
      message: caught.message,
      type: statusCode >= 500 ? "server_error" : "invalid_request_error"
    }
  });
});

app.setNotFoundHandler((request, reply) => {
  if (
    hasBuiltClient &&
    request.method === "GET" &&
    !request.url.startsWith("/api") &&
    !request.url.startsWith("/v1")
  ) {
    return reply.sendFile("index.html");
  }

  return reply.code(404).send({
    error: {
      message: "Route not found",
      type: "not_found"
    }
  });
});

export async function startGatewayServer(options?: { host?: string; port?: number }) {
  if (app.server.listening) return app;
  await app.listen({
    host: options?.host ?? env.host,
    port: options?.port ?? env.port
  });
  return app;
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  startGatewayServer().catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}
