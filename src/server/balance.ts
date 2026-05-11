import type {
  BalanceCheckState,
  BalanceSnapshot,
  EndpointProviderDefinition,
  GatewayStored,
  ModelCompanyDefinition,
  ProviderAccountStored
} from "../shared/types.js";
import { decryptSecret } from "./crypto.js";
import { isLowBalance } from "./selector.js";
import { upsertGateway } from "./store.js";
import { detectEndpointProvider } from "../shared/providers.js";

type LiveCreditResult = {
  balanceCents?: number;
  totalUsedCents?: number;
};

const BALANCE_REFRESH_TTL_MS = 60_000;

class BalanceCheckError extends Error {
  constructor(
    message: string,
    readonly publicMessage: string,
    readonly reason: "auth-unavailable" | "unavailable"
  ) {
    super(message);
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function centsFromCreditValue(value: unknown) {
  const parsed = Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) return undefined;
  return Math.round(parsed * 100);
}

function accountBaseUrl(modelCompany: ModelCompanyDefinition, account: ProviderAccountStored) {
  return account.baseUrl || modelCompany.defaultBaseUrl;
}

function detectAccountEndpoint(modelCompany: ModelCompanyDefinition, account: ProviderAccountStored) {
  return detectEndpointProvider(accountBaseUrl(modelCompany, account), modelCompany.defaultEndpointProviderId);
}

function creditUrl(endpointProvider: EndpointProviderDefinition, baseUrl: string) {
  const parsed = new URL(trimTrailingSlash(baseUrl));
  if (endpointProvider.id === "vercel-ai-gateway") return `${parsed.origin}/v1/credits`;
  if (endpointProvider.id === "openrouter") return `${parsed.origin}/api/v1/credits`;
  return `${trimTrailingSlash(baseUrl)}/credits`;
}

function shortProviderAuthHint(endpointProvider: EndpointProviderDefinition) {
  if (endpointProvider.id === "vercel-ai-gateway") return "Use a Vercel AI Gateway API key for this endpoint.";
  if (endpointProvider.id === "openrouter") return "Use an OpenRouter API key for this endpoint.";
  return "Check the endpoint API key used for this account.";
}

function readableProviderError(status: number, text: string) {
  if (!text.trim()) return `HTTP ${status}`;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message || parsed.message;
    return message ? `HTTP ${status}: ${message}` : `HTTP ${status}`;
  } catch {
    return `HTTP ${status}`;
  }
}

function makeBalanceCheckError(endpointProvider: EndpointProviderDefinition, status: number, text: string) {
  const reason = status === 401 || status === 403 ? "auth-unavailable" : "unavailable";
  const publicMessage =
    reason === "auth-unavailable"
      ? `${endpointProvider.name} rejected the live credits check. ${shortProviderAuthHint(endpointProvider)}`
      : `${endpointProvider.name} live credits are temporarily unavailable; cached/local balance will be used.`;
  return new BalanceCheckError(readableProviderError(status, text), publicMessage, reason);
}

function withoutLegacyBalanceError(account: ProviderAccountStored) {
  if (!account.lastError || !/credits check failed|live check failed/i.test(account.lastError)) return account;
  return {
    ...account,
    lastError: undefined
  };
}

export function isVercelGatewayAccount(modelCompany: ModelCompanyDefinition, account: ProviderAccountStored) {
  return detectAccountEndpoint(modelCompany, account).id === "vercel-ai-gateway";
}

function hasFreshBalanceCheck(account: ProviderAccountStored, checkedAtMs: number) {
  if (!account.lastBalanceCheckedAt) return false;
  const previous = Date.parse(account.lastBalanceCheckedAt);
  return Number.isFinite(previous) && checkedAtMs - previous < BALANCE_REFRESH_TTL_MS;
}

async function fetchVercelCredits(
  endpointProvider: EndpointProviderDefinition,
  modelCompany: ModelCompanyDefinition,
  account: ProviderAccountStored
): Promise<LiveCreditResult> {
  const response = await fetch(creditUrl(endpointProvider, accountBaseUrl(modelCompany, account)), {
    method: "GET",
    headers: {
      authorization: `Bearer ${decryptSecret(account.encryptedApiKey)}`,
      accept: "application/json",
      "content-type": "application/json"
    },
    signal: AbortSignal.timeout(5000)
  });

  if (!response.ok) {
    const text = await response.text();
    throw makeBalanceCheckError(endpointProvider, response.status, text);
  }

  const payload = (await response.json()) as { balance?: string; total_used?: string };
  return {
    balanceCents: centsFromCreditValue(payload.balance),
    totalUsedCents: centsFromCreditValue(payload.total_used)
  };
}

async function fetchOpenRouterCredits(
  endpointProvider: EndpointProviderDefinition,
  modelCompany: ModelCompanyDefinition,
  account: ProviderAccountStored
): Promise<LiveCreditResult> {
  const response = await fetch(creditUrl(endpointProvider, accountBaseUrl(modelCompany, account)), {
    method: "GET",
    headers: {
      authorization: `Bearer ${decryptSecret(account.encryptedApiKey)}`,
      accept: "application/json",
      "content-type": "application/json"
    },
    signal: AbortSignal.timeout(5000)
  });

  if (!response.ok) {
    const text = await response.text();
    throw makeBalanceCheckError(endpointProvider, response.status, text);
  }

  const payload = (await response.json()) as {
    data?: { total_credits?: number | string; total_usage?: number | string };
  };
  const totalCredits = centsFromCreditValue(payload.data?.total_credits);
  const totalUsage = centsFromCreditValue(payload.data?.total_usage) ?? 0;

  return {
    balanceCents: typeof totalCredits === "number" ? Math.max(0, totalCredits - totalUsage) : undefined,
    totalUsedCents: totalUsage
  };
}

