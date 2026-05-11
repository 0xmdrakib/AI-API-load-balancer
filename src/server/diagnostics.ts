import { detectEndpointProvider } from "../shared/providers.js";
import type {
  AccountDiagnostic,
  BalanceSnapshot,
  GatewayDiagnostics,
  GatewayStored,
  ModelCompanyDefinition,
  ProviderAccountStored
} from "../shared/types.js";
import { decryptSecret } from "./crypto.js";
import { balanceSnapshots, refreshLiveBalances } from "./balance.js";
import { getEligibleAccounts } from "./selector.js";

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function accountBaseUrl(modelCompany: ModelCompanyDefinition, account: ProviderAccountStored) {
  return account.baseUrl || modelCompany.defaultBaseUrl;
}

function modelsUrl(modelCompany: ModelCompanyDefinition, account: ProviderAccountStored) {
  return `${trimTrailingSlash(accountBaseUrl(modelCompany, account))}/models`;
}

function validationHeaders(account: ProviderAccountStored, endpointAuthType: "bearer" | "x-api-key" | "custom") {
  const apiKey = decryptSecret(account.encryptedApiKey);
  const headers: Record<string, string> = {
    accept: "application/json",
    ...account.customHeaders
  };

  if (endpointAuthType === "x-api-key") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = account.customHeaders?.["anthropic-version"] ?? "2023-06-01";
  } else {
    headers.authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

async function validateModelsEndpoint(modelCompany: ModelCompanyDefinition, account: ProviderAccountStored) {
  const endpointProvider = detectEndpointProvider(accountBaseUrl(modelCompany, account), modelCompany.defaultEndpointProviderId);

  try {
    const response = await fetch(modelsUrl(modelCompany, account), {
      method: "GET",
      headers: validationHeaders(account, endpointProvider.authType),
      signal: AbortSignal.timeout(5000)
    });

    if (response.ok) return { authStatus: "valid" as const, message: `${endpointProvider.name} accepted the key.` };
    if (response.status === 401 || response.status === 403) {
      return { authStatus: "invalid" as const, message: `${endpointProvider.name} rejected the key.` };
    }
    if (response.status === 404 || response.status === 405) {
      return {
        authStatus: "unknown" as const,
        message: `${endpointProvider.name} does not expose a compatible /models validation endpoint.`
      };
    }
    return {
      authStatus: "unknown" as const,
      message: `${endpointProvider.name} validation returned HTTP ${response.status}.`
    };
  } catch (error) {
    return {
      authStatus: "unknown" as const,
      message: error instanceof Error ? `Validation network error: ${error.message}` : "Validation network error."
    };
  }
}

function apiBalanceAuthStatus(snapshot: BalanceSnapshot) {
  if (snapshot.balanceState === "live" || snapshot.balanceState === "cached") return "valid" as const;
  if (snapshot.balanceState === "auth-unavailable") return "invalid" as const;
  return "unknown" as const;
}

function diagnosticMessage(
  snapshot: BalanceSnapshot,
  authStatus: "valid" | "invalid" | "unknown",
  authMessage: string,
  routingEligible: boolean
) {
  if (!routingEligible && snapshot.shouldSkip) return `${snapshot.message} This key is skipped by low-balance policy.`;
  if (!routingEligible) return `${authMessage} This key is not currently eligible for routing.`;
  if (authStatus === "invalid") return `${authMessage} Requests will fail over if auth-error failover is enabled.`;
  return authMessage;
}

function statusFor(snapshot: BalanceSnapshot, authStatus: "valid" | "invalid" | "unknown", routingEligible: boolean) {
  if (authStatus === "invalid") return "fail" as const;
  if (!routingEligible || snapshot.balanceState === "auth-unavailable" || snapshot.balanceState === "unavailable") return "warn" as const;
  if (authStatus === "valid" || snapshot.balanceState === "live" || snapshot.balanceState === "cached") return "pass" as const;
  return "warn" as const;
}

export async function buildGatewayDiagnostics(
  gateway: GatewayStored,
  modelCompany: ModelCompanyDefinition,
  options: { forceBalance?: boolean } = {}
): Promise<{ gateway: GatewayStored; diagnostics: GatewayDiagnostics }> {
  const refreshedGateway = await refreshLiveBalances(gateway, modelCompany, { force: options.forceBalance });
  const snapshots = balanceSnapshots(refreshedGateway, modelCompany);
  const eligibleIds = new Set(getEligibleAccounts(refreshedGateway).map((account) => account.id));
  const checkedAt = new Date().toISOString();

  const accounts = await Promise.all(
    refreshedGateway.accounts.map(async (account): Promise<AccountDiagnostic> => {
      const endpointProvider = detectEndpointProvider(accountBaseUrl(modelCompany, account), modelCompany.defaultEndpointProviderId);
      const snapshot = snapshots.find((item) => item.accountId === account.id)!;
      const routingEligible = eligibleIds.has(account.id);
      const canCheckLiveBalance = endpointProvider.balance.mode === "api";

      const auth =
        canCheckLiveBalance
          ? {
              authStatus: apiBalanceAuthStatus(snapshot),
              message:
                snapshot.balanceState === "auth-unavailable"
                  ? snapshot.message
                  : snapshot.balanceState === "live" || snapshot.balanceState === "cached"
                    ? `${endpointProvider.name} accepted the key and live credits are available.`
                    : snapshot.message
            }
          : await validateModelsEndpoint(modelCompany, account);

      return {
        accountId: account.id,
        label: account.label,
        status: statusFor(snapshot, auth.authStatus, routingEligible),
        endpointProviderId: endpointProvider.id,
        endpointProviderName: endpointProvider.name,
        authStatus: auth.authStatus,
        balanceState: snapshot.balanceState,
        routingEligible,
        canCheckLiveBalance,
        checkedAt,
        message: diagnosticMessage(snapshot, auth.authStatus, auth.message, routingEligible)
      };
    })
  );

  return {
    gateway: refreshedGateway,
    diagnostics: {
      gatewayId: refreshedGateway.id,
      gatewayName: refreshedGateway.name,
      modelCompanyId: refreshedGateway.modelCompanyId,
      checkedAt,
      ownerKeyPreview: refreshedGateway.ownerKeyPreview,
      healthyAccounts: accounts.filter((account) => account.routingEligible && account.authStatus !== "invalid").length,
      totalAccounts: accounts.length,
      accounts
    }
  };
}
