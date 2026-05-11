import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  Gauge,
  KeyRound,
  Layers3,
  MonitorDown,
  Pause,
  Plus,
  RadioTower,
  RefreshCw,
  RotateCcw,
  TestTube2,
  Search,
  ServerCog,
  ShieldCheck,
  Shuffle,
  Sparkles,
  Sun,
  Moon,
  Trash2,
  Zap
} from "lucide-react";
import {
  checkOwnerKey,
  createGateway,
  deleteGateway,
  deleteGatewayAccount,
  fetchBalances,
  fetchBootstrap,
  fetchGatewayDiagnostics,
  fetchGateways,
  patchGateway,
  rotateOwnerKey
} from "./api";
import { detectEndpointProvider } from "../shared/providers";
import type {
  BalanceSnapshot,
  EndpointProviderDefinition,
  FailoverOptions,
  GatewayDiagnostics,
  GatewayCreateInput,
  GatewayPublic,
  LoadBalancingStrategy,
  ModelCompanyDefinition,
  OwnerKeyCheckResult,
  PolicyDefinition,
  ProviderFeature
} from "../shared/types";

interface AccountDraft {
  label: string;
  apiKey: string;
  baseUrl: string;
  estimatedBalanceUsd: string;
  balanceFloorUsd: string;
  weight: number;
  priority: number;
}

const featureLabels: Record<ProviderFeature, string> = {
  "openai-compatible": "OpenAI compatible",
  "native-adapter": "Native adapter",
  chat: "Chat",
  responses: "Responses",
  streaming: "Streaming",
  tools: "Tools",
  "structured-output": "Structured output",
  vision: "Vision",
  embeddings: "Embeddings",
  "image-generation": "Images",
  "web-search": "Search",
  reasoning: "Reasoning",
  rerank: "Rerank",
  audio: "Audio"
};

const strategyIcon: Record<LoadBalancingStrategy, typeof Shuffle> = {
  "priority-failover": RadioTower,
  "round-robin": RotateCcw,
  weighted: Gauge,
  "least-used": Activity
};

function centsFromUsd(value: string) {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.round(parsed * 100);
}

