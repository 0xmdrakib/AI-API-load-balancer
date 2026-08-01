import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.AI_GATEWAY_API_KEY,
  baseURL: process.env.AI_GATEWAY_OPENAI_BASE_URL || "http://127.0.0.1:42891/v1"
});

const response = await client.chat.completions.create({
  model: process.env.AI_MODEL || "your-model-id",
  messages: [{ role: "user", content: "Say hello through the gateway." }]
});

console.log(response.choices[0]?.message);
