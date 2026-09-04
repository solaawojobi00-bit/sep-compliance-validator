# Contributing to SEP Compliance Validator

Thank you for your interest in contributing to the SEP Compliance Validator! This document details how to set up your local development environment and provides a step-by-step guide on how to implement conformance checks for a new SEP.

For higher-level design decisions, tech stack rationale, and system architecture, please see [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Table of Contents

- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [How to Add a Checker for a New SEP](#how-to-add-a-checker-for-a-new-sep)
  - [1. Create the Checker Module](#1-create-the-checker-module)
  - [2. Define Checks and Return `CheckResult`s](#2-define-checks-and-return-checkresults)
  - [3. Register the Checker in the CLI](#3-register-the-checker-in-the-cli)
  - [4. Add Unit Tests](#4-add-unit-tests)
  - [5. Validate Build & Tests](#5-validate-build--tests)
- [Submitting a Pull Request](#submitting-a-pull-request)

---

## Development Setup

### Prerequisites

- **Node.js**: version 22.x or higher (CI tests against 22.x and 24.x).
- **npm**: installed with Node.js.

### Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/solaawojobi00-bit/sep-compliance-validator.git
cd sep-compliance-validator
npm install
```

### Running Tests & Building

- **Build TypeScript** (run this first — some CLI tests spawn `dist/cli.js`):
  ```bash
  npm run build
  ```
- **Run unit tests**:
  ```bash
  npm test
  ```
- **Run tests in watch mode**:
  ```bash
  npm run test:watch
  ```
- **Lint** (typescript-eslint, bug-finding rules only — formatting is not linted):
  ```bash
  npm run lint
  ```
- **Type-check the test suite** (`tsconfig.json` excludes `test/`, so `npm run build`
  does not cover it):
  ```bash
  npm run typecheck
  ```

### Running the CLI Locally

After compiling with `npm run build`, execute the CLI using `node`:

```bash
node dist/cli.js check <domain> [--network testnet|mainnet] [--format table|json]
```

Example against Stellar's testnet reference anchor:

```bash
node dist/cli.js check testanchor.stellar.org --network testnet
```

---

## Project Structure

The codebase is structured as a single package designed for modular extension:

```
sep-compliance-validator/
  src/
    cli.ts            # Commander CLI entrypoint: defines `check <domain>`
    checks/           # Per-SEP checker implementations
      sep1.ts         # SEP-1 (stellar.toml) discovery and validation
      sep10.ts        # SEP-10 web authentication challenge/response checks
    core/             # Core types and shared utilities
      http.ts         # Native fetch wrapper (timeouts, normalized errors)
      report.ts       # Shared types: CheckResult, Report, summarize()
    output/           # Formatter implementations
      json.ts         # JSON output formatter
      table.ts        # Terminal table renderer (cli-table3)
  test/               # Unit tests (Vitest)
    sep1.test.ts      # Tests for SEP-1 checks
    sep10.test.ts     # Tests for SEP-10 checks
  ARCHITECTURE.md     # Technical stack and architecture details
  PRD.md              # Requirements and scope document
  package.json
  tsconfig.json
```

Refer to [ARCHITECTURE.md](./ARCHITECTURE.md) for full details on why these technologies and design boundaries were selected.

---

## How to Add a Checker for a New SEP

Adding support for a new SEP follows a repeatable pattern designed to keep checkers isolated and sliceable. The worked example below walks through how `src/checks/sep1.ts` implements this pattern.

### 1. Create the Checker Module

Create a new file in `src/checks/` named after the SEP, e.g., `src/checks/sep38.ts`.

Each checker function accepts necessary context (such as the target domain, network, or parsed `stellar.toml` metadata) and returns a list of `CheckResult` objects (or an object containing them).

### 2. Define Checks and Return `CheckResult`s

Each check must evaluate a specific requirement of the SEP spec and record a `CheckResult` defined in [`src/core/report.ts`](./src/core/report.ts):

```typescript
export interface CheckResult {
  id: string;          // Namespaced check identifier (e.g., "sep1.fetch", "sep38.info")
  description: string; // Human-readable description of what is checked
  status: "pass" | "fail" | "warn";
  severity: "error" | "warning";
  message: string;     // Contextual information or failure reason
}
```

#### Worked Example from `src/checks/sep1.ts`:

Notice how `fetchStellarToml` tests individual facets step-by-step and appends `CheckResult` items:

```typescript
// 1. Fetch check
try {
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    results.push({
      id: "sep1.fetch",
      description: "Fetch stellar.toml from /.well-known/stellar.toml",
      status: "fail",
      severity: "error",
      message: `Received HTTP ${res.status} fetching ${url}`,
    });
    return { toml: { raw: {} }, results };
  }
  // Record pass on successful HTTP fetch
  results.push({
    id: "sep1.fetch",
    description: "Fetch stellar.toml from /.well-known/stellar.toml",
    status: "pass",
    severity: "error",
    message: `Fetched ${url}`,
  });
} catch (err) {
  // Handle network / timeout errors
  ...
}

// 2. Data parsing and field checks
results.push(
  webAuthEndpoint
    ? {
        id: "sep1.web_auth_endpoint",
        description: "stellar.toml declares WEB_AUTH_ENDPOINT",
        status: "pass",
        severity: "error",
        message: `WEB_AUTH_ENDPOINT = ${webAuthEndpoint}`,
      }
    : {
        id: "sep1.web_auth_endpoint",
        description: "stellar.toml declares WEB_AUTH_ENDPOINT",
        status: "fail",
        severity: "error",
        message: "WEB_AUTH_ENDPOINT is missing or not a string; SEP-10 checks cannot run",
      },
);
```

**Guidelines for Check Results:**
- **`id`**: Prefix with the SEP identifier (e.g. `sep1.<check_name>`, `sep38.price`).
- **`status`**: Use `"pass"` if compliant, `"fail"` if non-compliant, and `"warn"` for optional fields or non-critical deviations.
- **`severity`**: Use `"error"` for hard failures that affect compliance exit codes, or `"warning"` for advisory notices.

### 3. Register the Checker in the CLI

Register your new checker function in [`src/cli.ts`](./src/cli.ts) within the `check` command's action handler:

```typescript
import { fetchStellarToml } from "./checks/sep1.js";
import { runSep10Checks } from "./checks/sep10.js";
import { runSep38Checks } from "./checks/sep38.js"; // Import new checker

...
  // Run checks and append to results array
  const { toml, results: sep1Results } = await fetchStellarToml(domain);
  results.push(...sep1Results);

  const sep10Results = await runSep10Checks({ domain, toml, network });
  results.push(...sep10Results);

  const sep38Results = await runSep38Checks({ domain, toml, network });
  results.push(...sep38Results);
```

### 4. Add Unit Tests

Add a corresponding test file under `test/`, such as `test/sep38.test.ts`. Use [Vitest](https://vitest.dev/) and mock external network requests using `global.fetch` or SDK utilities as demonstrated in [`test/sep1.test.ts`](./test/sep1.test.ts):

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchStellarToml } from "../src/checks/sep1.js";

function mockFetch(response: Partial<Response>) {
  global.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

describe("fetchStellarToml", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes all checks for a well-formed stellar.toml", async () => {
    mockFetch({ ok: true, text: async () => 'WEB_AUTH_ENDPOINT="https://example.com/auth"\nSIGNING_KEY="GABCXYZ"' } as Response);
    const { results } = await fetchStellarToml("example.com");
    expect(results.every((r) => r.status === "pass")).toBe(true);
  });

  it("fails when required fields are missing", async () => {
    mockFetch({ ok: true, text: async () => 'OTHER_FIELD="foo"' } as Response);
    const { results } = await fetchStellarToml("example.com");
    const webAuth = results.find((r) => r.id === "sep1.web_auth_endpoint");
    expect(webAuth?.status).toBe("fail");
  });
});
```

### 5. Validate Build & Tests

Before submitting your changes, run everything CI gates on:

```bash
npm run build
npm test
npm run lint
npm run typecheck
```

---

## Submitting a Pull Request

1. Create a descriptive feature/fix branch: `git checkout -b <branch-name>`.
2. Ensure your changes stay strictly within the scope of the issue you are addressing.
3. Make sure `npm run build`, `npm test`, `npm run lint`, and `npm run typecheck` pass
   cleanly — these are the required CI checks.
4. Open a pull request against `main` describing the changes made and linking to the relevant issue.