function isValidUrl(value: string) {
  if (!value.trim()) return true;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function formatUsd(cents?: number) {
  if (typeof cents !== "number") return "not set";
  return `$${(cents / 100).toFixed(2)}`;
}

function balanceStateLabel(balance: BalanceSnapshot) {
  if (balance.balanceState === "auth-unavailable") return "auth";
  if (balance.balanceState === "unavailable") return "check off";
  if (balance.balanceState === "cached") return "cached";
  if (balance.balanceState === "live") return "live";
  if (balance.balanceState === "manual") return "manual";
  if (balance.balanceState === "estimated") return "local";
  return "unset";
}

function makeAccountDraft(index: number, provider?: ModelCompanyDefinition): AccountDraft {
  return {
    label: `Key ${index + 1}`,
    apiKey: "",
    baseUrl: provider?.setupFields?.some((field) => field.key === "baseUrl") ? provider.defaultBaseUrl : "",
    estimatedBalanceUsd: "",
    balanceFloorUsd: "0.20",
    weight: 1,
    priority: index + 1
  };
}

function copyText(value: string) {
  return navigator.clipboard.writeText(value);
}

function localGatewayBaseUrl() {
  return `${window.location.origin}/v1`;
}

export function App() {
  const [providers, setProviders] = useState<ModelCompanyDefinition[]>([]);
  const [_endpointProviders, setEndpointProviders] = useState<EndpointProviderDefinition[]>([]);
  const [policies, setPolicies] = useState<PolicyDefinition[]>([]);
  const [defaultFailover, setDefaultFailover] = useState<FailoverOptions | null>(null);
  const [gateways, setGateways] = useState<GatewayPublic[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState("openai");
  const [query, setQuery] = useState("");
  const [gatewayName, setGatewayName] = useState("Production Gateway");
  const [strategy, setStrategy] = useState<LoadBalancingStrategy>("priority-failover");
  const [failover, setFailover] = useState<FailoverOptions | null>(null);
  const [accountCount, setAccountCount] = useState(3);
  const [accounts, setAccounts] = useState<AccountDraft[]>([]);
  const [createResult, setCreateResult] = useState<{ ownerApiKey: string; baseUrl: string; gateway: GatewayPublic } | null>(null);
  const [selectedGatewayId, setSelectedGatewayId] = useState<string | null>(null);
  const [balances, setBalances] = useState<BalanceSnapshot[]>([]);
  const [diagnostics, setDiagnostics] = useState<GatewayDiagnostics | null>(null);
  const [checkingDiagnostics, setCheckingDiagnostics] = useState(false);
  const [balanceRefreshedAt, setBalanceRefreshedAt] = useState<string | null>(null);
  const [ownerKeyProbe, setOwnerKeyProbe] = useState("");
  const [ownerKeyCheck, setOwnerKeyCheck] = useState<OwnerKeyCheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("theme") as "light" | "dark") || "light";
    }
    return "dark";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === selectedProviderId),
    [providers, selectedProviderId]
  );

  const selectedGateway = useMemo(
    () => gateways.find((gateway) => gateway.id === selectedGatewayId) || gateways[0],
    [gateways, selectedGatewayId]
  );

  const filteredProviders = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return providers;
    return providers.filter((provider) => {
      const haystack = `${provider.name} ${provider.shortName} ${provider.features.join(" ")}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }, [providers, query]);

  useEffect(() => {
    fetchBootstrap()
      .then((data) => {
        setProviders(data.providers);
        setEndpointProviders(data.endpointProviders);
        setPolicies(data.policies);
        setDefaultFailover(data.defaultFailover);
        setFailover(data.defaultFailover);
        const initialProvider = data.providers.find((provider) => provider.id === "openai") || data.providers[0];
        setSelectedProviderId(initialProvider.id);
        setAccounts(Array.from({ length: accountCount }, (_, index) => makeAccountDraft(index, initialProvider)));
      })
      .catch((caught) => setError(caught.message));

    refreshGateways();
  }, []);

  useEffect(() => {
    if (!selectedProvider) return;
    setAccounts((current) => {
      const next = Array.from({ length: accountCount }, (_, index) => current[index] || makeAccountDraft(index, selectedProvider));
      return next.map((account, index) => ({
        ...account,
        priority: account.priority || index + 1,
        baseUrl: selectedProvider.setupFields?.some((field) => field.key === "baseUrl") ? account.baseUrl || selectedProvider.defaultBaseUrl : account.baseUrl
      }));
    });
  }, [accountCount, selectedProvider]);

  useEffect(() => {
    if (!selectedGateway?.id) {
      setBalances([]);
      setDiagnostics(null);
      setBalanceRefreshedAt(null);
      return;
    }

    let active = true;
    const gatewayId = selectedGateway.id;
    setDiagnostics(null);

    const loadBalances = async (forceRefresh = false) => {
      try {
        const data = await fetchBalances(gatewayId, forceRefresh);
        if (!active) return;
        setBalances(data.balances);
        setBalanceRefreshedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      } catch {
        if (!active) return;
        setBalances([]);
        setBalanceRefreshedAt(null);
      }
    };

    loadBalances();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") {
        loadBalances(true);
      }
    }, 5000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [selectedGateway?.id]);

  useEffect(() => {
    if (createResult?.ownerApiKey) {
      setOwnerKeyProbe(createResult.ownerApiKey);
      setOwnerKeyCheck(null);
    }
  }, [createResult?.ownerApiKey]);

  async function refreshGateways() {
    const data = await fetchGateways();
    setGateways(data.gateways);
    setSelectedGatewayId((current) => (current && data.gateways.some((gateway) => gateway.id === current) ? current : data.gateways[0]?.id || null));
  }

  async function handleRefreshAll() {
    setRefreshing(true);
    setError(null);
    try {
      await refreshGateways();
      if (selectedGateway?.id) {
        const data = await fetchBalances(selectedGateway.id, true);
        setBalances(data.balances);
        setBalanceRefreshedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  function updateAccount(index: number, patch: Partial<AccountDraft>) {
    setAccounts((current) => current.map((account, accountIndex) => (accountIndex === index ? { ...account, ...patch } : account)));
  }

  async function submitGateway() {
    if (!selectedProvider || !failover) return;
    setBusy(true);
    setError(null);
    try {
      const filledAccounts = accounts.filter((account) => account.apiKey.trim() || account.baseUrl.trim() || account.estimatedBalanceUsd.trim());
      const accountsMissingKeys = filledAccounts.findIndex((account) => !account.apiKey.trim());
      if (accountsMissingKeys >= 0) {
        throw new Error(`Key row ${accountsMissingKeys + 1} has settings but no API key. Add the key or clear that row.`);
      }

      const invalidBaseUrlIndex = filledAccounts.findIndex((account) => !isValidUrl(account.baseUrl));
      if (invalidBaseUrlIndex >= 0) {
        throw new Error(`Key row ${invalidBaseUrlIndex + 1} has an invalid base URL.`);
      }

      if (filledAccounts.length === 0) {
        throw new Error("Add at least one endpoint API key.");
      }

      const input: GatewayCreateInput = {
        name: gatewayName,
        modelCompanyId: selectedProvider.id,
        providerId: selectedProvider.id,
        strategy,
        failover,
        accounts: filledAccounts.map((account, index) => ({
          label: account.label || `Key ${index + 1}`,
          apiKey: account.apiKey.trim(),
          baseUrl: account.baseUrl || undefined,
          estimatedBalanceCents: centsFromUsd(account.estimatedBalanceUsd),
          balanceFloorCents: centsFromUsd(account.balanceFloorUsd),
          weight: account.weight,
          priority: account.priority
        }))
      };
      const result = await createGateway(input);
      setCreateResult(result);
      await refreshGateways();
      setSelectedGatewayId(result.gateway.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create gateway");
    } finally {
      setBusy(false);
    }
  }

  async function saveGatewayPolicy(gateway: GatewayPublic, nextStrategy: LoadBalancingStrategy) {
    setBusy(true);
    setError(null);
    try {
      await patchGateway(gateway.id, { strategy: nextStrategy });
      await refreshGateways();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update gateway");
    } finally {
      setBusy(false);
    }
  }

  async function rotateKey(gateway: GatewayPublic) {
    setBusy(true);
    setError(null);
    try {
      const result = await rotateOwnerKey(gateway.id);
      setCreateResult(result);
      await refreshGateways();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not rotate owner key");
    } finally {
      setBusy(false);
    }
  }

  async function removeGateway(gateway: GatewayPublic) {
    setBusy(true);
    setError(null);
    try {
      await deleteGateway(gateway.id);
      setCreateResult((current) => (current?.gateway.id === gateway.id ? null : current));
      setDiagnostics(null);
      setBalances([]);
      await refreshGateways();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete gateway");
    } finally {
      setBusy(false);
    }
  }

  async function removeGatewayAccount(gateway: GatewayPublic, accountId: string) {
    setBusy(true);
    setError(null);
    try {
      await deleteGatewayAccount(gateway.id, accountId);
      setDiagnostics(null);
      const balanceResult = await fetchBalances(gateway.id, true);
      setBalances(balanceResult.balances);
      setBalanceRefreshedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      await refreshGateways();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete account");
    } finally {
      setBusy(false);
    }
  }

  async function runGatewayDiagnostics(gateway: GatewayPublic) {
    setCheckingDiagnostics(true);
    setError(null);
    try {
      const result = await fetchGatewayDiagnostics(gateway.id);
      setDiagnostics(result.diagnostics);
      const balanceResult = await fetchBalances(gateway.id, true);
      setBalances(balanceResult.balances);
      setBalanceRefreshedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      await refreshGateways();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not run gateway checks");
    } finally {
      setCheckingDiagnostics(false);
    }
  }

  async function verifyOwnerKey() {
    if (!ownerKeyProbe.trim()) {
      setOwnerKeyCheck({
        valid: false,
        checkedAt: new Date().toISOString(),
        message: "Paste an owner API key first."
      });
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await checkOwnerKey(ownerKeyProbe.trim());
      setOwnerKeyCheck(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not verify owner key");
    } finally {
      setBusy(false);
    }
  }

  const connectionGateway = selectedGateway ?? createResult?.gateway ?? null;
  const hasFreshOwnerKey = Boolean(createResult && connectionGateway && createResult.gateway.id === connectionGateway.id);
  const connectionBaseUrl = hasFreshOwnerKey ? createResult!.baseUrl : connectionGateway ? localGatewayBaseUrl() : "";
  const connectionOwnerKey = hasFreshOwnerKey ? createResult!.ownerApiKey : "YOUR_OWNER_API_KEY";

  const openAiSnippet = connectionGateway
    ? `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "${connectionOwnerKey}",
  baseURL: "${connectionBaseUrl}"
});

