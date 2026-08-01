import { promises as fs } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createGatewayApp } from "../src/server/index.js";
import { translateSseStream } from "../src/server/protocol.js";

type CapturedRequest = {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
};

const captured: CapturedRequest[] = [];
let disconnectedUpstreams = 0;
const testDataPath = path.resolve(".vitest-data");
let upstream: http.Server;
let upstreamRoot = "";
let gatewayRoot = "";
let app: Awaited<ReturnType<typeof createGatewayApp>>;

async function jsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

function sendJson(response: ServerResponse, payload: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json", "x-request-id": "mock-request-id" });
  response.end(JSON.stringify(payload));
}

function sendOpenAiStream(response: ServerResponse) {
  response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "openai-stream-id" });
  const chunks = [
    { id: "chatcmpl_mock", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { id: "chatcmpl_mock", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] },
    { id: "chatcmpl_mock", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }
  ];
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function sendAnthropicStream(response: ServerResponse) {
  response.writeHead(200, { "content-type": "text/event-stream", "request-id": "anthropic-stream-id" });
  const events = [
    ["message_start", { type: "message_start", message: { id: "msg_mock", type: "message", role: "assistant", model: "mock-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 4, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }]
  ] as const;
  for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  response.end();
}

async function mockHandler(request: IncomingMessage, response: ServerResponse) {
  const body = await jsonBody(request);
  captured.push({ path: request.url ?? "", headers: request.headers, body });
  if (body.model === "force-failover" && String(request.headers.authorization ?? request.headers["x-api-key"]).includes("upstream-key-1")) {
    response.writeHead(429, { "content-type": "application/json", "retry-after": "1", "x-request-id": "rate-limited-key" });
    response.end(JSON.stringify({ error: { message: "Mock rate limit", type: "rate_limit_error" } }));
    return;
  }
  if (body.model === "slow-disconnect") {
    response.once("close", () => {
      if (!response.writableEnded) disconnectedUpstreams += 1;
    });
    setTimeout(() => {
      if (!response.destroyed) sendJson(response, {
        id: "chatcmpl_slow", object: "chat.completion", created: 1, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "late" }, finish_reason: "stop" }]
      });
    }, 5_000).unref();
    return;
  }
  if (request.url?.endsWith("/chat/completions")) {
    if (body.stream) return sendOpenAiStream(response);
    if (Array.isArray(body.tools) && body.tools.length) {
      return sendJson(response, {
        id: "chatcmpl_tool", object: "chat.completion", created: 1, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_weather", type: "function", function: { name: "weather", arguments: "{\"city\":\"Dhaka\"}" } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }
      });
    }
    return sendJson(response, {
      id: "chatcmpl_text", object: "chat.completion", created: 1, model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "mock-openai" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
    });
  }
  if (request.url?.endsWith("/messages")) {
    if (body.stream) return sendAnthropicStream(response);
    if (Array.isArray(body.tools) && body.tools.length) {
      return sendJson(response, {
        id: "msg_tool", type: "message", role: "assistant", model: body.model,
        content: [{ type: "tool_use", id: "toolu_weather", name: "weather", input: { city: "Dhaka" } }],
        stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 8, output_tokens: 4 }
      });
    }
    return sendJson(response, {
      id: "msg_text", type: "message", role: "assistant", model: body.model,
      content: [{ type: "text", text: "mock-anthropic" }],
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 4, output_tokens: 2 }
    });
  }
  if (request.url?.endsWith("/models")) {
    return sendJson(response, { object: "list", data: [{ id: "mock-model", object: "model", created: 1, owned_by: "mock" }] });
  }
  return sendJson(response, { error: { message: "not found" } }, 404);
}

