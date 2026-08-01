import type { ClientProtocol } from "../shared/constants.js";

type JsonRecord = Record<string, unknown>;

export class ProtocolError extends Error {
  readonly statusCode = 400;
  readonly code = "unsupported_feature";

  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function rejectKeys(body: JsonRecord, unsupported: string[], protocol: string) {
  const present = unsupported.filter((key) => body[key] !== undefined);
  if (present.length) {
    throw new ProtocolError(`${protocol} cross-protocol translation does not support: ${present.join(", ")}. Use a native upstream account for this request.`);
  }
}

export function incomingProtocol(pathname: string, hasAnthropicAuthentication = false): ClientProtocol {
  return pathname.startsWith("/v1/messages") || hasAnthropicAuthentication ? "anthropic" : "openai";
}

export function protocolEndpoint(protocol: ClientProtocol, pathname: string) {
  if (pathname === "/v1/models") return "/models";
  if (protocol === "anthropic") return "/messages";
  if (pathname === "/v1/chat/completions" || pathname === "/v1/messages") return "/chat/completions";
  return pathname.replace(/^\/v1/, "") || "/";
}

function openAiImageToAnthropic(part: JsonRecord) {
  const imageUrl = record(part.image_url);
  const url = text(imageUrl.url);
  if (!url) throw new ProtocolError("OpenAI image_url blocks must include a URL.");
  if (imageUrl.detail && imageUrl.detail !== "auto") {
    throw new ProtocolError("Anthropic does not have an equivalent for OpenAI image detail; use a native OpenAI upstream.");
  }
  const data = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (data) return { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } };
  return { type: "image", source: { type: "url", url } };
}

function openAiContentToAnthropic(content: unknown): JsonRecord[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return array(content).map((rawPart) => {
    const part = record(rawPart);
    if (part.type === "text") return { type: "text", text: text(part.text) };
    if (part.type === "image_url") return openAiImageToAnthropic(part);
    throw new ProtocolError(`Unsupported OpenAI content block ${String(part.type ?? "unknown")} for Anthropic translation.`);
  });
}

function anthropicImageToOpenAi(part: JsonRecord) {
  const source = record(part.source);
  if (source.type === "base64") {
    return { type: "image_url", image_url: { url: `data:${text(source.media_type)};base64,${text(source.data)}` } };
  }
  if (source.type === "url") return { type: "image_url", image_url: { url: text(source.url) } };
  throw new ProtocolError(`Unsupported Anthropic image source ${String(source.type ?? "unknown")} for OpenAI translation.`);
}

function anthropicContentToOpenAi(content: unknown): Array<JsonRecord> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return array(content).map((rawPart) => {
    const part = record(rawPart);
    if (part.type === "text") return { type: "text", text: text(part.text) };
    if (part.type === "image") return anthropicImageToOpenAi(part);
    throw new ProtocolError(`Unsupported Anthropic content block ${String(part.type ?? "unknown")} for OpenAI translation.`);
  });
}

function compactOpenAiContent(parts: JsonRecord[]) {
  if (parts.length === 0) return null;
  if (parts.every((part) => part.type === "text")) return parts.map((part) => text(part.text)).join("");
  return parts;
}

function mergeAnthropicMessages(messages: JsonRecord[]) {
  const merged: JsonRecord[] = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (previous && previous.role === message.role) {
      previous.content = [...array(previous.content), ...array(message.content)];
    } else {
      merged.push(message);
    }
  }
  return merged;
}

function openAiMessagesToAnthropic(rawMessages: unknown) {
  const system: JsonRecord[] = [];
  const messages: JsonRecord[] = [];

  for (const rawMessage of array(rawMessages)) {
    const message = record(rawMessage);
    const role = text(message.role);
    if (role === "system" || role === "developer") {
      system.push(...openAiContentToAnthropic(message.content));
      continue;
    }
    if (role === "user") {
      messages.push({ role: "user", content: openAiContentToAnthropic(message.content) });
      continue;
    }
    if (role === "assistant") {
      const content = openAiContentToAnthropic(message.content);
      for (const rawCall of array(message.tool_calls)) {
        const call = record(rawCall);
        const fn = record(call.function);
        let input: unknown = {};
        try {
          input = JSON.parse(text(fn.arguments) || "{}");
        } catch {
          throw new ProtocolError(`Tool call ${text(call.id) || "without id"} contains invalid JSON arguments.`);
        }
        content.push({ type: "tool_use", id: text(call.id), name: text(fn.name), input });
      }
      messages.push({ role: "assistant", content });
      continue;
    }
    if (role === "tool") {
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: text(message.tool_call_id), content: openAiContentToAnthropic(message.content) }]
      });
      continue;
    }
    throw new ProtocolError(`Unsupported OpenAI message role ${role || "unknown"}.`);
  }

  return { system, messages: mergeAnthropicMessages(messages) };
}

