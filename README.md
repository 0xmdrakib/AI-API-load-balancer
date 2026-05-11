# AI API Load Balancer

AI API Load Balancer is a self-hosted, OpenAI-compatible multi-provider load balancer that puts multiple AI API keys behind one owner key — with automatic failover, balance tracking, and a web dashboard.

---

## Overview

AI API Load Balancer is built for two things:

- **Key management:** Create gateways that group multiple provider API keys behind a single owner key — the gateway proxies requests through available keys based on your chosen strategy.
- **Automatic failover:** When one key hits rate limits, auth errors, low balance, or server errors, the gateway automatically switches to the next available key — no request lost.

The app focuses on keeping routing transparent by showing account status, live balances, spend estimates, failover health, and integration code directly in the dashboard.

## Features

- 4 load balancing strategies: **priority failover**, **round robin**, **weighted**, and **least used**
- Automatic failover on rate limits, auth errors, low balance, server errors, and network failures
- 13 model company profiles (OpenAI, Anthropic Claude, Google Gemini, DeepSeek, xAI, Perplexity, Meta Llama, Qwen, Microsoft Phi, NVIDIA Nemotron, Moonshot AI, MiniMax, Local/Ollama)
- 16 endpoint providers auto-detected from base URL (OpenAI, Vercel AI Gateway, OpenRouter, Anthropic, Google, Azure, Groq, Together AI, Fireworks AI, Perplexity, NVIDIA NIM, Cloudflare Workers AI, Hugging Face, Ollama, and more)
- Live balance checking for Vercel AI Gateway and OpenRouter via `/v1/credits`
- Estimated spend tracking from response token usage
- Manual budget floors for providers without balance APIs
- Encrypted API key storage at rest (`GATEWAY_SECRET`)
- Streaming support for SSE chat completions
- Exact ERC-20-style approvals (no unlimited spending)
- Web dashboard with gateway builder, account management, balance snapshots, diagnostics, and integration code
- Desktop portable app (Windows single-file `.exe`)
- Vercel AI SDK support via `createOpenAI({ baseURL, apiKey })`
- No database required — all state in a local `gateway.json` file

## Supported providers

### Model companies

| Company | Default Endpoint |
|---|---|
| OpenAI | `api.openai.com` |
| Anthropic Claude | `api.anthropic.com` |
| Google Gemini | Google OpenAI-compatible endpoint |
| DeepSeek | `api.deepseek.com` |
| xAI | `api.x.ai` |
| Perplexity | `api.perplexity.ai` |
| Meta Llama | OpenRouter |
| Qwen | OpenRouter |
| Microsoft Phi | OpenRouter |
| NVIDIA Nemotron | `integrate.api.nvidia.com` |
| Moonshot AI | OpenRouter |
| MiniMax | OpenRouter |
| Local / Ollama | `127.0.0.1:11434` |

### Endpoint providers

OpenAI Official · Vercel AI Gateway · OpenRouter · Anthropic Official · Google Gemini Official · Azure OpenAI · Groq · xAI Official · DeepSeek Official · Together AI · Fireworks AI · Perplexity Official · NVIDIA NIM · Cloudflare Workers AI · Hugging Face Inference · Ollama

## Load balancing behavior

### Priority failover

Routes requests to the account with the **lowest priority number** first. If that account fails (rate limit, auth error, low balance, server error, network error), it moves to the next priority. Perfect for primary/backup setups.

### Round robin

Cycles through all eligible accounts in priority order. Each new request goes to the next account in the rotation.

### Weighted

Randomly selects accounts based on their assigned weight. Higher weight = more traffic. Useful for distributing spend across multiple paid plans.

### Least used

Routes to the account with the **fewest total requests**. Good for distributing load evenly across keys with similar limits.

## Tech stack

- **Server:** Fastify 5, TypeScript, Zod validation
- **Client:** React 18, Vite 6, CSS with butter/cream theme + light/dark mode
- **Desktop:** Electron 33, packaged as portable Windows `.exe`
- **Storage:** Local JSON file (`gateway.json`) — no database required

---

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Create a `.env` file in the project root. Copy from [.env.example](./.env.example):

```env
PORT=8787
HOST=127.0.0.1
PUBLIC_BASE_URL=http://127.0.0.1:8787

# Required for production. Encrypts stored provider keys at rest.
GATEWAY_SECRET=change-this-to-a-long-random-secret

# Optional. Defaults to ./data for web server.
# Desktop builds use Electron's app data directory.
GATEWAY_DATA_DIR=
```

### 3. Run the development server

```bash
npm run dev
```

Opens:
- **Dashboard:** `http://127.0.0.1:5173`
- **API:** `http://127.0.0.1:8787`

### 4. Build for production

```bash
npm run build
npm run start
```

Serves both the API and the built dashboard on `http://127.0.0.1:8787`.

### 5. Desktop portable app

The portable `.exe` file are in `release/` folder.

---

## Usage

### Create a gateway

1. Open the dashboard at `http://127.0.0.1:5173`
2. Select a model company (e.g. OpenAI)
3. Add your API keys with their base URLs
4. Choose a load balancing strategy
5. Click **Create owner API**
6. Save your owner key — it's shown only once

### Use with any compatible client

Point your client's `baseURL` to `http://127.0.0.1:8787/v1` and set your owner key as the API key. The gateway forwards requests to the detected endpoint provider.

---

## Data storage

By default, gateway config is stored in:

```text
data/gateway.json
```

Provider API keys are encrypted at rest using `GATEWAY_SECRET`. Set a strong secret before real use.

For desktop builds, data is stored in:

```text
%APPDATA%\AI API load balancer\data\gateway.json
```

Override the storage directory with:

```env
GATEWAY_DATA_DIR=C:\path\to\gateway-data
```

---

## Safety

Use this for legitimate redundancy, uptime, and budget management. Do not use it to bypass provider rate limits, billing restrictions, or account policies.

## License

This project is licensed under the [MIT License](./LICENSE).
