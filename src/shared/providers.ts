import type {
  EndpointProviderDefinition,
  ModelCompanyDefinition,
  PolicyDefinition
} from "./types.js";

export const policies: PolicyDefinition[] = [
  {
    id: "priority-failover",
    name: "Primary then backup",
    description: "Use the first healthy key until it hits a balance floor, rate limit, or error, then move to the next key."
  },
  {
    id: "round-robin",
    name: "Round robin",
    description: "Rotate evenly across all active keys, skipping paused, exhausted, or cooling-down keys."
  },
  {
    id: "weighted",
    name: "Weighted balance",
    description: "Send more traffic to keys with higher weight. Useful when one account has more quota than another."
  },
  {
    id: "least-used",
    name: "Least used",
    description: "Prefer the key with the fewest requests so usage stays naturally spread out."
  }
];

export const defaultFailover = {
  switchOnLowBalance: true,
  lowBalanceCents: 20,
  switchOnRateLimit: true,
  switchOnServerError: true,
  switchOnNetworkError: true,
  switchOnAuthError: true,
  cooldownSeconds: 60,
  maxRetries: 4
};

const commonTextFeatures = ["chat", "streaming", "tools", "structured-output", "reasoning"] as const;

export const modelCompanies: ModelCompanyDefinition[] = [
  {
    id: "openai",
    name: "OpenAI",
    shortName: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultEndpointProviderId: "openai-official",
    compatibility: "openai-compatible",
    docsUrl: "https://platform.openai.com/docs",
    features: ["openai-compatible", ...commonTextFeatures, "responses", "vision", "embeddings", "image-generation", "web-search", "audio"],
    note: "Use official OpenAI keys or route OpenAI model IDs through Vercel AI Gateway, OpenRouter, or another compatible endpoint.",
    estimatedCentsPer1KTokens: 0.45
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    shortName: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultEndpointProviderId: "anthropic-official",
    compatibility: "native-adapter",
    docsUrl: "https://docs.anthropic.com",
    features: ["native-adapter", ...commonTextFeatures, "vision"],
    note: "Official Anthropic Messages API and third-party OpenAI-compatible routers are both allowed.",
    estimatedCentsPer1KTokens: 0.75
  },
  {
    id: "google-gemini",
    name: "Google Gemini",
    shortName: "Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultEndpointProviderId: "google-gemini-official",
    compatibility: "openai-compatible",
    docsUrl: "https://ai.google.dev/gemini-api/docs/openai",
    features: ["openai-compatible", ...commonTextFeatures, "vision", "embeddings", "web-search"],
    note: "Gemini can run through Google’s OpenAI-compatible endpoint or through multi-model routers.",
    estimatedCentsPer1KTokens: 0.25
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    shortName: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    defaultEndpointProviderId: "deepseek-official",
    compatibility: "openai-compatible",
    docsUrl: "https://api-docs.deepseek.com",
    features: ["openai-compatible", ...commonTextFeatures],
    note: "DeepSeek official and router-supplied DeepSeek model IDs are passed through unchanged.",
    estimatedCentsPer1KTokens: 0.08
  },

  {
    id: "xai",
    name: "xAI",
    shortName: "xAI",
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultEndpointProviderId: "xai-official",
    compatibility: "openai-compatible",
    docsUrl: "https://docs.x.ai",
    features: ["openai-compatible", ...commonTextFeatures, "vision"],
    note: "xAI Grok model requests pass through to the detected endpoint provider.",
    estimatedCentsPer1KTokens: 0.45
  },

  {
    id: "perplexity",
    name: "Perplexity",
    shortName: "Perplexity",
    defaultBaseUrl: "https://api.perplexity.ai",
    defaultEndpointProviderId: "perplexity-official",
    compatibility: "openai-compatible",
    docsUrl: "https://docs.perplexity.ai",
    features: ["openai-compatible", "chat", "streaming", "web-search", "reasoning"],
    note: "Perplexity search/chat models can use official or router endpoints.",
    estimatedCentsPer1KTokens: 0.2
  },
  {
    id: "meta",
    name: "Meta Llama",
    shortName: "Llama",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultEndpointProviderId: "openrouter",
    compatibility: "openai-compatible",
    docsUrl: "https://llama.meta.com",
    features: ["openai-compatible", ...commonTextFeatures, "vision"],
    note: "Meta Llama models are usually supplied through routers such as OpenRouter, Groq, Together, Fireworks, or local Ollama.",
    estimatedCentsPer1KTokens: 0.18
  },
  {
    id: "qwen",
    name: "Qwen",
    shortName: "Qwen",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultEndpointProviderId: "openrouter",
    compatibility: "openai-compatible",
    docsUrl: "https://qwenlm.github.io",
    features: ["openai-compatible", ...commonTextFeatures, "vision"],
    note: "Qwen is commonly accessed through routers; the gateway leaves exact model IDs to the endpoint.",
    estimatedCentsPer1KTokens: 0.16
  },
  {
    id: "microsoft",
    name: "Microsoft Phi",
    shortName: "Phi",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultEndpointProviderId: "openrouter",
    compatibility: "openai-compatible",
    docsUrl: "https://azure.microsoft.com/products/phi",
    features: ["openai-compatible", "chat", "streaming", "tools", "vision"],
    note: "Phi model routing is endpoint-defined and supports official Azure-style or router-style access.",
    estimatedCentsPer1KTokens: 0.12
  },
  {
    id: "nvidia",
    name: "NVIDIA Nemotron",
    shortName: "NVIDIA",
    defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
    defaultEndpointProviderId: "nvidia-nim",
    compatibility: "openai-compatible",
    docsUrl: "https://docs.api.nvidia.com",
    features: ["openai-compatible", ...commonTextFeatures, "vision", "embeddings", "rerank"],
    note: "NVIDIA-hosted and router-hosted Nemotron style models can be grouped here.",
    estimatedCentsPer1KTokens: 0.2
  },


  {
    id: "moonshot",
    name: "Moonshot AI",
    shortName: "Moonshot",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultEndpointProviderId: "openrouter",
    compatibility: "openai-compatible",
    docsUrl: "https://platform.moonshot.ai",
    features: ["openai-compatible", ...commonTextFeatures, "vision"],
    note: "Moonshot model IDs pass through to whichever endpoint supplies them.",
    estimatedCentsPer1KTokens: 0.18
  },
  {
    id: "minimax",
    name: "MiniMax",
    shortName: "MiniMax",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultEndpointProviderId: "openrouter",
    compatibility: "openai-compatible",
    docsUrl: "https://www.minimax.io/platform",
    features: ["openai-compatible", "chat", "streaming", "tools", "audio"],
    note: "MiniMax model availability is delegated to the selected endpoint provider.",
    estimatedCentsPer1KTokens: 0.18
  },
  {
    id: "ollama-models",
    name: "Local / Ollama Models",
    shortName: "Local",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    defaultEndpointProviderId: "ollama",
    compatibility: "openai-compatible",
    docsUrl: "https://github.com/ollama/ollama/blob/main/docs/openai.md",
    features: ["openai-compatible", "chat", "streaming", "tools", "vision", "embeddings"],
    note: "Local models have no remote balance; health and error failover are the useful controls.",
    estimatedCentsPer1KTokens: 0
  }
];

