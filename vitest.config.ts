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
        lines: 85,
        statements: 85,
        branches: 82,
        functions: 100,
        "src/checks/**": {
          lines: 85,
          statements: 85,
          branches: 80,
          functions: 100,
        },
      },
    },
  },
});
