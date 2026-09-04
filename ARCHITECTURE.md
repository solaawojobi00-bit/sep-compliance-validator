# Architecture: SEP Compliance Validator

## Tech Stack

- **Language/runtime:** TypeScript on Node.js 22+ (`engines: ">=22"`). Node 20 was dropped
  when it reached end-of-life in April 2026; CI tests against 22.x and 24.x.
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
- **HTTP:** native `fetch` (built in since Node 18) wrapped by `core/http.ts` with configurable timeout,
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

Single npm package and repository root composite action. Only `dist/` is published to npm
(`package.json` sets `"files": ["dist"]`); `registry/` and `scripts/` are contributor- and
CI-facing infrastructure that ships with the repository, not with the package.

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
  registry/             # Anchor opt-in registry - the only source of crawlable domains
    anchors.json        # One entry per anchor per network
    schema.json         # JSON Schema (draft 2020-12) enforced in CI
    README.md           # Operator-facing opt-in / opt-out instructions
  scripts/
    registry-lib.mjs    # Registry parsing, normalization, and duplicate detection
    validate-registry.mjs   # Offline schema + duplicate gate (npm run validate:registry)
    check-registry-domains.mjs # Reachability gate for domains a PR adds or re-enables
    render-report.mjs   # Renders a stored Report for the Action's job summary
    crawl/              # The dashboard crawler (see "Dashboard data pipeline" below)
      crawl.mjs         # Entry point: iterate registry, run legs, merge, archive, prune
      build-cli-args.mjs  # Leg definitions and argv construction
      run-anchor.mjs      # CLI spawn with the one retry, per-leg failure containment
      merge-legs.mjs      # Merges both legs into one canonical Report
      aggregate-summary.mjs # Regenerates data/summary.json from the archive
      prune-retention.mjs   # 90-day detail retention
      storage-paths.mjs     # Archive layout and path-safety validation
      inconclusive-ids.mjs  # INTERIM: classifies "unverified" warns (superseded by #124)
  test/                 # vitest suites covering checks, core, renderers, CLI, registry, crawler
  .github/workflows/
    ci.yml              # Build, test, lint, typecheck, coverage, action smoke tests
    dashboard-crawl.yml # Daily anchor crawl (0 0 * * *)
    registry-validate.yml # Registry schema + domain reachability gates on PRs
    live-anchor.yml     # Scheduled run against the live testnet reference anchor
    publish.yml         # npm publish on version tag
  docs/
    dashboard-design.md # Architecture and data model for hosted dashboard web app
  package.json
  tsconfig.json
  vitest.config.ts
  README.md
  PRD.md
  ARCHITECTURE.md
  CONTRIBUTING.md
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
the dashboard crawler archives raw `Report` JSON with a 90-day detail retention — so a
consumer reading a report it did not generate needs a way to detect a schema mismatch
rather than silently mis-parsing it. The crawler is that consumer today: it validates
`schemaVersion` both on the reports it has just produced and on every archived report it
reads back to regenerate `summary.json`.

**Bump `REPORT_SCHEMA_VERSION`** when a change would break a parser written against the
previous version:

- removing or renaming a field on `Report` or `CheckResult`
- changing an existing field's type
- adding a member to the `CheckStatus` or `Severity` unions, which a consumer handling
  them exhaustively would not recognise

**Do not bump it** for a purely additive optional field. Well-behaved parsers ignore
unknown keys, and bumping would force a pointless migration on every consumer.

## Dashboard data pipeline

The data layer behind the public dashboard is implemented and running. The frontend that
reads it is not yet built, so nothing is rendered — but the pipeline produces and archives
data on schedule today. Full design rationale is in
[`docs/dashboard-design.md`](./docs/dashboard-design.md); this section records what is
actually deployed.

**Flow:** `registry/anchors.json` → `.github/workflows/dashboard-crawl.yml` (daily,
`0 0 * * *`) → `scripts/crawl/crawl.mjs` → archive on the `dashboard-data` branch.

### The registry is the only input

Nothing is crawled that is not listed in `registry/anchors.json` with `"enabled": true`.
There is no discovery and no scraping. The registry is schema-validated before it is used,
so a malformed entry fails the run rather than being crawled — being listed has to be
something an operator chose, because the dashboard publishes verdicts next to a named
operator's domain.

