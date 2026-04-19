import { defineConfig } from "vitest/config";
import path from "node:path";
import os from "node:os";

// Unique test DB per vitest invocation — avoids collisions with production DB
// and stale data between runs. Placed in os.tmpdir so it's auto-cleaned.
const testDbPath = path.join(os.tmpdir(), `fleet-test-${process.pid}.db`);
const testIntelDbPath = path.join(os.tmpdir(), `fleet-intel-test-${process.pid}.db`);

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    setupFiles: ["tests/setup.ts"],
    // Run test files sequentially to avoid port contention when
    // multiple e2e tests spawn anvil + server processes simultaneously.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      // Default to mock mode for unit tests that import services directly.
      // E2E tests that spawn child processes set their own env.
      VITEST: "1",
      CDP_MOCK_MODE: "1",
      VITEST_SQLITE_PATH: testDbPath,
      VITEST_INTEL_DB_PATH: testIntelDbPath,
      SQLITE_PATH: testDbPath,
      ZORA_INTEL_DB_PATH: testIntelDbPath,
      INTEL_DB_PATH: testIntelDbPath,
      DB_PATH: testIntelDbPath,
    },
  },
});
