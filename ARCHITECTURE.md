# Architecture: SEP Compliance Validator

## Tech Stack

- **Language/runtime:** TypeScript on Node.js (LTS, 20+).
- **Stellar SDK:** [`@stellar/stellar-sdk`](https://github.com/stellar/js-stellar-sdk) —
  the official JS SDK ships purpose-built SEP-10 helpers in its `WebAuth` namespace. The
  validator uses two of them: `WebAuth.readChallengeTx`, which parses the anchor's
  challenge and verifies it against the `SIGNING_KEY` declared in `stellar.toml`
  (`sep10.ts`), and `WebAuth.buildChallengeTx`, which forges the wrong-network challenge
  used as a negative case (`sep10-negative.ts`). Using these instead of hand-rolling XDR
  parsing keeps the validator's own logic correct and in sync with any future SDK-level
  spec fixes. The optional `client_domain` co-signature is checked separately with
  `Keypair.verify` against the transaction hash, since it is verified against a key
  discovered from the client domain's own TOML rather than the anchor's.
- **JWKS & Cryptography:** `jose` for JSON Web Key Set (JWKS) discovery and cryptographic
  signature verification of anchor-issued SEP-10 JWT tokens.
- **Browser Automation:** `playwright` for on-demand headless browser execution to
  validate SEP-24 interactive web forms, DOM inputs, and completion callbacks
  (`--interactive-browser`). Declared in `optionalDependencies` and imported dynamically,
  so a run without it installed skips the browser checks with a warning rather than
  failing.
- **TOML parsing:** `smol-toml` (small, spec-compliant, zero native dependencies).
- **CLI framework:** `commander` — minimal, well-understood, and easily extensible.
- **HTTP:** native `fetch` (Node 20+ built-in) wrapped by `core/http.ts` with configurable timeout,
  error normalization, and verbose stderr request/response diagnostics.
- **Output renderers:**
  - `cli-table3` for terminal ASCII table formatting (`output/table.ts`).
  - Native JSON serializer for structured machine-readable reports (`output/json.ts`).
  - Standalone HTML document generator with embedded responsive CSS styles (`output/html.ts`).
- **Testing:** `vitest` with v8 coverage tracking across unit, integration, and CLI entry points.
- **Package distribution & CI:** published to npm (`sep-compliance-validator`) and packaged as
  a reusable composite GitHub Action (`action.yml`).

## Why this stack

The target users are Stellar ecosystem developers who are already working in
JS/TS in most cases (anchor reference implementations, wallet SDKs, and the
Stellar JS SDK itself are the dominant tooling language in this part of the
ecosystem). Building on the official SDK means SEP-10's cryptographic and
transaction-structure validation reuses audited, spec-maintained code rather
than a reimplementation that could silently drift from the spec.

## Integration with Stellar / Horizon

This tool validates **SEP-level HTTP/auth flows**, not on-chain Soroban
contracts — the SEPs it targets (1, 10, 12, 24, and 38) are protocols
anchors implement as web services, not smart contracts. Its Stellar-network
touchpoints are:

- **Keypair generation:** uses `Keypair.random()` from the SDK to create a
  fresh testnet or mainnet client account for each SEP-10 run — no funding or Horizon
  submission needed, since SEP-10 challenge transactions are never submitted
  to the network; they exist only to be signed and returned.
- **Network passphrase validation:** validates the anchor's declared
  `NETWORK_PASSPHRASE` in `stellar.toml` against the target network's
  passphrase (`Networks.TESTNET` or `Networks.PUBLIC`) with an actionable failure
  recommending the correct `--network` flag if mismatched. If omitted from `stellar.toml`,
  a warning is issued and the resolved target network's passphrase is used.
- **Horizon** is not required for any of the implemented checks (SEP-1, SEP-10,
  SEP-12, SEP-24, SEP-38). All interactions occur directly against the anchor's
  HTTP/REST endpoints specified in `stellar.toml`.

## Structure

Single npm package and repository root composite action:

```
sep-compliance-validator/
  action.yml            # Composite GitHub Action entrypoint
  src/
    cli.ts              # commander CLI entrypoint, option parsing, and execution dispatch
    checks/
      sep1.ts           # stellar.toml fetch, CORS, size, and field validation
      sep1-currencies.ts # [[CURRENCIES]] asset definitions validation
      sep10.ts          # challenge/response flow, JWT verification, and JWKS validation
      sep10-negative.ts # negative-case challenge validation (expired, wrong network, tampered)
      sep12.ts          # KYC customer endpoint probing, synthetic identity, and DELETE teardown
      sep12-fields.ts   # SEP-9 fields/provided_fields schema validation
      sep24.ts          # interactive deposit/withdraw endpoints and transaction query checks
      sep24-browser.ts  # Playwright headless browser automation for interactive forms
      sep38.ts          # price and quote endpoints conformance checks
    core/
      guard.ts          # error boundary wrapper protecting against unhandled checker crashes
      http.ts           # fetch wrapper with timeout, error normalization, and verbose logging
      report.ts         # CheckResult, Report interfaces, and summarize() metrics aggregation
    output/
      html.ts           # responsive standalone HTML dashboard report renderer
      json.ts           # machine-readable JSON report serializer
      table.ts          # CLI ASCII table renderer (cli-table3)
  test/                 # vitest suites covering checks, core, renderers, and CLI options
  docs/
    dashboard-design.md # Architecture and data model for hosted dashboard web app
  package.json
  tsconfig.json
  vitest.config.ts
  README.md
  PRD.md
  ARCHITECTURE.md
```

Each check module in `checks/` runs a sequence of spec assertions and returns an array
of `CheckResult` objects (`{ id, description, status: "pass" | "fail" | "warn", severity, message }`).
The CLI action aggregates all results into a unified `Report` object before dispatching
to the chosen formatter.

### Report schema versioning

Every `Report` carries a `schemaVersion`, exported as `REPORT_SCHEMA_VERSION` from
`src/core/report.ts`. It is a monotonic integer rather than a semver string: the only
question a consumer of a stored report needs answered is "can I parse this?", and one
comparison settles it.

Reports are persisted — the GitHub Action uploads the JSON report as a build artifact, and
the Phase 3 dashboard archives raw `Report` JSON with a 90-day detail retention — so a
consumer reading a report it did not generate needs a way to detect a schema mismatch
rather than silently mis-parsing it.

**Bump `REPORT_SCHEMA_VERSION`** when a change would break a parser written against the
previous version:

- removing or renaming a field on `Report` or `CheckResult`
- changing an existing field's type
- adding a member to the `CheckStatus` or `Severity` unions, which a consumer handling
  them exhaustively would not recognise

**Do not bump it** for a purely additive optional field. Well-behaved parsers ignore
unknown keys, and bumping would force a pointless migration on every consumer.

## Phase 3 / Remaining Work

- **SEP-6 Programmatic Flows:** Validation of non-interactive deposit and withdrawal flows (deferred due to real/test fund movement considerations).
- **Hosted Public Dashboard:** Implementation of the hosted dashboard web application and continuous anchor registry crawler as outlined in [`docs/dashboard-design.md`](./docs/dashboard-design.md).