export const endpointProviders: EndpointProviderDefinition[] = [
  {
    id: "openai-official",
    name: "OpenAI Official",
    shortName: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    compatibility: "openai-compatible",
    authType: "bearer",
    docsUrl: "https://platform.openai.com/docs",
    match: { hosts: ["api.openai.com"] },
    balance: {
      mode: "estimated",
      label: "Estimated spend tracking",
      note: "OpenAI does not expose a simple public per-key credit balance endpoint for normal API keys."
    },
    estimatedCentsPer1KTokens: 0.45
  },
  {
    id: "vercel-ai-gateway",
    name: "Vercel AI Gateway",
    shortName: "Vercel",
    defaultBaseUrl: "https://ai-gateway.vercel.sh/v1",
    compatibility: "openai-compatible",
    authType: "bearer",
    docsUrl: "https://vercel.com/docs/ai-gateway",
    match: { hosts: ["ai-gateway.vercel.sh"] },
    balance: {
      mode: "api",
      label: "Live Vercel credits",
      note: "Vercel exposes GET /credits with balance and total_used."
    },
    estimatedCentsPer1KTokens: 0.35
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    shortName: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    compatibility: "openai-compatible",
    authType: "bearer",
    docsUrl: "https://openrouter.ai/docs",
    match: { hosts: ["openrouter.ai"], pathIncludes: ["/api/v1"] },
    balance: {
      mode: "api",
      label: "Live OpenRouter credits",
      note: "OpenRouter exposes GET /credits with total credits and total usage."
    },
    estimatedCentsPer1KTokens: 0.35
  },
  {
    id: "anthropic-official",
    name: "Anthropic Official",
    shortName: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    compatibility: "native-adapter",
    authType: "x-api-key",
    docsUrl: "https://docs.anthropic.com",
    match: { hosts: ["api.anthropic.com"] },
    balance: {
      mode: "estimated",
      label: "Estimated spend tracking",
      note: "Anthropic does not expose a simple public per-key balance endpoint."
    },
    estimatedCentsPer1KTokens: 0.75
  },
  {
    id: "google-gemini-official",
    name: "Google Gemini Official",
    shortName: "Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    compatibility: "openai-compatible",
    authType: "bearer",
    docsUrl: "https://ai.google.dev/gemini-api/docs/openai",
    match: { hosts: ["generativelanguage.googleapis.com"] },
    balance: {
      mode: "estimated",
      label: "Estimated spend tracking",
      note: "Google billing is project scoped; the gateway keeps local estimates per key."
    },
    estimatedCentsPer1KTokens: 0.25
  },
  {
    id: "azure-openai",
    name: "Azure OpenAI",
    shortName: "Azure",
    defaultBaseUrl: "https://YOUR-RESOURCE.openai.azure.com/openai/v1",
    compatibility: "custom-base",
    authType: "bearer",
    docsUrl: "https://learn.microsoft.com/azure/ai-services/openai/",
    match: { hosts: ["openai.azure.com"] },
    balance: {
      mode: "manual",
      label: "Manual budget floor",
      note: "Azure quota and billing are subscription/resource scoped."
    },
    estimatedCentsPer1KTokens: 0.45
  },

  {
    id: "groq",
    name: "Groq",
    shortName: "Groq",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    compatibility: "openai-compatible",
    authType: "bearer",
    docsUrl: "https://console.groq.com/docs",
    match: { hosts: ["api.groq.com"] },
    balance: { mode: "estimated", label: "Estimated spend tracking", note: "Groq billing/rate limits are handled upstream." },
    estimatedCentsPer1KTokens: 0.12
  },
  {
    id: "xai-official",
    name: "xAI Official",
    shortName: "xAI",
    defaultBaseUrl: "https://api.x.ai/v1",
    compatibility: "openai-compatible",
    authType: "bearer",
    docsUrl: "https://docs.x.ai",
    match: { hosts: ["api.x.ai"] },
    balance: { mode: "estimated", label: "Estimated spend tracking", note: "xAI usage is estimated locally." },
    estimatedCentsPer1KTokens: 0.45
  },
  {
    id: "deepseek-official",
    name: "DeepSeek Official",
    shortName: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    compatibility: "openai-compatible",
    authType: "bearer",
    docsUrl: "https://api-docs.deepseek.com",
    match: { hosts: ["api.deepseek.com"] },
    balance: { mode: "estimated", label: "Estimated spend tracking", note: "DeepSeek usage is estimated locally." },
    estimatedCentsPer1KTokens: 0.08
  },
  {
    id: "together",
    name: "Together AI",
    shortName: "Together",
    defaultBaseUrl: "https://api.together.xyz/v1",
    compatibility: "openai-compatible",
    authType: "bearer",
    docsUrl: "https://docs.together.ai",
    match: { hosts: ["api.together.xyz"] },
    balance: { mode: "estimated", label: "Estimated spend tracking", note: "Together usage is estimated locally." },
    estimatedCentsPer1KTokens: 0.18
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    shortName: "Fireworks",
    defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
    compatibility: "openai-compatible",
    authType: "bearer",
    docsUrl: "https://docs.fireworks.ai",
    match: { hosts: ["api.fireworks.ai"] },
    balance: { mode: "estimated", label: "Estimated spend tracking", note: "Fireworks usage is estimated locally." },
    estimatedCentsPer1KTokens: 0.2
  },
  {
    id: "perplexity-official",
    name: "Perplexity Official",
    shortName: "Perplexity",
    defaultBaseUrl: "https://api.perplexity.ai",
    compatibility: "openai-compatible",
    authType: "bearer",
    docsUrl: "https://docs.perplexity.ai",
    match: { hosts: ["api.perplexity.ai"] },
    balance: { mode: "estimated", label: "Estimated spend tracking", note: "Perplexity usage is estimated locally." },
    estimatedCentsPer1KTokens: 0.2
  },

  {
    id: "nvidia-nim",
    name: "NVIDIA NIM",
    shortName: "NVIDIA",
    defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
    compatibility: "openai-compatible",
    authType: "bearer",
    docsUrl: "https://docs.api.nvidia.com",
    match: { hosts: ["integrate.api.nvidia.com"] },
    balance: { mode: "estimated", label: "Estimated spend tracking", note: "NVIDIA usage is estimated locally." },
    estimatedCentsPer1KTokens: 0.2
  },
  {
    id: "cloudflare-workers-ai",
    name: "Cloudflare Workers AI",
    shortName: "Cloudflare",
    defaultBaseUrl: "https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/ai/v1",
    compatibility: "custom-base",
    authType: "bearer",
    docsUrl: "https://developers.cloudflare.com/workers-ai/",
    match: { hosts: ["api.cloudflare.com"], pathIncludes: ["/ai/v1"] },
    balance: { mode: "manual", label: "Manual budget floor", note: "Cloudflare billing is account scoped." },
    estimatedCentsPer1KTokens: 0.08
  },
  {
    id: "huggingface",
    name: "Hugging Face Inference",
    shortName: "Hugging Face",
    defaultBaseUrl: "https://router.huggingface.co/v1",
    compatibility: "openai-compatible",
    authType: "bearer",
    docsUrl: "https://huggingface.co/docs/api-inference",
    match: { hosts: ["router.huggingface.co"] },
    balance: { mode: "estimated", label: "Estimated spend tracking", note: "Hugging Face usage is estimated locally." },
    estimatedCentsPer1KTokens: 0.1
  },
  {
    id: "replicate",
    name: "Replicate",
    shortName: "Replicate",
    defaultBaseUrl: "https://api.replicate.com/v1",
    compatibility: "custom-base",
    authType: "bearer",
    docsUrl: "https://replicate.com/docs",
    match: { hosts: ["api.replicate.com"] },
    balance: { mode: "estimated", label: "Estimated spend tracking", note: "Replicate usage is estimated locally." },
    estimatedCentsPer1KTokens: 0.2
  },
  {
    id: "ollama",
    name: "Ollama",
    shortName: "Ollama",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    compatibility: "openai-compatible",
    authType: "bearer",
    docsUrl: "https://github.com/ollama/ollama/blob/main/docs/openai.md",
    match: { hosts: ["127.0.0.1", "localhost"] },
    balance: { mode: "manual", label: "No billing", note: "Local Ollama has no remote credit balance." },
    estimatedCentsPer1KTokens: 0
  }
];

export const providers = modelCompanies;

export function getModelCompany(modelCompanyId: string) {
  return modelCompanies.find((provider) => provider.id === modelCompanyId);
}

export function getProvider(providerId: string) {
  return getModelCompany(providerId);
}

export function getEndpointProvider(endpointProviderId: string) {
  return endpointProviders.find((provider) => provider.id === endpointProviderId);
}

export function detectEndpointProvider(baseUrl?: string, fallbackEndpointProviderId = "openai-official") {
  if (!baseUrl) return getEndpointProvider(fallbackEndpointProviderId) ?? endpointProviders[0];

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return getEndpointProvider(fallbackEndpointProviderId) ?? endpointProviders[0];
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const matched = endpointProviders.find((provider) => {
    const hostMatches = provider.match.hosts.some((candidate) => {
      const normalized = candidate.toLowerCase();
      return host === normalized || host.endsWith(`.${normalized}`) || host.endsWith(normalized);
    });
    if (!hostMatches) return false;
    return provider.match.pathIncludes?.every((part) => path.includes(part.toLowerCase())) ?? true;
  });

  return matched ?? getEndpointProvider(fallbackEndpointProviderId) ?? endpointProviders[0];
}