function listen(server: http.Server) {
  return new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

async function translatedSse(source: "openai" | "anthropic", target: "openai" | "anthropic", input: string) {
  const stream = new Response(input).body!;
  let output = "";
  for await (const chunk of translateSseStream(source, target, stream)) output += chunk;
  return output;
}

async function createGateway(protocol: "openai" | "anthropic", accountCount = 1) {
  const accounts = Array.from({ length: accountCount }, (_, index) => ({
    label: `Mock ${index + 1}`,
    apiKey: `upstream-key-${index + 1}`,
    baseUrl: `${upstreamRoot}/v1`,
    upstreamProtocol: protocol,
    weight: 1,
    priority: index + 1
  }));
  const response = await fetch(`${gatewayRoot}/api/gateways`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `${protocol}-${Date.now()}-${Math.random()}`,
      modelCompanyId: protocol,
      strategy: "priority-failover",
      failover: {
        switchOnLowBalance: true,
        lowBalanceCents: 0,
        switchOnRateLimit: true,
        switchOnServerError: true,
        switchOnNetworkError: true,
        switchOnAuthError: true,
        cooldownSeconds: 1,
        maxRetries: Math.min(49, accountCount - 1)
      },
      accounts
    })
  });
  const result = await response.json() as { gateway: { id: string }; ownerApiKey: string; baseUrls: { openai: string; anthropic: string } };
  return { response, ...result };
}

beforeAll(async () => {
  await fs.rm(testDataPath, { recursive: true, force: true });
  await fs.mkdir(testDataPath, { recursive: true });
  await fs.writeFile(path.join(testDataPath, "gateway.json"), JSON.stringify({ version: 1, gateways: [] }), "utf8");
  upstream = http.createServer((request, response) => void mockHandler(request, response));
  upstreamRoot = `http://127.0.0.1:${await listen(upstream)}`;
  app = await createGatewayApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  gatewayRoot = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
});

