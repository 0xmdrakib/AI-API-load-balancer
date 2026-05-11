import crypto from "node:crypto";
import { customAlphabet } from "nanoid";
import { env } from "./config.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ", 32);
const key = crypto.createHash("sha256").update(env.gatewaySecret).digest();

export function createOwnerApiKey() {
  return `aigw_${nanoid()}`;
}

export function previewSecret(secret: string) {
  if (secret.length <= 12) return `${secret.slice(0, 3)}...`;
  return `${secret.slice(0, 7)}...${secret.slice(-4)}`;
}

export function hashSecret(secret: string) {
  return crypto.createHmac("sha256", key).update(secret).digest("hex");
}

export function encryptSecret(secret: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptSecret(payload: string) {
  const [ivRaw, tagRaw, ciphertextRaw] = payload.split(".");
  if (!ivRaw || !tagRaw || !ciphertextRaw) {
    throw new Error("Invalid encrypted secret payload");
  }

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextRaw, "base64url")),
    decipher.final()
  ]);
  return plaintext.toString("utf8");
}
