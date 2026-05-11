import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const rootDir = path.resolve(__dirname, "../..");
export const dataDir = process.env.GATEWAY_DATA_DIR
  ? path.resolve(process.env.GATEWAY_DATA_DIR)
  : path.join(rootDir, "data");
export const storePath = path.join(dataDir, "gateway.json");

export const env = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "127.0.0.1",
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? 8787}`,
  gatewaySecret: process.env.GATEWAY_SECRET ?? "local-development-secret-change-me"
};