describe("official SDK dual-protocol routing", () => {
  test("legacy v1 data is preserved before the v2 store starts", async () => {
    const health = await (await fetch(`${gatewayRoot}/health`)).json() as { store: { state: string; message: string } };
    expect(health.store.state).toBe("reset");
    expect(health.store.message).toContain("legacy store was preserved");
    const files = await fs.readdir(testDataPath);
    expect(files.some((file) => /^gateway\.v1\..+\.backup\.json$/.test(file))).toBe(true);
  });

  test.each([
    ["openai", "openai"],
    ["openai", "anthropic"],
    ["anthropic", "anthropic"],
    ["anthropic", "openai"]
  ] as const)("%s client routes through %s upstream", async (clientProtocol, upstreamProtocol) => {
    const gateway = await createGateway(upstreamProtocol);
    expect(gateway.response.status).toBe(201);
    if (clientProtocol === "openai") {
      const client = new OpenAI({ apiKey: gateway.ownerApiKey, baseURL: `${gatewayRoot}/v1` });
      const result = await client.chat.completions.create({ model: "mock-model", messages: [{ role: "user", content: "Hello" }] });
      expect(result.choices[0].message.content).toBe(upstreamProtocol === "openai" ? "mock-openai" : "mock-anthropic");
    } else {
      const client = new Anthropic({ apiKey: gateway.ownerApiKey, baseURL: gatewayRoot });
      const result = await client.messages.create({ model: "mock-model", max_tokens: 128, messages: [{ role: "user", content: "Hello" }] });
      expect(result.content[0]).toMatchObject({ type: "text", text: upstreamProtocol === "anthropic" ? "mock-anthropic" : "mock-openai" });
    }
  });

  test("OpenAI vision and function tools translate to Anthropic", async () => {
    const gateway = await createGateway("anthropic");
    const client = new OpenAI({ apiKey: gateway.ownerApiKey, baseURL: `${gatewayRoot}/v1` });
    const result = await client.chat.completions.create({
      model: "mock-model",
      messages: [{ role: "user", content: [
        { type: "text", text: "Inspect" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }
      ] }],
      tools: [{ type: "function", function: { name: "weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }]
    });
    expect(result.choices[0].message.tool_calls?.[0].function.name).toBe("weather");
    const request = captured.at(-1)!;
    expect(request.path).toBe("/v1/messages");
    expect(request.headers["x-api-key"]).toBe("upstream-key-1");
    expect(request.body).toMatchObject({
      tools: [{ name: "weather", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: [{ type: "text" }, { type: "image", source: { type: "base64" } }] }]
    });
  });

  test("Anthropic function tools translate to OpenAI", async () => {
    const gateway = await createGateway("openai");
    const client = new Anthropic({ apiKey: gateway.ownerApiKey, baseURL: gatewayRoot });
    const result = await client.messages.create({
      model: "mock-model",
      max_tokens: 128,
      messages: [{ role: "user", content: "Weather?" }],
      tools: [{ name: "weather", description: "Weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }]
    });
    expect(result.content[0]).toMatchObject({ type: "tool_use", name: "weather" });
    const request = captured.at(-1)!;
    expect(request.path).toBe("/v1/chat/completions");
    expect(request.headers.authorization).toBe("Bearer upstream-key-1");
    expect(request.body).toMatchObject({ tools: [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }] });
  });

  test("OpenAI tool calls and results translate to Anthropic conversation blocks", async () => {
    const gateway = await createGateway("anthropic");
    const response = await fetch(`${gatewayRoot}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${gateway.ownerApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock-model",
        messages: [
          { role: "user", content: "Weather?" },
          { role: "assistant", content: null, tool_calls: [{ id: "call_weather", type: "function", function: { name: "weather", arguments: '{"city":"Dhaka"}' } }] },
          { role: "tool", tool_call_id: "call_weather", content: "Sunny" }
        ]
      })
    });
    expect(response.status).toBe(200);
    const request = captured.at(-1)!;
    expect(request.body).toMatchObject({
      messages: [
        { role: "user" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_weather", name: "weather", input: { city: "Dhaka" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_weather" }] }
      ]
    });
  });

  test("Anthropic tool calls and results translate to OpenAI conversation messages", async () => {
    const gateway = await createGateway("openai");
    const response = await fetch(`${gatewayRoot}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": gateway.ownerApiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock-model",
        max_tokens: 128,
        messages: [
          { role: "user", content: "Weather?" },
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_weather", name: "weather", input: { city: "Dhaka" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_weather", content: "Sunny" }] }
        ]
      })
    });
    expect(response.status).toBe(200);
    const request = captured.at(-1)!;
    expect(request.body).toMatchObject({
      messages: [
        { role: "user" },
        { role: "assistant", tool_calls: [{ id: "toolu_weather", type: "function", function: { name: "weather" } }] },
        { role: "tool", tool_call_id: "toolu_weather" }
      ]
    });
  });

  test("cross-protocol SSE remains valid for both official SDKs", async () => {
    const anthropicGateway = await createGateway("anthropic");
    const openAi = new OpenAI({ apiKey: anthropicGateway.ownerApiKey, baseURL: `${gatewayRoot}/v1` });
    const openAiStream = await openAi.chat.completions.create({ model: "mock-model", messages: [{ role: "user", content: "Stream" }], stream: true });
    let openAiText = "";
    for await (const chunk of openAiStream) openAiText += chunk.choices[0]?.delta.content ?? "";
    expect(openAiText).toBe("hello");

    const openAiGateway = await createGateway("openai");
    const anthropic = new Anthropic({ apiKey: openAiGateway.ownerApiKey, baseURL: gatewayRoot });
    const anthropicStream = anthropic.messages.stream({ model: "mock-model", max_tokens: 128, messages: [{ role: "user", content: "Stream" }] });
    const finalMessage = await anthropicStream.finalMessage();
    expect(finalMessage.content[0]).toMatchObject({ type: "text", text: "hello" });
    expect(finalMessage.usage.output_tokens).toBe(1);
  });

  test("Anthropic streaming errors stay visible to OpenAI clients", async () => {
    const output = await translatedSse(
      "anthropic",
      "openai",
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Try later"}}\n\n'
    );
    expect(output).toContain('"type":"overloaded_error"');
    expect(output).toContain('"message":"Try later"');
    expect(output).toContain("data: [DONE]");
  });

  test("OpenAI streaming errors become protocol-correct Anthropic events", async () => {
    const output = await translatedSse(
      "openai",
      "anthropic",
      'data: {"error":{"type":"server_error","message":"Try later"}}\n\n'
    );
    expect(output).toContain("event: error");
    expect(output).toContain('"type":"error"');
    expect(output).toContain('"type":"server_error"');
    expect(output).toContain('"message":"Try later"');
  });

  test("models list is protocol-correct with an Anthropic upstream", async () => {
    const gateway = await createGateway("anthropic");
    const client = new OpenAI({ apiKey: gateway.ownerApiKey, baseURL: `${gatewayRoot}/v1` });
    const models = await client.models.list();
    expect(models.data[0]).toMatchObject({ object: "model", id: "anthropic" });
  });

  test("Retry-After rate limits cool down one key and fail over to the next", async () => {
    const gateway = await createGateway("openai", 2);
    const client = new OpenAI({ apiKey: gateway.ownerApiKey, baseURL: `${gatewayRoot}/v1` });
    const result = await client.chat.completions.create({ model: "force-failover", messages: [{ role: "user", content: "Hello" }] });
    expect(result.choices[0].message.content).toBe("mock-openai");
    const attempts = captured.filter((request) => request.body.model === "force-failover");
    expect(attempts).toHaveLength(2);
    expect(attempts[0].headers.authorization).toContain("upstream-key-1");
    expect(attempts[1].headers.authorization).toContain("upstream-key-2");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const stored = await (await fetch(`${gatewayRoot}/api/gateways/${gateway.gateway.id}`)).json() as { gateway: { accounts: Array<{ status: string; consecutiveFailures: number }> } };
    expect(stored.gateway.accounts[0]).toMatchObject({ status: "cooldown", consecutiveFailures: 1 });
    expect(stored.gateway.accounts[1]).toMatchObject({ status: "active", consecutiveFailures: 0 });
  });

  test("client disconnect cancels the in-flight upstream request", async () => {
    const gateway = await createGateway("openai");
    const controller = new AbortController();
    const pending = fetch(`${gatewayRoot}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${gateway.ownerApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "slow-disconnect", messages: [{ role: "user", content: "Cancel me" }] }),
      signal: controller.signal
    }).catch((error: unknown) => error);
    for (let attempt = 0; attempt < 40 && !captured.some((entry) => entry.body.model === "slow-disconnect"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    controller.abort();
    expect(await pending).toBeInstanceOf(Error);
    for (let attempt = 0; attempt < 40 && disconnectedUpstreams === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(disconnectedUpstreams).toBeGreaterThan(0);
  });

  test("100 concurrent proxy requests remain protocol-valid", async () => {
    const gateway = await createGateway("openai", 4);
    const responses = await Promise.all(Array.from({ length: 100 }, (_, index) => fetch(`${gatewayRoot}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${gateway.ownerApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "mock-model", messages: [{ role: "user", content: `Request ${index}` }] })
    })));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const payloads = await Promise.all(responses.map((response) => response.json() as Promise<{ object: string; choices: unknown[] }>));
    expect(payloads.every((payload) => payload.object === "chat.completion" && payload.choices.length === 1)).toBe(true);
  });

  test("50 accounts are accepted and the 51st is rejected", async () => {
    const gateway = await createGateway("openai", 50);
    expect(gateway.response.status).toBe(201);
    const addResponse = await fetch(`${gatewayRoot}/api/gateways/${gateway.gateway.id}/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Key 51", apiKey: "key-51", baseUrl: `${upstreamRoot}/v1`, weight: 1, priority: 51 })
    });
    expect(addResponse.status).toBe(409);
    expect(await addResponse.json()).toMatchObject({ error: { code: "account_limit_reached" } });

    const tooMany = await createGateway("openai", 51);
    expect(tooMany.response.status).toBe(400);
  });

  test("conflicting owner headers fail closed", async () => {
    const gateway = await createGateway("openai");
    const response = await fetch(`${gatewayRoot}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gateway.ownerApiKey}`,
        "x-api-key": "different-owner-key",
        "content-type": "application/json"
      },
      body: JSON.stringify({ model: "mock-model", messages: [{ role: "user", content: "Hello" }] })
    });
    expect(response.status).toBe(401);
  });
});