### Two legs per anchor

Each anchor is validated by two CLI invocations, not one, because two flag conditions are
orthogonal and no single call satisfies both:

| Leg | `--only` | Publishes | Flags |
|---|---|---|---|
| `core` | `sep1,sep10,sep24,sep38` | all four | no `--no-write`, so SEP-38's `POST /quote` runs |
| `kyc` | `sep1,sep10,sep12` | `sep12` only | always `--no-write` |

A single combined call would have to carry `--no-write` (because it includes SEP-12) and
would lose SEP-38's quote coverage as collateral.

Note that the two lists differ for the `kyc` leg. `--only` is a **hard gate** in `cli.ts`,
not a filter over a full run: SEP-12 is only reached with the JWT SEP-10 produces, and
SEP-10 needs SEP-1's TOML, so the leg must name its dependencies to execute at all. It
publishes only `sep12.*`; the duplicate SEP-1 and SEP-10 results its dependency run
produces are dropped in favour of the `core` leg's, which are measured with the
client-domain and negative-case paths enabled.

`--no-write` is applied on **both** networks. The crawler never creates KYC records on any
anchor, testnet included. The consequence is that the `kyc` leg produces no SEP-12
*verdicts* — under `--no-write`, SEP-12's checks return six skips. The leg exists so the
published report says SEP-12 was *not exercised*, under SEP-12's own check ids, rather than
omitting SEP-12 and letting a reader infer it was fine.

### Failure is published, never hidden

Containment is per leg and per anchor. A leg that produces no usable report emits one
`warn` marker per SEP it owns (`<sep>.crawl_unavailable`) — `warn` and not `fail`, because
a `fail` asserts non-conformance the run did not observe, and a silent omission would let
the dashboard show "10/10 passed" while concealing that a third of the checks never ran.

Markers travel as ordinary `CheckResult`s inside `results`, which is what keeps
`summary.json` regenerable from the archive alone. The merged artifact is a plain `Report`
and nothing else, so anything written against `src/core/report.ts` can read it.

The whole run exits non-zero only when *no* anchor produced a usable leg — that indicates
the crawler, the build, or the runner's network, not the ecosystem.

### Storage and retention

Archived to the long-lived `dashboard-data` branch rather than `main`, so daily commits do
not bury `main`'s history or trigger its CI, while every published verdict stays auditable
in git.

```
data/reports/<domain>/<network>/<timestamp>.json   # 90-day detail retention
data/reports/<domain>/<network>/latest.json
data/summary.json                                  # 365-day rolled-up history
```

`summary.json` is **regenerated from the stored reports on every run**, never accumulated
in place, so it is reproducible from the archive. A run whose legs did not all execute is
flagged `completeness: "partial"` — scoring a partial as complete would let it *out-score*
a full run, since fewer checks executed means a higher pass ratio.

`schemaVersion` is validated on read. A stored report newer than the crawler understands is
skipped and surfaced as a warning, never parsed optimistically.

### Hosting

**GitHub Pages**, decided in [`docs/dashboard-design.md`](./docs/dashboard-design.md) §4.4.
Wiring Pages to serve the `dashboard-data` branch belongs to the frontend work — one
repository has one Pages site, so its layout is decided there. Until then the published
data is readable from the branch itself.

## Remaining Work

- **Dashboard frontend:** the static web app that reads `data/summary.json` — overview and
  directory listing, then the per-anchor detail view. This is what makes the pipeline above
  visible; it is the next piece of Phase 3.
- **On-demand re-check trigger:** `workflow_dispatch` with a per-domain input and rate
  limiting, so an operator can re-validate after shipping a fix. The workflow accepts a
  manual trigger today, but with no domain input and no rate limiting.
- **`CheckResult` verdict field:** the crawler currently distinguishes "we could not verify
  this" from "the anchor has an advisory finding" with a heuristic over message text
  (`scripts/crawl/inconclusive-ids.mjs`), because `CheckResult` has no field for it. The
  real fix is an explicit field — a `REPORT_SCHEMA_VERSION` bump touching every checker —
  after which that file and its tests are deleted.
- **SEP-6 Programmatic Flows:** validation of non-interactive deposit and withdrawal flows,
  deferred due to real/test fund movement considerations.
