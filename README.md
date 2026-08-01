# AI Load Balancer

AI Load Balancer is a local-first Windows gateway that balances provider API keys behind one stable endpoint for OpenAI and Anthropic applications.

Website: [ailoadbalancer.rakibhq.xyz](https://ailoadbalancer.rakibhq.xyz/)

Download: [Latest GitHub Release](https://github.com/0xmdrakib/AI-API-load-balancer/releases/latest)

---

## Features

- Balance up to 50 provider accounts behind one owner API key
- Priority, round robin, weighted, and least-used strategies
- Automatic failover for rate limits, billing failures, network errors, and upstream errors
- OpenAI Chat Completions and Anthropic Messages compatibility
- OpenAI ↔ Anthropic translation for supported text, vision, tools, streaming, and usage
- Official `openai` and `@anthropic-ai/sdk` examples using environment variables
- Encrypted local provider-key storage with safe recovery and atomic writes
- Local-only Windows control plane with no hosted account or cloud database
- Automatic backend recovery and single-instance desktop launch

## Requirements

- Windows 10 or Windows 11

## Download

Open the [latest release](https://github.com/0xmdrakib/AI-API-load-balancer/releases/latest) and choose either:

1. `AI-Load-Balancer.exe`
2. `AI-Load-Balancer.zip`, containing only the same portable executable

The preview is unsigned, so Windows may show “Unknown publisher”.

## Workflow

1. Launch the portable application.
2. Add provider accounts and choose a balancing strategy.
3. Create an owner API key in the dashboard.
4. Point the OpenAI SDK to `http://127.0.0.1:<port>/v1`.
5. Point the Anthropic SDK to `http://127.0.0.1:<port>`.

The desktop app selects a free port from `42891–42940`. The dashboard and SDK examples always show the actual port. OpenAI uses Bearer authentication; Anthropic uses `x-api-key`.

## Responsible Use

Use AI Load Balancer for legitimate redundancy, uptime, and budget management on provider accounts you own or are authorized to use. It does not bypass provider policies, billing controls, or rate limits.

## License

The source code is available under the [MIT License](LICENSE).