async function fetchLiveCredits(
  endpointProvider: EndpointProviderDefinition,
  modelCompany: ModelCompanyDefinition,
  account: ProviderAccountStored
) {
  if (endpointProvider.id === "vercel-ai-gateway") return fetchVercelCredits(endpointProvider, modelCompany, account);
  if (endpointProvider.id === "openrouter") return fetchOpenRouterCredits(endpointProvider, modelCompany, account);
  return undefined;
}

export async function refreshLiveBalances(
  gateway: GatewayStored,
  modelCompany: ModelCompanyDefinition,
  options: { force?: boolean } = {}
) {
  let changed = false;
  const checkedAt = new Date().toISOString();
  const checkedAtMs = Date.parse(checkedAt);

  const accounts = await Promise.all(
    gateway.accounts.map(async (account) => {
      const endpointProvider = detectAccountEndpoint(modelCompany, account);
      if (endpointProvider.balance.mode !== "api") return account;
      const normalizedAccount = withoutLegacyBalanceError(account);
      if (normalizedAccount !== account) changed = true;
      if (!options.force && hasFreshBalanceCheck(normalizedAccount, checkedAtMs)) return normalizedAccount;

      try {
        const credits = await fetchLiveCredits(endpointProvider, modelCompany, account);
        if (!credits) return normalizedAccount;
        changed = true;
        return {
          ...normalizedAccount,
          estimatedBalanceCents: credits.balanceCents ?? normalizedAccount.estimatedBalanceCents,
          spentCents: credits.totalUsedCents ?? normalizedAccount.spentCents,
          lastBalanceStatus: "live" as const,
          lastBalanceError: undefined,
          lastBalanceCheckedAt: checkedAt
        };
      } catch (error) {
        changed = true;
        const balanceError =
          error instanceof BalanceCheckError
            ? error
            : new BalanceCheckError(
                error instanceof Error ? error.message : `${endpointProvider.name} credits check failed`,
                `${endpointProvider.name} live credits are temporarily unavailable; cached/local balance will be used.`,
                "unavailable"
              );
        return {
          ...normalizedAccount,
          lastBalanceStatus: balanceError.reason,
          lastBalanceError: balanceError.publicMessage,
          lastBalanceCheckedAt: checkedAt
        };
      }
    })
  );

  if (!changed) return gateway;

  const nextGateway = {
    ...gateway,
    accounts,
    updatedAt: checkedAt
  };
  await upsertGateway(nextGateway);
  return nextGateway;
}

export function balanceSnapshots(gateway: GatewayStored, modelCompany: ModelCompanyDefinition): BalanceSnapshot[] {
  return gateway.accounts.map((account) => {
    const endpointProvider = detectAccountEndpoint(modelCompany, account);
    const shouldSkip = isLowBalance(gateway, account);
    const floor = account.balanceFloorCents ?? gateway.failover.lowBalanceCents;
    const isLiveApi = endpointProvider.balance.mode === "api";
    const hasBalance = typeof account.estimatedBalanceCents === "number";
    const balanceState: BalanceCheckState = isLiveApi
      ? account.lastBalanceStatus === "live" && hasBalance
        ? "live"
        : hasBalance
          ? "cached"
          : account.lastBalanceStatus === "auth-unavailable"
            ? "auth-unavailable"
            : account.lastBalanceStatus === "unavailable"
              ? "unavailable"
              : "unset"
      : hasBalance
        ? endpointProvider.balance.mode === "manual"
          ? "manual"
          : "estimated"
        : "unset";
    const balanceText = hasBalance
      ? `${(account.estimatedBalanceCents! / 100).toFixed(2)} USD ${balanceState}`
      : "No local balance set";

    return {
      accountId: account.id,
      label: account.label,
      mode: endpointProvider.balance.mode,
      endpointProviderId: endpointProvider.id,
      endpointProviderName: endpointProvider.name,
      status: account.status,
      estimatedBalanceCents: account.estimatedBalanceCents,
      balanceFloorCents: floor,
      spentCents: account.spentCents,
      shouldSkip,
      balanceState,
      message: account.lastBalanceError && isLiveApi
        ? `${account.lastBalanceError}${hasBalance ? " Cached/local balance is shown." : ""}`
        : shouldSkip
          ? `Skipped because ${balanceText} is at or below the ${(floor / 100).toFixed(2)} USD floor.`
          : isLiveApi && balanceState === "live"
            ? `${endpointProvider.balance.label}: ${balanceText}.`
            : isLiveApi
              ? `${endpointProvider.balance.label} will appear after a successful check.`
              : `${endpointProvider.balance.label}: ${balanceText}.`
    };
  });
}

export function estimateSpendCents(provider: { estimatedCentsPer1KTokens: number }, responseBody: unknown) {
  if (!responseBody || typeof responseBody !== "object") return 0;
  const usage = (responseBody as { usage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number } }).usage;
  const totalTokens = usage?.total_tokens ?? ((usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0));
  if (!totalTokens || provider.estimatedCentsPer1KTokens <= 0) return 0;
  return Math.max(1, Math.ceil((totalTokens / 1000) * provider.estimatedCentsPer1KTokens));
}