function anthropicMessagesToOpenAi(rawMessages: unknown) {
  const messages: JsonRecord[] = [];
  for (const rawMessage of array(rawMessages)) {
    const message = record(rawMessage);
    const role = text(message.role);
    const normalParts: JsonRecord[] = [];
    const toolCalls: JsonRecord[] = [];
    const flushNormal = () => {
      if (!normalParts.length && !toolCalls.length) return;
      messages.push({
        role,
        content: compactOpenAiContent(normalParts),
        ...(toolCalls.length ? { tool_calls: [...toolCalls] } : {})
      });
      normalParts.length = 0;
      toolCalls.length = 0;
    };

    for (const rawPart of typeof message.content === "string" ? [{ type: "text", text: message.content }] : array(message.content)) {
      const part = record(rawPart);
      if (part.type === "text" || part.type === "image") {
        normalParts.push(...anthropicContentToOpenAi([part]));
      } else if (part.type === "tool_use" && role === "assistant") {
        toolCalls.push({
          id: text(part.id),
          type: "function",
          function: { name: text(part.name), arguments: JSON.stringify(part.input ?? {}) }
        });
      } else if (part.type === "tool_result" && role === "user") {
        flushNormal();
        const resultParts = anthropicContentToOpenAi(part.content);
        messages.push({
          role: "tool",
          tool_call_id: text(part.tool_use_id),
          content: compactOpenAiContent(resultParts) ?? ""
        });
      } else {
        throw new ProtocolError(`Unsupported Anthropic ${String(part.type ?? "unknown")} block for OpenAI translation.`);
      }
    }
    flushNormal();
  }
  return messages;
}

function openAiToolChoiceToAnthropic(value: unknown, parallel: unknown) {
  if (value === undefined && parallel === undefined) return undefined;
  let choice: JsonRecord;
  if (value === undefined || value === "auto") choice = { type: "auto" };
  else if (value === "none") choice = { type: "none" };
  else if (value === "required") choice = { type: "any" };
  else {
    const fn = record(record(value).function);
    choice = { type: "tool", name: text(fn.name) };
  }
  if (parallel === false) choice.disable_parallel_tool_use = true;
  return choice;
}

function anthropicToolChoiceToOpenAi(value: unknown) {
  if (value === undefined) return {};
  const choice = record(value);
  const toolChoice = choice.type === "any" ? "required"
    : choice.type === "none" ? "none"
      : choice.type === "tool" ? { type: "function", function: { name: text(choice.name) } }
        : "auto";
  return { tool_choice: toolChoice, ...(choice.disable_parallel_tool_use === true ? { parallel_tool_calls: false } : {}) };
}

function translateOpenAiRequest(body: JsonRecord) {
  rejectKeys(body, [
    "audio", "frequency_penalty", "logit_bias", "logprobs", "modalities", "prediction", "presence_penalty",
    "reasoning_effort", "response_format", "seed", "service_tier", "store", "top_logprobs", "web_search_options"
  ], "OpenAI");
  if (body.n !== undefined && body.n !== 1) throw new ProtocolError("Anthropic Messages can only produce one choice per request.");
  const converted = openAiMessagesToAnthropic(body.messages);
  return {
    model: body.model,
    max_tokens: body.max_completion_tokens ?? body.max_tokens ?? 4096,
    messages: converted.messages,
    ...(converted.system.length ? { system: converted.system } : {}),
    ...(body.stream !== undefined ? { stream: body.stream } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(body.stop !== undefined ? { stop_sequences: typeof body.stop === "string" ? [body.stop] : body.stop } : {}),
    ...(body.tools !== undefined ? {
      tools: array(body.tools).map((rawTool) => {
        const fn = record(record(rawTool).function);
        return { name: fn.name, description: fn.description, input_schema: fn.parameters ?? { type: "object", properties: {} } };
      })
    } : {}),
    ...(openAiToolChoiceToAnthropic(body.tool_choice, body.parallel_tool_calls)
      ? { tool_choice: openAiToolChoiceToAnthropic(body.tool_choice, body.parallel_tool_calls) }
      : {}),
    ...(body.user !== undefined ? { metadata: { user_id: body.user } } : {})
  };
}

function translateAnthropicRequest(body: JsonRecord) {
  rejectKeys(body, ["thinking", "top_k", "service_tier"], "Anthropic");
  const system = body.system === undefined ? [] : anthropicContentToOpenAi(body.system);
  const messages = anthropicMessagesToOpenAi(body.messages);
  if (system.length) messages.unshift({ role: "system", content: compactOpenAiContent(system) });
  const metadata = record(body.metadata);
  return {
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
    ...(body.stream !== undefined ? { stream: body.stream } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(body.stop_sequences !== undefined ? { stop: body.stop_sequences } : {}),
    ...(body.tools !== undefined ? {
      tools: array(body.tools).map((rawTool) => {
        const tool = record(rawTool);
        return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } };
      })
    } : {}),
    ...anthropicToolChoiceToOpenAi(body.tool_choice),
    ...(metadata.user_id !== undefined ? { user: metadata.user_id } : {})
  };
}

