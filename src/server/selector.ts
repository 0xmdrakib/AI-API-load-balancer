import type { GatewayStored, ProviderAccountStored } from "../shared/types.js";

function nowMs() {
  return Date.now();
}

export function isLowBalance(gateway: GatewayStored, account: ProviderAccountStored) {
  const floor = account.balanceFloorCents ?? gateway.failover.lowBalanceCents;
  return (
    gateway.failover.switchOnLowBalance &&
    typeof account.estimatedBalanceCents === "number" &&
    account.estimatedBalanceCents <= floor
  );
}

export function getEligibleAccounts(gateway: GatewayStored, excluded = new Set<string>()) {
  return gateway.accounts.filter((account) => {
    if (excluded.has(account.id)) return false;
    if (account.status === "paused" || account.status === "invalid" || account.status === "exhausted") return false;
    if (account.cooldownUntil && Date.parse(account.cooldownUntil) > nowMs()) return false;
    if (isLowBalance(gateway, account)) return false;
    return true;
  });
}

export function selectAccount(gateway: GatewayStored, excluded = new Set<string>()) {
  const eligible = getEligibleAccounts(gateway, excluded);
  if (eligible.length === 0) return undefined;

  if (gateway.strategy === "priority-failover") {
    return [...eligible].sort((a, b) => a.priority - b.priority || a.requestCount - b.requestCount)[0];
  }

  if (gateway.strategy === "least-used") {
    return [...eligible].sort((a, b) => a.requestCount - b.requestCount || a.priority - b.priority)[0];
  }

  if (gateway.strategy === "weighted") {
    const totalWeight = eligible.reduce((sum, account) => sum + Math.max(1, account.weight), 0);
    let target = Math.random() * totalWeight;
    for (const account of eligible) {
      target -= Math.max(1, account.weight);
      if (target <= 0) return account;
    }
    return eligible[0];
  }

  const sorted = [...eligible].sort((a, b) => a.priority - b.priority);
  const nextIndex = (gateway.lastRoundRobinIndex + 1) % sorted.length;
  return sorted[nextIndex];
}

export function nextRoundRobinIndex(gateway: GatewayStored, accountId: string) {
  const eligible = getEligibleAccounts(gateway).sort((a, b) => a.priority - b.priority);
  return Math.max(0, eligible.findIndex((account) => account.id === accountId));
}
