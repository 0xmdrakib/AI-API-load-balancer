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
  X,
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
  fetchRuntime,
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
  ProviderFeature,
  RuntimeMetadata,
  GatewayCreateResponse
} from "../shared/types";
import { MAX_ACCOUNTS_PER_GATEWAY, MAX_FAILOVER_RETRIES } from "../shared/constants";

interface AccountDraft {
  label: string;
  apiKey: string;
  baseUrl: string;
  estimatedBalanceUsd: string;
  balanceFloorUsd: string;
  weight: number;
  priority: number;
}

type DesktopBridge = {
  onBackendState?: (listener: (state: { state: string }) => void) => () => void;
  openLogs?: () => Promise<string>;
};

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
  const [accounts, setAccounts] = useState<AccountDraft[]>([]);
  const [accountPage, setAccountPage] = useState(1);
  const [accountDrawerIndex, setAccountDrawerIndex] = useState<number | null>(null);
  const [createResult, setCreateResult] = useState<GatewayCreateResponse | null>(null);
  const [runtime, setRuntime] = useState<RuntimeMetadata | null>(null);
  const [activeSdk, setActiveSdk] = useState<"openai" | "anthropic">("openai");
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null);
  const [bootstrapLoading, setBootstrapLoading] = useState(true);
  const [desktopBackendState, setDesktopBackendState] = useState<string>("ready");
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

  useEffect(() => {
    const desktop = (window as Window & { gatewayDesktop?: DesktopBridge }).gatewayDesktop;
    return desktop?.onBackendState?.((state) => setDesktopBackendState(state.state));
  }, []);

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
        setAccounts([makeAccountDraft(0, initialProvider)]);
      })
      .catch((caught) => setError(caught.message));
    Promise.all([refreshGateways(), fetchRuntime().then(setRuntime)])
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load the local gateway"))
      .finally(() => setBootstrapLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedProvider) return;
    setAccounts((current) => current.map((account, index) => ({
        ...account,
        priority: account.priority || index + 1,
        baseUrl: selectedProvider.setupFields?.some((field) => field.key === "baseUrl") ? account.baseUrl || selectedProvider.defaultBaseUrl : account.baseUrl
      })));
  }, [selectedProvider]);

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
        loadBalances(false);
      }
    }, 15_000);

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

  function addAccountDraft() {
    if (accounts.length >= MAX_ACCOUNTS_PER_GATEWAY) return;
    const nextIndex = accounts.length;
    setAccounts((current) => [...current, makeAccountDraft(nextIndex, selectedProvider)]);
    setAccountPage(Math.floor(nextIndex / 10) + 1);
    setAccountDrawerIndex(nextIndex);
  }

  function removeAccountDraft(index: number) {
    if (accounts.length === 1) {
      setAccounts([makeAccountDraft(0, selectedProvider)]);
      setAccountDrawerIndex(null);
      return;
    }
    setAccounts((current) => current.filter((_, accountIndex) => accountIndex !== index).map((account, accountIndex) => ({
      ...account,
      priority: Math.min(account.priority, accountIndex + 1)
    })));
    setAccountDrawerIndex(null);
    setAccountPage((page) => Math.min(page, Math.ceil((accounts.length - 1) / 10)));
  }

  async function copyWithFeedback(value: string, label: string) {
    await copyText(value);
    setCopiedLabel(label);
    window.setTimeout(() => setCopiedLabel((current) => current === label ? null : current), 1800);
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
    if (!window.confirm(`Rotate the owner key for ${gateway.name}? The current owner key will stop working immediately.`)) return;
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
    if (!window.confirm(`Delete ${gateway.name}? The encrypted account configuration will be removed from the active store.`)) return;
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
    const account = gateway.accounts.find((item) => item.id === accountId);
    if (!window.confirm(`Remove ${account?.label ?? "this account"} from ${gateway.name}?`)) return;
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
  const fallbackRoot = window.location.origin;
  const connectionBaseUrls = hasFreshOwnerKey
    ? createResult!.baseUrls
    : runtime?.baseUrls ?? { openai: `${fallbackRoot}/v1`, anthropic: fallbackRoot };
  const connectionOwnerKey = hasFreshOwnerKey ? createResult!.ownerApiKey : "YOUR_OWNER_API_KEY";

  const openAiSnippet = connectionGateway
    ? `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.AI_GATEWAY_API_KEY,
  baseURL: process.env.AI_GATEWAY_OPENAI_BASE_URL ?? "${connectionBaseUrls.openai}"
});

const result = await client.chat.completions.create({
  model: "your-model-id",
  messages: [{ role: "user", content: "Hello" }],
  stream: true
});`
    : "";

  const anthropicSnippet = connectionGateway
    ? `import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.AI_GATEWAY_API_KEY,
  baseURL: process.env.AI_GATEWAY_ANTHROPIC_BASE_URL ?? "${connectionBaseUrls.anthropic}"
});

const result = await client.messages.create({
  model: "your-model-id",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello" }],
  stream: true
});`
    : "";

  const accountPageCount = Math.max(1, Math.ceil(accounts.length / 10));
  const visibleAccountEntries = accounts
    .map((account, index) => ({ account, index }))
    .slice((accountPage - 1) * 10, accountPage * 10);
  const drawerAccount = accountDrawerIndex === null ? null : accounts[accountDrawerIndex];

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Gateway navigation">
        <div className="brand">
          <div className="brand-mark">
            <img src="/logo.png" alt="AI Load Balancer" />
          </div>
          <div>
            <strong className="dot-type">AI Load Balancer</strong>
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
            <span>{error}</span>
            <button type="button" onClick={() => { setError(null); void handleRefreshAll(); }}>Retry</button>
          </div>
        )}

        {desktopBackendState !== "ready" && (
          <div className="alert backend-alert" role="status">
            <RefreshCw size={18} className={desktopBackendState === "restarting" ? "spin" : ""} />
            <span>The isolated backend is {desktopBackendState}. The dashboard and saved configuration remain available.</span>
            <button type="button" onClick={() => (window as Window & { gatewayDesktop?: DesktopBridge }).gatewayDesktop?.openLogs?.()}>Open log</button>
          </div>
        )}

        {runtime && runtime.store.state !== "ready" && (
          <div className="alert store-alert" role="status">
            <ShieldCheck size={18} />
            <span>{runtime.store.message}</span>
          </div>
        )}

        {bootstrapLoading && (
          <div className="loading-skeleton" aria-label="Loading local gateway">
            <span />
            <span />
            <span />
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
              <div className="account-counter">
                <span>{accounts.length}/{MAX_ACCOUNTS_PER_GATEWAY}</span>
                <button className="ghost-button" type="button" onClick={addAccountDraft} disabled={accounts.length >= MAX_ACCOUNTS_PER_GATEWAY}>
                  <Plus size={15} />
                  Add API key
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
                    {strategy === policy.id && <Check className="policy-selected-check" size={16} />}
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
                      max={MAX_FAILOVER_RETRIES}
                      value={failover.maxRetries}
                      onChange={(event) => setFailover({ ...failover, maxRetries: Math.min(MAX_FAILOVER_RETRIES, Math.max(0, Number(event.target.value))) })}
                    />
                  </label>
                </div>
              </>
            )}

            <div className="account-table premium-account-list">
              <div className="account-list-head">
                <span>Account</span>
                <span>Endpoint</span>
                <span>Balance</span>
                <span>Actions</span>
              </div>
              {visibleAccountEntries.map(({ account, index }) => {
                const endpoint = detectEndpointProvider(
                  account.baseUrl || selectedProvider?.defaultBaseUrl,
                  selectedProvider?.defaultEndpointProviderId
                );
                return (
                  <div className="account-row premium-account-row" key={index}>
                    <span className="account-identity">
                      <strong>{account.label || `Key ${index + 1}`}</strong>
                      <small>{account.apiKey ? "Key added ••••" : "API key required"}</small>
                    </span>
                    <span className="endpoint-pill" title={account.baseUrl || selectedProvider?.defaultBaseUrl}>
                      {endpoint.shortName}
                    </span>
                    <span className="balance-mode-pill" title={endpoint.balance.note}>
                      {endpoint.balance.mode === "api" ? "Live" : account.estimatedBalanceUsd ? `$${account.estimatedBalanceUsd}` : "Local"}
                    </span>
                    <span className="account-actions">
                      <button className="icon-button" type="button" onClick={() => setAccountDrawerIndex(index)} aria-label={`Edit ${account.label}`} title="Edit account">
                        <ServerCog size={15} />
                      </button>
                      <button className="icon-button danger" type="button" onClick={() => removeAccountDraft(index)} aria-label={`Remove ${account.label}`} title="Remove account">
                        <Trash2 size={15} />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>

            {accountPageCount > 1 && (
              <div className="pagination" aria-label="Account pages">
                <button type="button" onClick={() => setAccountPage((page) => Math.max(1, page - 1))} disabled={accountPage === 1}>Previous</button>
                <span>Page {accountPage} of {accountPageCount}</span>
                <button type="button" onClick={() => setAccountPage((page) => Math.min(accountPageCount, page + 1))} disabled={accountPage === accountPageCount}>Next</button>
              </div>
            )}

            <button className="primary-button" type="button" disabled={busy || !selectedProvider} onClick={submitGateway}>
              <Zap size={18} />
              Create owner API
            </button>

            {drawerAccount && accountDrawerIndex !== null && (
              <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => {
                if (event.currentTarget === event.target) setAccountDrawerIndex(null);
              }}>
                <section className="account-drawer" role="dialog" aria-modal="true" aria-labelledby="account-drawer-title">
                  <div className="panel-heading drawer-heading">
                    <div>
                      <p className="eyebrow">Provider account {accountDrawerIndex + 1}</p>
                      <h2 id="account-drawer-title">Add API key</h2>
                    </div>
                    <button className="icon-button" type="button" onClick={() => setAccountDrawerIndex(null)} aria-label="Close account editor">
                      <X size={18} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  </div>
                  <label className="field">
                    <span>Account label</span>
                    <input autoFocus value={drawerAccount.label} onChange={(event) => updateAccount(accountDrawerIndex, { label: event.target.value })} />
                  </label>
                  <label className="field">
                    <span>Provider API key</span>
                    <input value={drawerAccount.apiKey} onChange={(event) => updateAccount(accountDrawerIndex, { apiKey: event.target.value })} placeholder="Stored encrypted on this device" type="password" />
                  </label>
                  <label className="field">
                    <span>Upstream base URL</span>
                    <input value={drawerAccount.baseUrl} onChange={(event) => updateAccount(accountDrawerIndex, { baseUrl: event.target.value })} placeholder={selectedProvider?.defaultBaseUrl || "https://…"} />
                  </label>
                  <div className="drawer-field-grid">
                    <label className="field">
                      <span>Local balance USD</span>
                      <input value={drawerAccount.estimatedBalanceUsd} onChange={(event) => updateAccount(accountDrawerIndex, { estimatedBalanceUsd: event.target.value })} inputMode="decimal" placeholder="Optional" />
                    </label>
                    <label className="field">
                      <span>Balance floor USD</span>
                      <input value={drawerAccount.balanceFloorUsd} onChange={(event) => updateAccount(accountDrawerIndex, { balanceFloorUsd: event.target.value })} inputMode="decimal" />
                    </label>
                    <label className="field">
                      <span>Weight</span>
                      <input type="number" min={1} max={100} value={drawerAccount.weight} onChange={(event) => updateAccount(accountDrawerIndex, { weight: Number(event.target.value) })} />
                    </label>
                    <label className="field">
                      <span>Priority</span>
                      <input type="number" min={1} max={100} value={drawerAccount.priority} onChange={(event) => updateAccount(accountDrawerIndex, { priority: Number(event.target.value) })} />
                    </label>
                  </div>
                  <div className="drawer-actions">
                    <button className="ghost-button" type="button" onClick={() => removeAccountDraft(accountDrawerIndex)}>Remove</button>
                    <button className="primary-button" type="button" onClick={() => setAccountDrawerIndex(null)} disabled={!drawerAccount.apiKey.trim()}>Save account</button>
                  </div>
                </section>
              </div>
            )}
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
                      {selectedGateway.strategy === policy.id && <Check className="policy-selected-check" size={16} />}
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
                <span>OpenAI base URL</span>
                <code>{connectionBaseUrls.openai}</code>
                <button onClick={() => copyWithFeedback(connectionBaseUrls.openai, "OpenAI URL")} aria-label="Copy OpenAI base URL" title="Copy OpenAI base URL">
                  {copiedLabel === "OpenAI URL" ? <Check size={16} /> : <Copy size={16} />}
                </button>
              </div>
              <div className="secret-box">
                <span>Anthropic base URL</span>
                <code>{connectionBaseUrls.anthropic}</code>
                <button onClick={() => copyWithFeedback(connectionBaseUrls.anthropic, "Anthropic URL")} aria-label="Copy Anthropic base URL" title="Copy Anthropic base URL">
                  {copiedLabel === "Anthropic URL" ? <Check size={16} /> : <Copy size={16} />}
                </button>
              </div>
              <div className="secret-box owner-secret-box">
                <span>Owner API key</span>
                <code>{hasFreshOwnerKey ? connectionOwnerKey : `${connectionGateway.ownerKeyPreview} (preview only)`}</code>
                {hasFreshOwnerKey ? (
                  <button onClick={() => copyWithFeedback(connectionOwnerKey, "Owner key")} aria-label="Copy owner API key" title="Copy owner API key">
                    {copiedLabel === "Owner key" ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                ) : (
                  <button onClick={() => rotateKey(connectionGateway)} aria-label="Rotate and reveal owner key" title="Rotate and reveal new owner key">
                    <KeyRound size={16} />
                  </button>
                )}
                {!hasFreshOwnerKey && <small className="secret-help">Full key is shown only once. Rotate to reveal a new key.</small>}
              </div>
              <div className="sdk-panel">
                <div className="sdk-tabs" role="tablist" aria-label="SDK examples">
                  <button type="button" role="tab" aria-selected={activeSdk === "openai"} className={activeSdk === "openai" ? "active" : ""} onClick={() => setActiveSdk("openai")}>OpenAI SDK</button>
                  <button type="button" role="tab" aria-selected={activeSdk === "anthropic"} className={activeSdk === "anthropic" ? "active" : ""} onClick={() => setActiveSdk("anthropic")}>Anthropic SDK</button>
                </div>
                <CodeBlock
                  title={activeSdk === "openai" ? "OpenAI SDK" : "Anthropic SDK"}
                  code={activeSdk === "openai" ? openAiSnippet : anthropicSnippet}
                  copied={copiedLabel === `${activeSdk} SDK`}
                  onCopy={() => copyWithFeedback(activeSdk === "openai" ? openAiSnippet : anthropicSnippet, `${activeSdk} SDK`)}
                />
              </div>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

function CodeBlock({ title, code, copied, onCopy }: { title: string; code: string; copied?: boolean; onCopy?: () => void }) {
  return (
    <div className="code-block">
      <div>
        <span>{title}</span>
        <button onClick={onCopy ?? (() => copyText(code))} aria-label={`Copy ${title}`} title={`Copy ${title}`}>
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </button>
      </div>
      <pre>{code}</pre>
    </div>
  );
}