export function translateRequestBody(source: ClientProtocol, target: ClientProtocol, body: unknown) {
  if (source === target) return body;
  return source === "openai" ? translateOpenAiRequest(record(body)) : translateAnthropicRequest(record(body));
}

function openAiFinishToAnthropic(reason: unknown) {
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  if (reason === "content_filter") return "refusal";
  return "end_turn";
}

function anthropicFinishToOpenAi(reason: unknown) {
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "tool_calls";
  if (reason === "refusal") return "content_filter";
  return "stop";
}

export function translateJsonResponse(source: ClientProtocol, target: ClientProtocol, payload: unknown) {
  if (source === target) return payload;
  const body = record(payload);
  if (source === "anthropic") {
    const content = array(body.content).map(record);
    const textContent = content.filter((part) => part.type === "text").map((part) => text(part.text)).join("") || null;
    const toolCalls = content.filter((part) => part.type === "tool_use").map((part) => ({
      id: part.id,
      type: "function",
      function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) }
    }));
    const usage = record(body.usage);
    const prompt = Number(usage.input_tokens ?? 0);
    const completion = Number(usage.output_tokens ?? 0);
    return {
      id: body.id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: textContent, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        finish_reason: anthropicFinishToOpenAi(body.stop_reason),
        logprobs: null
      }],
      usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
    };
  }

  const choice = record(array(body.choices)[0]);
  const message = record(choice.message);
  const content: JsonRecord[] = [];
  if (typeof message.content === "string" && message.content) content.push({ type: "text", text: message.content });
  for (const rawCall of array(message.tool_calls)) {
    const call = record(rawCall);
    const fn = record(call.function);
    let input: unknown = {};
    try { input = JSON.parse(text(fn.arguments) || "{}"); } catch { input = { _raw: text(fn.arguments) }; }
    content.push({ type: "tool_use", id: call.id, name: fn.name, input });
  }
  const usage = record(body.usage);
  return {
    id: body.id,
    type: "message",
    role: "assistant",
    model: body.model,
    content,
    stop_reason: openAiFinishToAnthropic(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens ?? 0),
      output_tokens: Number(usage.completion_tokens ?? 0)
    }
  };
}

export function translateErrorResponse(source: ClientProtocol, target: ClientProtocol, status: number, payload: unknown) {
  if (source === target) return payload;
  const root = record(payload);
  const error = record(root.error);
  const message = text(error.message) || text(root.message) || `Upstream returned HTTP ${status}`;
  if (target === "anthropic") {
    const type = status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : status >= 500 ? "api_error" : "invalid_request_error";
    return { type: "error", error: { type, message } };
  }
  const type = status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : status >= 500 ? "server_error" : "invalid_request_error";
  return { error: { message, type, code: text(error.code) || undefined } };
}

type SseEvent = { event?: string; data: string };

async function* readSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        let event: string | undefined;
        const data: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (data.length) yield { event, data: data.join("\n") };
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

function anthropicEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function openAiEvent(data: unknown) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

