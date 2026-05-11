import type {
  BalanceSnapshot,
  FailoverOptions,
  GatewayDiagnostics,
  GatewayCreateInput,
  GatewayCreateResponse,
  GatewayPublic,
  LoadBalancingStrategy,
  OwnerKeyCheckResult,
  EndpointProviderDefinition,
  ModelCompanyDefinition,
  PolicyDefinition,
} from "../shared/types";

export interface BootstrapResponse {
  providers: ModelCompanyDefinition[];
  modelCompanies: ModelCompanyDefinition[];
  endpointProviders: EndpointProviderDefinition[];
  policies: PolicyDefinition[];
  defaultFailover: FailoverOptions;
}

export async function fetchBootstrap() {
  return fetchJson<BootstrapResponse>("/api/providers");
}

export async function fetchGateways() {
  return fetchJson<{ gateways: GatewayPublic[] }>("/api/gateways");
}

export async function createGateway(input: GatewayCreateInput) {
  return fetchJson<GatewayCreateResponse>("/api/gateways", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

export async function patchGateway(id: string, input: { strategy?: LoadBalancingStrategy; failover?: Partial<FailoverOptions> }) {
  return fetchJson<{ gateway: GatewayPublic }>(`/api/gateways/${id}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

export async function deleteGateway(id: string) {
  await fetchJson<void>(`/api/gateways/${id}`, {
    method: "DELETE"
  });
}

export async function deleteGatewayAccount(gatewayId: string, accountId: string) {
  return fetchJson<{ gateway: GatewayPublic }>(`/api/gateways/${gatewayId}/accounts/${accountId}`, {
    method: "DELETE"
  });
}

export async function fetchBalances(id: string, refresh = false) {
  const query = refresh ? "?refresh=1" : "";
  return fetchJson<{ balances: BalanceSnapshot[]; modelCompany: ModelCompanyDefinition }>(`/api/gateways/${id}/balances${query}`);
}

export async function fetchGatewayDiagnostics(id: string) {
  return fetchJson<{ diagnostics: GatewayDiagnostics }>(`/api/gateways/${id}/diagnostics`, {
    method: "POST"
  });
}

export async function checkOwnerKey(ownerApiKey: string) {
  return fetchJson<OwnerKeyCheckResult>("/api/owner-key/check", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ ownerApiKey })
  });
}

export async function rotateOwnerKey(id: string) {
  return fetchJson<GatewayCreateResponse>(`/api/gateways/${id}/rotate-owner-key`, {
    method: "POST"
  });
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const fieldErrors = data?.error?.details?.fieldErrors as Record<string, string[]> | undefined;
    const formErrors = data?.error?.details?.formErrors as string[] | undefined;
    const detailMessage = fieldErrors
      ? Object.entries(fieldErrors)
          .flatMap(([field, errors]) => errors.map((error) => `${field}: ${error}`))
          .join("; ")
      : formErrors?.join("; ");
    const message = detailMessage || data?.error?.message || response.statusText;
    throw new Error(message);
  }
  return data as T;
}
