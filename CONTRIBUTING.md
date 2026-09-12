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
- [Registering an Anchor for the Public Dashboard](#registering-an-anchor-for-the-public-dashboard)
- [Working on the Dashboard Web App](#working-on-the-dashboard-web-app)
- [Commit Message Convention](#commit-message-convention)
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
- **Run tests under the coverage thresholds CI gates on**:
  ```bash
  npm run test:coverage
  ```
- **Lint** (typescript-eslint, bug-finding rules only — formatting is not linted):
  ```bash
  npm run lint
  ```
  Linting is type-aware and covers `src/` and `test/` alike (`tsconfig.test.json` is the
  only project that includes the test suite). `@typescript-eslint/no-explicit-any` is
  enabled, so an explicit `any` anywhere — tests included — fails the build. Where a
  value genuinely is not statically knowable, prefer `unknown` and narrow it.
- **Type-check the test suite** (`tsconfig.json` excludes `test/`, so `npm run build`
  does not cover it):
  ```bash
  npm run typecheck
  ```

### Running the CLI Locally

After compiling with `npm run build`, execute the CLI using `node`:

```bash
node dist/cli.js check <domain> [--network testnet|mainnet] [--format table|json|html]
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
    index.ts          # Public programmatic API exports and types
    checks/           # Per-SEP checker implementations
      sep1.ts         # SEP-1 (stellar.toml) discovery and validation
      sep1-currencies.ts  # [[CURRENCIES]] asset table validation
      sep10.ts        # SEP-10 web authentication challenge/response checks
      sep10-negative.ts   # SEP-10 negative cases (expired, wrong network, tampered)
      sep12.ts        # SEP-12 KYC customer endpoints
      sep12-fields.ts # SEP-9 fields/provided_fields schema validation
      sep24.ts        # SEP-24 interactive deposit/withdraw
      sep24-browser.ts    # Playwright automation for SEP-24 interactive forms
      sep38.ts        # SEP-38 price and quote endpoints
    core/             # Core types and shared utilities
      guard.ts        # Error boundary so one checker crashing cannot abort the run
      http.ts         # Native fetch wrapper (timeouts, normalized errors)
      report.ts       # Shared types: CheckResult, Report, summarize()
    output/           # Formatter implementations
      html.ts         # Standalone HTML report renderer
      json.ts         # JSON output formatter
      table.ts        # Terminal table renderer (cli-table3)
  dashboard/          # Public dashboard web app — static, no build step
    index.html        # Directory view plus the #/anchor/<domain> detail route
    app.js            # DOM wiring, routing, and data fetching
    dashboard-lib.mjs # Pure view logic (metrics, filters, grouping) — the tested part
    style.css         # Theming via [data-theme] and CSS custom properties
  registry/           # Anchor opt-in registry (see registry/README.md)
  scripts/            # Registry tooling and the dashboard crawler (scripts/crawl/)
  test/               # Unit tests (Vitest) — one suite per checker, plus core,
                      # renderers, CLI options, public API exports, registry, crawler,
                      # and dashboard view logic
  ARCHITECTURE.md     # Technical stack and architecture details
  PRD.md              # Requirements and scope document
  package.json
  tsconfig.json
```

`dashboard/`, `registry/`, and `scripts/` are repository infrastructure, not part of the
published package — `package.json` sets `"files": ["dist"]`.

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

Before submitting your changes, run:

```bash
npm run build
npm run test:coverage    # or `npm test` to skip the coverage gate
npm run lint
npm run typecheck
npm run validate:registry # only needed if you changed registry/ or its tooling
npm run lint:workflows   # only if you changed .github/workflows/
```

Prefer `npm run test:coverage` over `npm test` before pushing. CI runs the plain suite on
Node 24.x but the coverage gate on 22.x, and the thresholds in `vitest.config.ts` (85%
lines, 85% statements, 82% branches, 100% functions, with `src/checks/**` held to 80%
branches) are blocking. A new branch in a checker that nothing exercises is the usual way
a green local `npm test` still comes back red — 100% function coverage in particular means
a helper with no test at all will fail the build.

CI gates on more than these scripts, none of which need running locally but all of which
can fail a pull request: a blocking production dependency audit
(`npm audit --omit=dev --audit-level=high`; the full-tree audit is advisory and never
fails), an `npm pack` smoke test that installs the tarball into a clean project and runs
the installed binary, two composite-Action smoke jobs covering the passing and the failing
path, and CodeQL, Gitleaks, and dependency review.

`npm run validate:registry` is deliberately not on the every-pull-request list: the
workflow that runs it is path-filtered to `registry/**` and its scripts, so it only gates
pull requests that actually touch the registry.

`lint:workflows` runs [actionlint](https://github.com/rhysd/actionlint) over
`.github/workflows/`. Unlike the others it is not an npm dependency, so install the
binary first — `brew install actionlint`, `go install
github.com/rhysd/actionlint/cmd/actionlint@latest`, or a
[release download](https://github.com/rhysd/actionlint/releases). Install
[shellcheck](https://www.shellcheck.net) alongside it and actionlint will find it on
`PATH` and check the bash inside every `run:` block; without it that pass is silently
skipped, so CI can still fail on a script issue your local run did not report.

This one is worth running deliberately, because a broken workflow fails silently. A
malformed `paths:` filter or a bad `if:` expression does not turn a job red — the job
simply never runs, and a green tick then means "nothing was checked" rather than
"checks passed".

---

## Registering an Anchor for the Public Dashboard

Anchor operators who want their anchor validated and published on the public dashboard
opt in by adding an entry to [`registry/anchors.json`](./registry/anchors.json). An anchor
that is not listed there is never crawled and never published — there is no discovery or
scraping.

A registration also carries a signed ownership proof in `registry/proofs/`, generated with
`scripts/sign-registry-proof.mjs` and verified in CI against the `SIGNING_KEY` fetched from
the anchor's live `stellar.toml`. See [`registry/README.md`](./registry/README.md) for the
entry format, how to generate the proof, how the two CI checks on a registration pull
request work, and how to opt out again.

To check the registry before pushing:

```bash
npm run validate:registry
```

Note this is contributor-facing infrastructure rather than part of the published package:
the registry, its schema, and `scripts/registry-*.mjs` are not shipped in the npm tarball
(`package.json` sets `"files": ["dist"]`).

---

## Working on the Dashboard Web App

[`dashboard/`](./dashboard) is the public dashboard: plain HTML, CSS, and ES modules with
no framework and no build step. Serve it over HTTP rather than opening `index.html` from
the filesystem — ES module imports are blocked on `file://`:

```bash
npx serve dashboard        # or: python3 -m http.server -d dashboard
```

The checked-in `dashboard/data/` is sample data. It is what the deployed site falls back to
before the first crawl publishes anything, and it is what you develop against locally. To
work against real data, copy `data/` down from the `dashboard-data` branch:

```bash
git fetch origin dashboard-data
git show origin/dashboard-data:data/summary.json > dashboard/data/summary.json
```

Put logic worth testing in [`dashboard/dashboard-lib.mjs`](./dashboard/dashboard-lib.mjs)
as a pure function and cover it in
[`test/dashboard.test.mjs`](./test/dashboard.test.mjs); keep `app.js` to DOM wiring. The
split is what lets the view logic run under the same `npm test` as the rest of the repo,
with no browser or DOM shim. Note that these suites are not under the `src/**` coverage
gate, so a thin `dashboard-lib.mjs` will not show up as a coverage failure — test it
because it is the part that can be wrong, not because CI will catch you.

Two constraints to keep in mind when editing:

- `validateReportSchema` hardcodes the highest `REPORT_SCHEMA_VERSION` it accepts, because
  a browser cannot import the TypeScript source. Bumping the schema version means updating
  it here too.
- The deploy workflow copies the crawled `data/` tree over `dashboard/data/`, so anything
  the app fetches must live under that path relative to the page.

---

## Commit Message Convention

Commits on `main` follow [Conventional Commits](https://www.conventionalcommits.org/).
This is not a style preference: `.releaserc.json` runs semantic-release with the
`conventionalcommits` preset on every push to `main`, so the message prefix is what decides
the version bump and what appears in `CHANGELOG.md`. A message outside the convention
releases nothing and records nothing.

```
<type>(<optional scope>): <summary>
```

| Type | Release | Changelog section |
|---|---|---|
| `feat` | minor | Features |
| `fix` | patch | Bug Fixes |
| `perf` | patch | Performance Improvements |
| `revert` | patch | Reverts |
| `docs` | none | Documentation |
| `refactor`, `test`, `build`, `ci`, `chore`, `style` | none | hidden |

A breaking change is marked with `!` after the type (`feat!:`) or a `BREAKING CHANGE:`
footer, and triggers a major bump.

Those eleven types are the complete set `.releaserc.json` declares. **A type outside that
list is silently dropped** — it neither bumps the version nor appears in the changelog, and
nothing warns you. `main` already carries `deps:` commits, which is not a declared type, so
those upgrades are invisible in the generated notes; use `build(deps):` or `chore(deps):`
for dependency work instead.

Scopes in use track the area changed rather than a fixed list — `dashboard`, `registry`,
`sep10`, `report`, `crawl`, `action`. Use one when it narrows the summary usefully.

---

## Submitting a Pull Request

1. Create a descriptive feature/fix branch: `git checkout -b <branch-name>`.
2. Ensure your changes stay strictly within the scope of the issue you are addressing.
3. Make sure `npm run build`, `npm run test:coverage`, `npm run lint`, and
   `npm run typecheck` pass cleanly, plus `npm run validate:registry` if you touched
   `registry/`. See [Validate Build & Tests](#5-validate-build--tests) for the gates CI
   applies on top of these.
4. Open a pull request against `main` describing the changes made and linking to the relevant issue.

Pull requests are also scanned for committed credentials by Gitleaks, and the check fails
the build on any hit. Keep real secrets out of source control: put them in a local `.env`
file (already git-ignored) or a repository secret, and never in a fixture or a test. The
ruleset is the Gitleaks default plus `.gitleaks.toml`, which allowlists only the Stellar
account IDs the SEP-1 fixtures depend on — those are public addresses, not credentials.
If the check flags something you believe is a false positive, say so in the pull request
rather than widening the allowlist yourself.
