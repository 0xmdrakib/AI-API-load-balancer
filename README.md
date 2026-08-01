# AI Load Balancer v0.2.0

AI Load Balancer is a local Windows control plane that puts up to 50 provider keys behind one owner key. OpenAI and Anthropic clients can use the same gateway with native passthrough, cross-protocol translation, balancing, and failover.

## Highlights

- Official OpenAI Chat Completions and Anthropic Messages client compatibility
- OpenAI → OpenAI, Anthropic → Anthropic, OpenAI → Anthropic, and Anthropic → OpenAI routing
- Non-streaming and SSE streaming translation for text, images, function tools, tool results, stop reasons, and usage
- Four strategies: priority failover, round robin, weighted, and least used
- Up to 50 provider accounts per gateway and up to 49 failover retries
- `Retry-After`-aware cooldowns and distinct invalid, exhausted, cooldown, and active states
- Vercel AI Gateway remains available as an OpenAI-compatible upstream provider
- SafeStorage-backed installation secret in the Windows desktop build; provider keys use AES-256-GCM at rest
- Isolated Electron utility-process backend with single-instance handling and crash restart delays of 1s, 2s, and 5s
- Version-2 memory-resident store with serialized atomic writes, backup recovery, and legacy-store preservation
- Responsive black/gold/cream dashboard with light and dark themes

## Local URLs and ports

The desktop app scans IANA-unassigned ports `42891–42940` and uses the first free port. If the entire range is occupied, it asks the OS for a free port. The UI and generated SDK snippets always use the actual bound port.

For a standalone server, an explicit `PORT` is honored exactly:

```powershell
$env:PORT = "43001"
$env:GATEWAY_SECRET = "replace-with-a-long-random-secret"
npm start
```

Runtime metadata is available without secrets at `/runtime` and `/api/runtime`. Readiness and store recovery state are available at `/health`.

## Install and verify

```bash
npm install
npm run verify
```

`npm run verify` runs strict client/server type checks, the official-SDK integration suite, and the production web build.

## Development

```bash
npm run dev:api
npm run dev:web
```

The standalone API prefers `http://127.0.0.1:42891`. Vite runs on `http://127.0.0.1:5173` and proxies to that preferred development port. If `42891` is occupied, set an explicit `PORT` and update the local Vite proxy when running the two servers separately.

To run the full desktop flow with the built dashboard:

```bash
npm run dev:desktop
```

## OpenAI SDK

The OpenAI base URL includes `/v1`:

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.AI_GATEWAY_API_KEY,
  baseURL: process.env.AI_GATEWAY_OPENAI_BASE_URL
});

const response = await client.chat.completions.create({
  model: "your-model-id",
  messages: [{ role: "user", content: "Hello" }]
});
```

## Anthropic SDK

The Anthropic base URL deliberately does not include `/v1`:

```js
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.AI_GATEWAY_API_KEY,
  baseURL: process.env.AI_GATEWAY_ANTHROPIC_BASE_URL
});

const response = await client.messages.create({
  model: "your-model-id",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello" }]
});
```

Both Bearer owner authentication and `x-api-key` owner authentication are accepted. If both are sent with different values, the request fails closed with `401`.

## Cross-protocol scope

Chat Completions and Messages translate between protocols for text, supported image blocks, function tools, tool calls/results, tool choice, parallel-tool intent, usage, errors, and SSE streams.

OpenAI Responses and Anthropic thinking/beta-only body blocks are not silently simplified. They pass through to a native upstream, or return `400 unsupported_feature` when cross-protocol translation would be required. Files, batches, and other native endpoints follow the same rule.

## Storage

The desktop build stores configuration below the app's Windows user-data directory. A random installation secret is encrypted by Electron SafeStorage. New provider keys are encrypted before being written to `gateway.json`.

Store writes are serialized and atomically replaced. A `.bak` copy is maintained. A version-1 store is preserved as a timestamped backup before a clean version-2 store is created; corrupt primary data is preserved and recovered from a valid backup when possible.

For standalone use:

```env
GATEWAY_SECRET=replace-with-a-long-random-secret
GATEWAY_DATA_DIR=C:\path\to\gateway-data
```

Production mode refuses to start with the shared development secret.

## Windows preview build

```bash
npm run desktop:pack:single
npm run desktop:pack
```

`npm run desktop:pack` creates the portable EXE and a ZIP containing only that EXE.
The clean release filenames are `AI Load Balancer.exe` and `AI Load Balancer.zip`; the release/tag carries the version number.

The v0.2.0 preview is unsigned, so Windows may show “Unknown publisher.” No GitHub release is created by these commands.

## Showcase website

The Vercel-ready static showcase lives in [`website/`](./website). It is intentionally separate from the Electron application and has no access to local keys, runtime state, or gateway ports. Deploy the `website` directory as the project root on Vercel, or use the future public domain:

**https://ailoadbalancer.rakibhq.xyz**

It includes responsive product documentation, OpenAI and Anthropic setup examples, benefits, quick-start guidance, release downloads, the approved brand icon, light/dark theme parity, and mobile navigation. Verify it with:

```bash
npm run site:verify
```

## Safety

Use the gateway for legitimate redundancy, uptime, and budget management. It does not authorize bypassing provider policies, billing controls, or rate limits.

## License

[MIT](./LICENSE)
