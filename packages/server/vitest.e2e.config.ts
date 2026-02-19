import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    reporters: ["default"],
    isolate: true,
  },
});
