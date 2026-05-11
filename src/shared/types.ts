export type ProviderFeature =
  | "openai-compatible"
  | "native-adapter"
  | "chat"
  | "responses"
  | "streaming"
  | "tools"
  | "structured-output"
  | "vision"
  | "embeddings"
  | "image-generation"
  | "web-search"
  | "reasoning"
  | "rerank"
  | "audio";

export type ProviderCompatibility = "openai-compatible" | "native-adapter" | "custom-base";

export type ProviderBalanceMode = "api" | "estimated" | "manual";
export type BalanceCheckState = "live" | "cached" | "auth-unavailable" | "unavailable" | "estimated" | "manual" | "unset";

export interface ModelCompanyDefinition {
  id: string;
  name: string;
  shortName: string;
  defaultBaseUrl: string;
  defaultEndpointProviderId: string;
  compatibility: ProviderCompatibility;
  docsUrl: string;
  features: ProviderFeature[];
  note: string;
  setupFields?: Array<{
    key: string;
    label: string;
    placeholder: string;
    required?: boolean;
  }>;
  estimatedCentsPer1KTokens: number;
}

export interface EndpointProviderDefinition {
  id: string;
  name: string;
  shortName: string;
  defaultBaseUrl: string;
  compatibility: ProviderCompatibility;
  authType: "bearer" | "x-api-key" | "custom";
  docsUrl: string;
  match: {
    hosts: string[];
    pathIncludes?: string[];
  };
  balance: {
    mode: ProviderBalanceMode;
    label: string;
    note: string;
  };
  estimatedCentsPer1KTokens: number;
}

export type ProviderDefinition = ModelCompanyDefinition;

export type AccountStatus = "active" | "paused" | "cooldown" | "exhausted" | "invalid";

export interface ProviderAccountPublic {
  id: string;
  label: string;
  apiKeyPreview: string;
  baseUrl?: string;
  status: AccountStatus;
  estimatedBalanceCents?: number;
  balanceFloorCents?: number;
  spentCents: number;
  weight: number;
  priority: number;
  requestCount: number;
  lastUsedAt?: string;
  lastError?: string;
  lastBalanceStatus?: "live" | "auth-unavailable" | "unavailable";
  lastBalanceError?: string;
  lastBalanceCheckedAt?: string;
  cooldownUntil?: string;
  latencyMs?: number;
  customHeaders?: Record<string, string>;
}

export interface ProviderAccountStored extends ProviderAccountPublic {
  encryptedApiKey: string;
}

export type LoadBalancingStrategy =
  | "priority-failover"
  | "round-robin"
  | "weighted"
  | "least-used";

export interface FailoverOptions {
  switchOnLowBalance: boolean;
  lowBalanceCents: number;
  switchOnRateLimit: boolean;
  switchOnServerError: boolean;
  switchOnNetworkError: boolean;
  switchOnAuthError: boolean;
  cooldownSeconds: number;
  maxRetries: number;
}

export interface GatewayStored {
  id: string;
  name: string;
  modelCompanyId: string;
  providerId?: string;
  ownerKeyHash: string;
  ownerKeyPreview: string;
  strategy: LoadBalancingStrategy;
  failover: FailoverOptions;
  accounts: ProviderAccountStored[];
  lastRoundRobinIndex: number;
  createdAt: string;
  updatedAt: string;
}

export interface GatewayPublic extends Omit<GatewayStored, "ownerKeyHash" | "accounts"> {
  accounts: ProviderAccountPublic[];
}

export interface GatewayCreateInput {
  name: string;
  modelCompanyId: string;
  providerId?: string;
  strategy: LoadBalancingStrategy;
  failover: FailoverOptions;
  accounts: Array<{
    label: string;
    apiKey: string;
    baseUrl?: string;
    estimatedBalanceCents?: number;
    balanceFloorCents?: number;
    weight?: number;
    priority?: number;
    customHeaders?: Record<string, string>;
  }>;
}

export interface GatewayCreateResponse {
  gateway: GatewayPublic;
  ownerApiKey: string;
  baseUrl: string;
}

export interface GatewayStoreFile {
  version: 1;
  gateways: GatewayStored[];
}

export interface PolicyDefinition {
  id: LoadBalancingStrategy;
  name: string;
  description: string;
}

export interface BalanceSnapshot {
  accountId: string;
  label: string;
  mode: ProviderBalanceMode;
  endpointProviderId: string;
  endpointProviderName: string;
  status: AccountStatus;
  estimatedBalanceCents?: number;
  balanceFloorCents?: number;
  spentCents: number;
  shouldSkip: boolean;
  balanceState: BalanceCheckState;
  message: string;
}

export type DiagnosticStatus = "pass" | "warn" | "fail";

export interface AccountDiagnostic {
  accountId: string;
  label: string;
  status: DiagnosticStatus;
  endpointProviderId: string;
  endpointProviderName: string;
  authStatus: "valid" | "invalid" | "unknown";
  balanceState: BalanceCheckState;
  routingEligible: boolean;
  canCheckLiveBalance: boolean;
  checkedAt: string;
  message: string;
}

export interface GatewayDiagnostics {
  gatewayId: string;
  gatewayName: string;
  modelCompanyId: string;
  checkedAt: string;
  ownerKeyPreview: string;
  healthyAccounts: number;
  totalAccounts: number;
  accounts: AccountDiagnostic[];
}

export interface OwnerKeyCheckResult {
  valid: boolean;
  checkedAt: string;
  gateway?: Pick<GatewayPublic, "id" | "name" | "ownerKeyPreview" | "modelCompanyId"> & {
    accountCount: number;
  };
  message: string;
}
