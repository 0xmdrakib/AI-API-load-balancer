import { APP_VERSION } from "../shared/constants.js";
import type { RuntimeMetadata } from "../shared/types.js";
import { env } from "./config.js";
import { getStoreHealth } from "./store.js";

const startedAt = Date.now();
let boundPort = env.port;

export function setBoundPort(port: number) {
  boundPort = port;
}

export function getBaseUrls() {
  const root = env.publicBaseUrl?.replace(/\/$/, "") ?? `http://${env.host}:${boundPort}`;
  return { openai: `${root}/v1`, anthropic: root };
}

export function getRuntimeMetadata(): RuntimeMetadata {
  return {
    version: APP_VERSION,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    port: boundPort,
    baseUrls: getBaseUrls(),
    store: getStoreHealth()
  };
}
