import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.AI_GATEWAY_KEY,
  baseURL: process.env.AI_GATEWAY_BASE_URL || "http://127.0.0.1:8787/v1"
});

const stream = await client.chat.completions.create({
  model: process.env.AI_GATEWAY_MODEL || "your-model-id",
  messages: [{ role: "user", content: "Say hello through the gateway." }],
  stream: true
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