async function* anthropicToOpenAi(stream: ReadableStream<Uint8Array>) {
  let id = `chatcmpl_${Date.now()}`;
  let model = "unknown";
  let created = Math.floor(Date.now() / 1000);
  let sentRole = false;
  let inputTokens = 0;
  let outputTokens = 0;
  const chunk = (delta: JsonRecord, finishReason: unknown = null, usage?: JsonRecord) => ({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
    ...(usage ? { usage } : {})
  });

  for await (const raw of readSse(stream)) {
    if (raw.data === "[DONE]") break;
    const data = record(JSON.parse(raw.data));
    const type = text(data.type) || raw.event;
    if (type === "error") {
      const upstreamError = record(data.error);
      yield openAiEvent({
        error: {
          message: text(upstreamError.message) || "Anthropic stream failed.",
          type: text(upstreamError.type) || "api_error"
        }
      });
      yield "data: [DONE]\n\n";
      return;
    } else if (type === "message_start") {
      const message = record(data.message);
      id = text(message.id) || id;
      model = text(message.model) || model;
      const usage = record(message.usage);
      inputTokens = Number(usage.input_tokens ?? 0);
      if (!sentRole) { yield openAiEvent(chunk({ role: "assistant", content: "" })); sentRole = true; }
    } else if (type === "content_block_start") {
      const block = record(data.content_block);
      if (!sentRole) { yield openAiEvent(chunk({ role: "assistant" })); sentRole = true; }
      if (block.type === "tool_use") {
        yield openAiEvent(chunk({ tool_calls: [{ index: Number(data.index ?? 0), id: block.id, type: "function", function: { name: block.name, arguments: "" } }] }));
      }
    } else if (type === "content_block_delta") {
      const delta = record(data.delta);
      if (delta.type === "text_delta") yield openAiEvent(chunk({ content: text(delta.text) }));
      if (delta.type === "input_json_delta") {
        yield openAiEvent(chunk({ tool_calls: [{ index: Number(data.index ?? 0), function: { arguments: text(delta.partial_json) } }] }));
      }
    } else if (type === "message_delta") {
      const delta = record(data.delta);
      const usage = record(data.usage);
      outputTokens = Number(usage.output_tokens ?? outputTokens);
      const totals = { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
      yield openAiEvent(chunk({}, anthropicFinishToOpenAi(delta.stop_reason), totals));
    }
  }
  yield "data: [DONE]\n\n";
}

async function* openAiToAnthropic(stream: ReadableStream<Uint8Array>) {
  let id = `msg_${Date.now()}`;
  let model = "unknown";
  let started = false;
  let textIndex: number | undefined;
  const toolIndexes = new Map<number, number>();
  const openBlocks = new Set<number>();
  let nextBlock = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const raw of readSse(stream)) {
    if (raw.data === "[DONE]") break;
    const data = record(JSON.parse(raw.data));
    const streamError = record(data.error);
    if (Object.keys(streamError).length) {
      yield anthropicEvent("error", {
        type: "error",
        error: {
          type: text(streamError.type) || "api_error",
          message: text(streamError.message) || "OpenAI stream failed."
        }
      });
      return;
    }
    id = text(data.id) || id;
    model = text(data.model) || model;
    const usage = record(data.usage);
    inputTokens = Number(usage.prompt_tokens ?? inputTokens);
    outputTokens = Number(usage.completion_tokens ?? outputTokens);
    if (!started) {
      started = true;
      yield anthropicEvent("message_start", {
        type: "message_start",
        message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } }
      });
    }
    const choice = record(array(data.choices)[0]);
    const delta = record(choice.delta);
    if (typeof delta.content === "string" && delta.content) {
      if (textIndex === undefined) {
        textIndex = nextBlock++;
        openBlocks.add(textIndex);
        yield anthropicEvent("content_block_start", { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } });
      }
      yield anthropicEvent("content_block_delta", { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: delta.content } });
    }
    for (const rawCall of array(delta.tool_calls)) {
      const call = record(rawCall);
      const openAiIndex = Number(call.index ?? 0);
      let blockIndex = toolIndexes.get(openAiIndex);
      const fn = record(call.function);
      if (blockIndex === undefined) {
        blockIndex = nextBlock++;
        toolIndexes.set(openAiIndex, blockIndex);
        openBlocks.add(blockIndex);
        yield anthropicEvent("content_block_start", {
          type: "content_block_start", index: blockIndex,
          content_block: { type: "tool_use", id: call.id, name: fn.name, input: {} }
        });
      }
      if (typeof fn.arguments === "string" && fn.arguments) {
        yield anthropicEvent("content_block_delta", {
          type: "content_block_delta", index: blockIndex,
          delta: { type: "input_json_delta", partial_json: fn.arguments }
        });
      }
    }
    if (choice.finish_reason) {
      for (const index of [...openBlocks].sort((a, b) => a - b)) {
        yield anthropicEvent("content_block_stop", { type: "content_block_stop", index });
      }
      openBlocks.clear();
      yield anthropicEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: openAiFinishToAnthropic(choice.finish_reason), stop_sequence: null },
        usage: { output_tokens: outputTokens }
      });
    }
  }
  if (!started) {
    yield anthropicEvent("message_start", {
      type: "message_start",
      message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
    });
  }
  for (const index of [...openBlocks].sort((a, b) => a - b)) {
    yield anthropicEvent("content_block_stop", { type: "content_block_stop", index });
  }
  yield anthropicEvent("message_stop", { type: "message_stop" });
}

export function translateSseStream(source: ClientProtocol, target: ClientProtocol, stream: ReadableStream<Uint8Array>) {
  if (source === target) throw new Error("SSE translation is only needed for cross-protocol requests.");
  return source === "anthropic" ? anthropicToOpenAi(stream) : openAiToAnthropic(stream);
}
