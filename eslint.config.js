import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"],
  },
  {
    // TypeScript sources only; this config file itself is plain JS and is not linted.
    files: ["**/*.ts"],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        // Type-aware linting over src/ and test/ alike: tsconfig.test.json is the only
        // project that includes the test suite.
        project: ["./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Deliberately a small, bug-finding rule set rather than a style preset.
      // Formatting is not linted, and the broad `recommendedTypeChecked` strictness
      // rules are left off: they fire in bulk on the intentionally loose fetch mocks
      // in test/ without saying anything about correctness.

      // Every checker is async and appends to a shared results array, so a dropped
      // await silently omits checks from the report — a false "pass".
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",

      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],

      // Next ratchet, deliberately not enabled here: `no-explicit-any` currently reports
      // 34 sites (11 in src/, 23 in test/). They are type-design decisions — SDK
      // challenge-transaction types, untyped anchor error bodies, and the extra `jwt` /
      // `challengeXdr` properties smuggled on the SEP-10 results array in cli.ts — and
      // changing production types belongs in its own reviewable PR, not a CI change.
    },
  },
);
