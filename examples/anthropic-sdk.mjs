import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.AI_GATEWAY_API_KEY,
  baseURL: process.env.AI_GATEWAY_ANTHROPIC_BASE_URL || "http://127.0.0.1:42891"
});

const response = await client.messages.create({
  model: process.env.AI_MODEL || "your-model-id",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Say hello through the gateway." }]
});

console.log(response.content);
