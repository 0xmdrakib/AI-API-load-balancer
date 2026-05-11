import { streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

const gateway = createOpenAI({
  apiKey: process.env.AI_GATEWAY_KEY,
  baseURL: process.env.AI_GATEWAY_BASE_URL || "http://127.0.0.1:8787/v1"
});

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: gateway(process.env.AI_GATEWAY_MODEL || "your-model-id"),
    messages
  });

  return result.toDataStreamResponse();
}
