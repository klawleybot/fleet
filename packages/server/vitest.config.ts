import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    // Run test files sequentially to avoid port contention when
    // multiple e2e tests spawn anvil + server processes simultaneously.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
