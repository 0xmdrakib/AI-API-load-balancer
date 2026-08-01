import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir, storePath } from "./config.js";
import type { GatewayPublic, GatewayStoreFile, GatewayStored, ProviderAccountPublic } from "../shared/types.js";

const emptyStore = (): GatewayStoreFile => ({ version: 2, gateways: [] });

let memoryStore: GatewayStoreFile | undefined;
let initialization: Promise<void> | undefined;
let mutationQueue: Promise<unknown> = Promise.resolve();
let flushTimer: NodeJS.Timeout | undefined;
let runtimeUpdaters = new Map<string, Array<(gateway: GatewayStored) => GatewayStored>>();
let storeHealth: { state: "ready" | "recovered" | "reset"; message: string } = {
  state: "ready",
  message: "Configuration store is ready."
};

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalizeGateway(gateway: GatewayStored): GatewayStored {
  return {
    ...gateway,
    modelCompanyId: gateway.modelCompanyId ?? gateway.providerId ?? "openai",
    providerId: gateway.providerId ?? gateway.modelCompanyId ?? "openai",
    accounts: (gateway.accounts ?? []).map((account) => ({
      ...account,
      consecutiveFailures: account.consecutiveFailures ?? 0,
      upstreamProtocol: account.upstreamProtocol ?? (gateway.providerId === "anthropic-official" ? "anthropic" : "openai")
    }))
  };
}

function parseV2(raw: string): GatewayStoreFile {
  const parsed = JSON.parse(raw) as Partial<GatewayStoreFile> & { version?: number };
  if (parsed.version !== 2 || !Array.isArray(parsed.gateways)) {
    throw new Error(`Unsupported store version ${String(parsed.version ?? "unknown")}`);
  }
  return { version: 2, gateways: parsed.gateways.map(normalizeGateway) };
}

async function fsyncWrite(filePath: string, contents: string) {
  const handle = await fs.open(filePath, "w", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeStoreAtomic(nextStore: GatewayStoreFile) {
  await fs.mkdir(dataDir, { recursive: true });
  const tempPath = path.join(dataDir, `gateway.${process.pid}.${Date.now()}.tmp`);
  const backupPath = `${storePath}.bak`;
  await fsyncWrite(tempPath, JSON.stringify(nextStore, null, 2));
  try {
    await fs.copyFile(storePath, backupPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await fs.rename(tempPath, storePath);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    await fs.rm(storePath, { force: true });
    await fs.rename(tempPath, storePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function initializeStore() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as { version?: number };
    if (parsed.version !== 2) {
      const legacyBackup = path.join(dataDir, `gateway.v${parsed.version ?? "unknown"}.${timestamp()}.backup.json`);
      await fs.copyFile(storePath, legacyBackup);
      memoryStore = emptyStore();
      storeHealth = {
        state: "reset",
        message: `A legacy store was preserved as ${path.basename(legacyBackup)} and a protected v2 store was created.`
      };
      await writeStoreAtomic(memoryStore);
      return;
    }
    memoryStore = parseV2(raw);
  } catch (primaryError) {
    if ((primaryError as NodeJS.ErrnoException).code === "ENOENT") {
      memoryStore = emptyStore();
      await writeStoreAtomic(memoryStore);
      return;
    }

    try {
      const backupRaw = await fs.readFile(`${storePath}.bak`, "utf8");
      memoryStore = parseV2(backupRaw);
      const corruptBackup = path.join(dataDir, `gateway.corrupt.${timestamp()}.json`);
      await fs.copyFile(storePath, corruptBackup).catch(() => undefined);
      storeHealth = {
        state: "recovered",
        message: `The primary store was corrupt; configuration was recovered from backup. Original saved as ${path.basename(corruptBackup)}.`
      };
      await writeStoreAtomic(memoryStore);
      console.warn(storeHealth.message);
    } catch {
      const corruptBackup = path.join(dataDir, `gateway.unreadable.${timestamp()}.json`);
      await fs.copyFile(storePath, corruptBackup).catch(() => undefined);
      memoryStore = emptyStore();
      storeHealth = {
        state: "reset",
        message: `No valid store backup was available. Unreadable data was preserved as ${path.basename(corruptBackup)}.`
      };
      await writeStoreAtomic(memoryStore);
      console.warn(storeHealth.message);
    }
  }
}

async function ensureStore() {
  initialization ??= initializeStore();
  await initialization;
}

async function serializeMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(mutation, mutation);
  mutationQueue = next.then(() => undefined, () => undefined);
  return next;
}

export async function readStore(): Promise<GatewayStoreFile> {
  await ensureStore();
  return clone(memoryStore!);
}

export async function writeStore(nextStore: GatewayStoreFile) {
  return serializeMutation(async () => {
    await ensureStore();
    memoryStore = clone(nextStore);
    await writeStoreAtomic(memoryStore);
  });
}

export function getStoreHealth() {
  return { ...storeHealth };
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
  return serializeMutation(async () => {
    await ensureStore();
    const existingIndex = memoryStore!.gateways.findIndex((item) => item.id === gateway.id);
    if (existingIndex >= 0) memoryStore!.gateways[existingIndex] = clone(gateway);
    else memoryStore!.gateways.push(clone(gateway));
    await writeStoreAtomic(memoryStore!);
    return clone(gateway);
  });
}

export async function updateGateway(id: string, updater: (gateway: GatewayStored) => GatewayStored) {
  return serializeMutation(async () => {
    await ensureStore();
    const existingIndex = memoryStore!.gateways.findIndex((gateway) => gateway.id === id);
    if (existingIndex < 0) return undefined;
    const nextGateway = updater(clone(memoryStore!.gateways[existingIndex]));
    memoryStore!.gateways[existingIndex] = { ...nextGateway, updatedAt: new Date().toISOString() };
    await writeStoreAtomic(memoryStore!);
    return clone(memoryStore!.gateways[existingIndex]);
  });
}

export function deferGatewayUpdate(id: string, updater: (gateway: GatewayStored) => GatewayStored) {
  const pending = runtimeUpdaters.get(id) ?? [];
  pending.push(updater);
  runtimeUpdaters.set(id, pending);
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flushStore();
    }, 1000);
    flushTimer.unref();
  }
}

export async function flushStore() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = undefined;
  const pending = runtimeUpdaters;
  runtimeUpdaters = new Map();
  if (pending.size === 0) {
    await mutationQueue;
    return;
  }
  await serializeMutation(async () => {
    await ensureStore();
    for (const [id, updaters] of pending) {
      const index = memoryStore!.gateways.findIndex((gateway) => gateway.id === id);
      if (index < 0) continue;
      let nextGateway = clone(memoryStore!.gateways[index]);
      for (const updater of updaters) nextGateway = updater(nextGateway);
      memoryStore!.gateways[index] = { ...nextGateway, updatedAt: new Date().toISOString() };
    }
    await writeStoreAtomic(memoryStore!);
  });
}

export async function deleteGateway(id: string) {
  return serializeMutation(async () => {
    await ensureStore();
    const initialCount = memoryStore!.gateways.length;
    memoryStore!.gateways = memoryStore!.gateways.filter((gateway) => gateway.id !== id);
    const changed = memoryStore!.gateways.length !== initialCount;
    if (changed) await writeStoreAtomic(memoryStore!);
    return changed;
  });
}
