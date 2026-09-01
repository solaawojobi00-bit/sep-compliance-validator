import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["dist/**", "test/**"],
      thresholds: {
        lines: 75,
        statements: 75,
        branches: 75,
        functions: 80,
      },
    },
  },
});
