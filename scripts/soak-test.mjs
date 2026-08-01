import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";

const durationMs = Number(process.env.SOAK_DURATION_MS || 600_000);
const batchIntervalMs = Number(process.env.SOAK_BATCH_INTERVAL_MS || 5_000);
const concurrency = 100;
const dataPath = path.resolve(".soak-data");
const uncaught = [];

process.on("uncaughtExceptionMonitor", (error) => uncaught.push(error.stack || error.message));
process.on("unhandledRejection", (error) => uncaught.push(error instanceof Error ? error.stack || error.message : String(error)));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

await fs.rm(dataPath, { recursive: true, force: true });
await fs.mkdir(dataPath, { recursive: true });
process.env.GATEWAY_DATA_DIR = dataPath;
process.env.GATEWAY_SECRET = randomBytes(48).toString("base64url");
process.env.NODE_ENV = "test";

let upstreamRequests = 0;
const upstream = http.createServer(async (request, response) => {
  for await (const _chunk of request) {
    // Consume each body so keep-alive connections remain reusable.
  }
  upstreamRequests += 1;
  response.writeHead(200, { "content-type": "application/json", "x-request-id": `soak-${upstreamRequests}` });
  response.end(JSON.stringify({
    id: `chatcmpl_soak_${upstreamRequests}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "soak-model",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }));
});

let app;
let summary;
try {
  const upstreamPort = await listen(upstream);
  const upstreamRoot = `http://127.0.0.1:${upstreamPort}/v1`;
  const { createGatewayApp } = await import("../dist/server/index.js");
  app = await createGatewayApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  const gatewayRoot = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const accounts = Array.from({ length: 50 }, (_, index) => ({
    label: `Soak key ${index + 1}`,
    apiKey: `soak-upstream-key-${index + 1}`,
    baseUrl: upstreamRoot,
    upstreamProtocol: "openai",
    weight: 1,
    priority: index + 1
  }));
  const created = await fetch(`${gatewayRoot}/api/gateways`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Ten-minute soak",
      modelCompanyId: "openai",
      strategy: "round-robin",
      failover: {
        switchOnLowBalance: true,
        lowBalanceCents: 0,
        switchOnRateLimit: true,
        switchOnServerError: true,
        switchOnNetworkError: true,
        switchOnAuthError: true,
        cooldownSeconds: 1,
        maxRetries: 49
      },
      accounts
    })
  });
  if (created.status !== 201) throw new Error(`Could not create the 50-account soak gateway (HTTP ${created.status}).`);
  const gateway = await created.json();
  const startedAt = Date.now();
  const deadline = startedAt + durationMs;
  let batches = 0;
  let requests = 0;
  let invalidResponses = 0;
  let peakRssBytes = process.memoryUsage().rss;

  while (Date.now() < deadline) {
    const health = await fetch(`${gatewayRoot}/health`);
    if (!health.ok) throw new Error(`Backend health failed during batch ${batches + 1}.`);
    const responses = await Promise.all(Array.from({ length: concurrency }, (_, index) => fetch(`${gatewayRoot}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${gateway.ownerApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "soak-model", messages: [{ role: "user", content: `Batch ${batches + 1}, request ${index + 1}` }] })
    })));
    const payloads = await Promise.all(responses.map(async (response) => ({ status: response.status, body: await response.json() })));
    invalidResponses += payloads.filter(({ status, body }) => status !== 200 || body?.object !== "chat.completion" || body?.choices?.[0]?.message?.content !== "ok").length;
    requests += concurrency;
    batches += 1;
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(batchIntervalMs, remaining)));
  }

  await app.close();
  app = undefined;
  const stored = JSON.parse(await fs.readFile(path.join(dataPath, "gateway.json"), "utf8"));
  const storedAccounts = stored.gateways?.[0]?.accounts?.length;
  summary = {
    durationMs: Date.now() - startedAt,
    concurrency,
    batches,
    requests,
    upstreamRequests,
    invalidResponses,
    uncaughtExceptions: uncaught.length,
    storeVersion: stored.version,
    storedAccounts,
    peakRssMiB: Number((peakRssBytes / 1024 / 1024).toFixed(1))
  };
  if (invalidResponses || uncaught.length || stored.version !== 2 || storedAccounts !== 50 || upstreamRequests !== requests) {
    throw new Error(`Soak acceptance failed: ${JSON.stringify(summary)}`);
  }
  console.log(JSON.stringify(summary, null, 2));
} finally {
  if (app) await app.close().catch(() => undefined);
  if (upstream.listening) await closeServer(upstream).catch(() => undefined);
  await fs.rm(dataPath, { recursive: true, force: true });
}
