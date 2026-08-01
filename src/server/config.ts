import path from "node:path";
import { fileURLToPath } from "node:url";
import { PREFERRED_DESKTOP_PORT } from "../shared/constants.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const rootDir = path.resolve(__dirname, "../..");
export const dataDir = process.env.GATEWAY_DATA_DIR
  ? path.resolve(process.env.GATEWAY_DATA_DIR)
  : path.join(rootDir, "data");
export const storePath = path.join(dataDir, "gateway.json");

const explicitPort = process.env.PORT === undefined ? undefined : Number(process.env.PORT);
if (explicitPort !== undefined && (!Number.isInteger(explicitPort) || explicitPort < 0 || explicitPort > 65535)) {
  throw new Error(`Invalid PORT value: ${process.env.PORT}`);
}

const developmentSecret = "local-development-secret-change-me";
if (process.env.NODE_ENV === "production" && !process.env.GATEWAY_SECRET) {
  throw new Error("GATEWAY_SECRET is required in production; the shared development secret is disabled.");
}

export const env = {
  port: explicitPort ?? PREFERRED_DESKTOP_PORT,
  portWasExplicit: explicitPort !== undefined,
  host: process.env.HOST ?? "127.0.0.1",
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  gatewaySecret: process.env.GATEWAY_SECRET ?? developmentSecret,
  upstreamHeaderTimeoutMs: Number(process.env.UPSTREAM_HEADER_TIMEOUT_MS ?? 30_000),
  requestDeadlineMs: Number(process.env.REQUEST_DEADLINE_MS ?? 120_000)
};
