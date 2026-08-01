export const APP_VERSION = "0.2.0";
export const MAX_ACCOUNTS_PER_GATEWAY = 50;
export const MAX_FAILOVER_RETRIES = MAX_ACCOUNTS_PER_GATEWAY - 1;
export const PREFERRED_DESKTOP_PORT = 42891;
export const LAST_PREFERRED_DESKTOP_PORT = 42940;
export const BALANCE_CHECK_CONCURRENCY = 8;

export type ClientProtocol = "openai" | "anthropic";
