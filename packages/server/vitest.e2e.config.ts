import { defineConfig } from "vitest/config";
import path from "node:path";
import os from "node:os";

// Unique test DB per vitest invocation — same guardrail as vitest.config.ts.
// E2e tests that spawn child server processes override this with their own
// temp paths; this default covers any unit-style tests included by this config.
const testDbPath = path.join(os.tmpdir(), `fleet-e2e-test-${process.pid}.db`);

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    reporters: ["default"],
    isolate: true,
    env: {
      // Mock CDP by default. E2e tests that spawn child processes override
      // this in the child's env when needed.
      CDP_MOCK_MODE: "1",
      // Redirect any direct DB access away from the production file.
      SQLITE_PATH: testDbPath,
    },
  },
});
