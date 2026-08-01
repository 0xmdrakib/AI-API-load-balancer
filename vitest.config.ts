import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      GATEWAY_SECRET: "vitest-only-encryption-secret",
      GATEWAY_DATA_DIR: path.resolve(".vitest-data")
    }
  }
});
