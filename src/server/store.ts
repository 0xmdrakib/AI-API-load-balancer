import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir, storePath } from "./config.js";
import type { GatewayPublic, GatewayStoreFile, GatewayStored, ProviderAccountPublic } from "../shared/types.js";

const initialStore: GatewayStoreFile = {
  version: 1,
  gateways: []
};

async function ensureStore() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(storePath);
  } catch {
    await fs.writeFile(storePath, JSON.stringify(initialStore, null, 2), "utf8");
  }
}

export async function readStore(): Promise<GatewayStoreFile> {
  await ensureStore();
  const raw = await fs.readFile(storePath, "utf8");
  if (!raw.trim()) return initialStore;
  const parsed = JSON.parse(raw) as GatewayStoreFile;
  parsed.gateways = parsed.gateways.map((gateway) => ({
    ...gateway,
    modelCompanyId: gateway.modelCompanyId ?? gateway.providerId ?? "openai",
    providerId: gateway.providerId ?? gateway.modelCompanyId ?? "openai"
  }));
  return parsed;
}

export async function writeStore(nextStore: GatewayStoreFile) {
  await fs.mkdir(dataDir, { recursive: true });
  const tempPath = path.join(dataDir, `gateway.${Date.now()}.tmp`);
  await fs.writeFile(tempPath, JSON.stringify(nextStore, null, 2), "utf8");
  await fs.rename(tempPath, storePath);
}

export function toPublicGateway(gateway: GatewayStored): GatewayPublic {
  return {
    ...gateway,
    modelCompanyId: gateway.modelCompanyId ?? gateway.providerId ?? "openai",
    providerId: gateway.providerId ?? gateway.modelCompanyId ?? "openai",
    accounts: gateway.accounts.map(toPublicAccount)
  };
}

export function toPublicAccount(account: GatewayStored["accounts"][number]): ProviderAccountPublic {
  const { encryptedApiKey: _encryptedApiKey, ...publicAccount } = account;
  return publicAccount;
}

export async function listGateways() {
  const store = await readStore();
  return store.gateways.map(toPublicGateway);
}

export async function getGateway(id: string) {
  const store = await readStore();
  return store.gateways.find((gateway) => gateway.id === id);
}

export async function findGatewayByOwnerHash(ownerKeyHash: string) {
  const store = await readStore();
  return store.gateways.find((gateway) => gateway.ownerKeyHash === ownerKeyHash);
}

export async function upsertGateway(gateway: GatewayStored) {
  const store = await readStore();
  const existingIndex = store.gateways.findIndex((item) => item.id === gateway.id);
  if (existingIndex >= 0) {
    store.gateways[existingIndex] = gateway;
  } else {
    store.gateways.push(gateway);
  }
  await writeStore(store);
  return gateway;
}

export async function updateGateway(id: string, updater: (gateway: GatewayStored) => GatewayStored) {
  const store = await readStore();
  const existingIndex = store.gateways.findIndex((gateway) => gateway.id === id);
  if (existingIndex < 0) return undefined;
  const nextGateway = updater(store.gateways[existingIndex]);
  store.gateways[existingIndex] = {
    ...nextGateway,
    updatedAt: new Date().toISOString()
  };
  await writeStore(store);
  return store.gateways[existingIndex];
}

export async function deleteGateway(id: string) {
  const store = await readStore();
  const initialCount = store.gateways.length;
  store.gateways = store.gateways.filter((gateway) => gateway.id !== id);
  await writeStore(store);
  return store.gateways.length !== initialCount;
}