const result = await client.chat.completions.create({
  model: "your-model-id",
  messages: [{ role: "user", content: "Hello" }],
  stream: true
});`
    : "";

  const vercelSnippet = connectionGateway
    ? `import { streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

const gateway = createOpenAI({
  apiKey: "${connectionOwnerKey}",
  baseURL: "${connectionBaseUrl}"
});

export async function POST(req: Request) {
  const { messages } = await req.json();
  const result = streamText({
    model: gateway("your-model-id"),
    messages
  });

  return result.toDataStreamResponse();
}`
    : "";

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Gateway navigation">
        <div className="brand">
          <div className="brand-mark">
            <img src="/logo.png" alt="AI API load balancer" />
          </div>
          <div>
            <strong className="dot-type">AI API load balancer</strong>
            <span>Provider load balancing</span>
          </div>
        </div>

        <nav className="nav-list">
          <a href="#builder" className="nav-item active">
            <ServerCog size={18} />
            Builder
          </a>
          <a href="#gateways" className="nav-item">
            <Layers3 size={18} />
            Gateway & accounts
          </a>
          <a href="#integration" className="nav-item">
            <MonitorDown size={18} />
            Integration
          </a>
        </nav>

        <div className="sidebar-stat">
          <span>Companies</span>
          <strong>{providers.length || "..."}</strong>
        </div>
        <div className="sidebar-stat">
          <span>Gateways</span>
          <strong>{gateways.length}</strong>
        </div>
        <div className="sidebar-note">
          <ShieldCheck size={18} />
          <span>Local encrypted key vault</span>
        </div>

        <button
          className="theme-toggle"
          type="button"
          onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          aria-label="Toggle theme"
        >
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
        </button>
      </aside>

      <section className="content">
        <header className="topbar">
          <div className="hero-copy">
            <p className="eyebrow">OpenAI-compatible proxy</p>
            <h1 className="matrix-title">Route keys. Hold uptime. Spend with precision.</h1>
            <p className="hero-subline">A local control plane for provider keys, live credit checks, and OpenAI-style clients.</p>
          </div>
          <div className="hero-metrics" aria-label="Gateway summary">
            <div>
              <Sparkles size={17} />
              <span>{providers.length || "..."} companies</span>
            </div>
            <div>
              <ShieldCheck size={17} />
              <span>{gateways.length} gateway{gateways.length === 1 ? "" : "s"}</span>
            </div>
          </div>
        </header>

        {error && (
          <div className="alert" role="alert">
            <CircleAlert size={18} />
            {error}
          </div>
        )}

        <section className="workspace-grid" id="builder">
          <div className="panel provider-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Company</p>
                <h2>Select company</h2>
              </div>
              <div className="search-box">
                <Search size={16} />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" />
              </div>
            </div>

            <div className="provider-grid">
              {filteredProviders.map((provider) => {
                const selected = provider.id === selectedProviderId;
                const endpoint = detectEndpointProvider(provider.defaultBaseUrl, provider.defaultEndpointProviderId);
                return (
                  <button
                    className={`provider-tile ${selected ? "selected" : ""}`}
                    key={provider.id}
                    onClick={() => setSelectedProviderId(provider.id)}
                    type="button"
                  >
                    <span className="provider-icon">{provider.shortName.slice(0, 2).toUpperCase()}</span>
                    <span>
                      <strong>{provider.name}</strong>
                      <small>
                        {provider.compatibility.replace("-", " ")} · via {endpoint.shortName}
                      </small>
                    </span>
                    {selected && <Check size={17} />}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="panel setup-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Gateway</p>
                <h2>Keys and policy</h2>
              </div>
              <div className="stepper">
                <button type="button" onClick={() => setAccountCount(Math.max(1, accountCount - 1))} aria-label="Remove key">
                  <Trash2 size={15} />
                </button>
                <span>{accountCount}</span>
                <button type="button" onClick={() => setAccountCount(Math.min(20, accountCount + 1))} aria-label="Add key">
                  <Plus size={15} />
                </button>
              </div>
            </div>

            <label className="field">
              <span>Name</span>
              <input value={gatewayName} onChange={(event) => setGatewayName(event.target.value)} />
            </label>

            <div className="policy-row">
              {policies.map((policy) => {
                const Icon = strategyIcon[policy.id];
                return (
                  <button
                    key={policy.id}
                    type="button"
                    className={`policy-button ${strategy === policy.id ? "selected" : ""}`}
                    onClick={() => setStrategy(policy.id)}
                    title={policy.description}
                  >
                    <Icon size={18} />
                    <span>{policy.name}</span>
                    {strategy === policy.id && <Check size={20} />}
                  </button>
                );
              })}
            </div>

            {failover && (
              <>
                <div className="toggle-grid">
                  <label>
                    <input
                      type="checkbox"
                      checked={failover.switchOnLowBalance}
                      onChange={(event) => setFailover({ ...failover, switchOnLowBalance: event.target.checked })}
                    />
                    Low balance
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={failover.switchOnRateLimit}
                      onChange={(event) => setFailover({ ...failover, switchOnRateLimit: event.target.checked })}
                    />
                    Rate limit
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={failover.switchOnServerError}
                      onChange={(event) => setFailover({ ...failover, switchOnServerError: event.target.checked })}
                    />
                    5xx error
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={failover.switchOnNetworkError}
                      onChange={(event) => setFailover({ ...failover, switchOnNetworkError: event.target.checked })}
                    />
                    Network
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={failover.switchOnAuthError}
                      onChange={(event) => setFailover({ ...failover, switchOnAuthError: event.target.checked })}
                    />
                    Auth error
                  </label>
                </div>
                <div className="failover-config-row">
                  <label className="field compact">
                    <span>Floor USD</span>
                    <input
                      value={(failover.lowBalanceCents / 100).toFixed(2)}
                      onChange={(event) => setFailover({ ...failover, lowBalanceCents: centsFromUsd(event.target.value) ?? 0 })}
                    />
                  </label>
                  <label className="field compact">
                    <span>Retries</span>
                    <input
                      type="number"
                      min={0}
                      max={10}
                      value={failover.maxRetries}
                      onChange={(event) => setFailover({ ...failover, maxRetries: Number(event.target.value) })}
                    />
                  </label>
                </div>
              </>
            )}

            <div className="account-table">
              {accounts.map((account, index) => {
                const endpoint = detectEndpointProvider(
                  account.baseUrl || selectedProvider?.defaultBaseUrl,
                  selectedProvider?.defaultEndpointProviderId
                );
                return (
                  <div className="account-row" key={index}>
                    <input value={account.label} onChange={(event) => updateAccount(index, { label: event.target.value })} aria-label="Key label" />
                    <input
                      value={account.apiKey}
                      onChange={(event) => updateAccount(index, { apiKey: event.target.value })}
                      placeholder="API key"
                      type="password"
                      aria-label="Endpoint API key"
                    />
                    {endpoint.balance.mode === "api" ? (
                      <span className="balance-mode-pill" title={endpoint.balance.note}>
                        Live
                      </span>
                    ) : (
                      <input
                        value={account.estimatedBalanceUsd}
                        onChange={(event) => updateAccount(index, { estimatedBalanceUsd: event.target.value })}
                        placeholder="Local USD"
                        inputMode="decimal"
                        aria-label="Optional local balance"
                        title="Optional local starting balance for endpoints without live balance APIs"
                      />
                    )}
                    <input
                      value={account.baseUrl}
                      onChange={(event) => updateAccount(index, { baseUrl: event.target.value })}
                      placeholder={selectedProvider?.defaultBaseUrl || "Custom base URL"}
                      aria-label="Custom base URL"
                    />
                    <span className="endpoint-pill" title={endpoint.balance.note}>
                      {selectedProvider?.shortName ?? "Company"} via {endpoint.shortName}
                    </span>
                  </div>
                );
              })}
            </div>

            <button className="primary-button" type="button" disabled={busy || !selectedProvider} onClick={submitGateway}>
              <Zap size={18} />
              Create owner API
            </button>
          </div>
        </section>

        {selectedProvider && (
          <section className="provider-detail">
            <div>
              <p className="eyebrow">Selected</p>
              <h2>{selectedProvider.name}</h2>
              <p>{selectedProvider.note}</p>
            </div>
            <div className="feature-cloud">
              {selectedProvider.features.map((feature) => (
                <span key={feature}>{featureLabels[feature]}</span>
              ))}
            </div>
          </section>
        )}

        <section className="workspace-grid lower" id="gateways">
          <div className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Gateway &amp; accounts</p>
                <h2>Runtime status</h2>
              </div>
              <button type="button" className="icon-button" onClick={handleRefreshAll} disabled={refreshing} aria-label="Refresh gateways" title="Refresh gateways">
                <RefreshCw size={18} className={refreshing ? "spin" : ""} />
              </button>
            </div>

            <div className="gateway-list">
              {gateways.length === 0 && <p className="muted">No gateway yet.</p>}
              {gateways.map((gateway) => {
                const provider = providers.find((item) => item.id === (gateway.modelCompanyId ?? gateway.providerId));
                const activeCount = gateway.accounts.filter((account) => account.status === "active").length;
                return (
                  <div className="gateway-entry" key={gateway.id}>
                    <button
                      type="button"
                      className={`gateway-item ${gateway.id === selectedGateway?.id ? "selected" : ""}`}
                      onClick={() => setSelectedGatewayId(gateway.id)}
                    >
                    <span>
                      <strong>{gateway.name}</strong>
                      <small>
                        {provider?.shortName || gateway.modelCompanyId || gateway.providerId} · {activeCount}/{gateway.accounts.length} active
                      </small>
                    </span>
                      <ChevronRight size={17} />
                    </button>
                    <button
                      className="icon-button danger"
                      type="button"
                      onClick={() => removeGateway(gateway)}
                      disabled={busy}
                      aria-label={`Delete ${gateway.name}`}
                      title="Delete gateway"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Accounts</p>
                <h2>{selectedGateway?.name || "No gateway selected"}</h2>
                {balanceRefreshedAt && <small className="runtime-refresh">Updated {balanceRefreshedAt}</small>}
              </div>
              {selectedGateway && (
                <div className="panel-actions">
                  <button className="ghost-button" type="button" onClick={() => runGatewayDiagnostics(selectedGateway)} disabled={checkingDiagnostics}>
                    <TestTube2 size={16} />
                    {checkingDiagnostics ? "Checking" : "Run checks"}
                  </button>
                  <button className="ghost-button" type="button" onClick={() => rotateKey(selectedGateway)}>
                    <KeyRound size={16} />
                    Rotate
                  </button>
                </div>
              )}
            </div>

            <div className="balance-list">
              {balances.length === 0 && <p className="muted">Balance snapshots appear after selecting a gateway.</p>}
              {balances.map((balance) => (
                <div className={`balance-row ${balance.balanceState.includes("unavailable") ? "balance-warning" : ""}`} key={balance.accountId}>
                  <span className={`status-dot ${balance.shouldSkip || balance.balanceState.includes("unavailable") ? "warn" : ""}`} />
                  <span>
                    <strong>{balance.label}</strong>
                    <small>{balance.message}</small>
                  </span>
                  <strong>
                    {formatUsd(balance.estimatedBalanceCents)}
                    <small>{balanceStateLabel(balance)}</small>
                  </strong>
                  {selectedGateway && (
                    <button
                      className="icon-button danger compact-icon"
                      type="button"
                      onClick={() => removeGatewayAccount(selectedGateway, balance.accountId)}
                      disabled={busy}
                      aria-label={`Delete ${balance.label}`}
                      title="Delete account"
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              ))}
            </div>

            {diagnostics && (
              <div className="diagnostic-grid">
                <div className="diagnostic-summary">
                  <span>Routing health</span>
                  <strong>
                    {diagnostics.healthyAccounts}/{diagnostics.totalAccounts}
                  </strong>
                </div>
                {diagnostics.accounts.map((account) => (
                  <div className={`diagnostic-item ${account.status}`} key={account.accountId}>
                    <span>{account.endpointProviderName}</span>
                    <strong>{account.authStatus}</strong>
                    <small>{account.message}</small>
                  </div>
                ))}
              </div>
            )}

            {selectedGateway && (
              <div className="policy-row runtime-policy">
                {policies.map((policy) => {
                  const Icon = strategyIcon[policy.id];
                  return (
                    <button
                      key={policy.id}
                      type="button"
                      className={`policy-button ${selectedGateway.strategy === policy.id ? "selected" : ""}`}
                      onClick={() => saveGatewayPolicy(selectedGateway, policy.id)}
                    >
                      <Icon size={18} />
                      <span>{policy.name}</span>
                      {selectedGateway.strategy === policy.id && <Check size={20} />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <section className="integration-band" id="integration">
          <div>
            <p className="eyebrow">Integration</p>
            <h2>Generated connection</h2>
          </div>
          <div className="owner-check">
            <label className="field">
              <span>Owner key test</span>
              <input
                value={ownerKeyProbe}
                onChange={(event) => setOwnerKeyProbe(event.target.value)}
                placeholder="Paste aigw_... owner key"
                type="password"
              />
            </label>
            <button className="ghost-button" type="button" onClick={verifyOwnerKey} disabled={busy}>
              <ShieldCheck size={16} />
              Verify owner key
            </button>
            {ownerKeyCheck && (
              <p className={`owner-check-result ${ownerKeyCheck.valid ? "pass" : "fail"}`}>
                {ownerKeyCheck.message}
              </p>
            )}
          </div>
          {!connectionGateway && <p className="muted">Create a gateway to generate a local owner API key.</p>}
          {connectionGateway && (
            <div className="connection-grid">
              <div className="secret-box">
                <span>Base URL</span>
                <code>{connectionBaseUrl}</code>
                <button onClick={() => copyText(connectionBaseUrl)} aria-label="Copy base URL" title="Copy base URL">
                  <Copy size={16} />
                </button>
              </div>
              <div className="secret-box">
                <span>Owner API key</span>
                <code>{hasFreshOwnerKey ? connectionOwnerKey : `${connectionGateway.ownerKeyPreview} (preview only)`}</code>
                {hasFreshOwnerKey ? (
                  <button onClick={() => copyText(connectionOwnerKey)} aria-label="Copy owner API key" title="Copy owner API key">
                    <Copy size={16} />
                  </button>
                ) : (
                  <button onClick={() => rotateKey(connectionGateway)} aria-label="Rotate and reveal owner key" title="Rotate and reveal new owner key">
                    <KeyRound size={16} />
                  </button>
                )}
                {!hasFreshOwnerKey && <small className="secret-help">Full key is shown only once. Rotate to reveal a new key.</small>}
              </div>
              <CodeBlock title="OpenAI SDK" code={openAiSnippet} />
              <CodeBlock title="Vercel AI SDK" code={vercelSnippet} />
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

function CodeBlock({ title, code }: { title: string; code: string }) {
  return (
    <div className="code-block">
      <div>
        <span>{title}</span>
        <button onClick={() => copyText(code)} aria-label={`Copy ${title}`} title={`Copy ${title}`}>
          <Copy size={15} />
        </button>
      </div>
      <pre>{code}</pre>
    </div>
  );
}
