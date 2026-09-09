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
- **Package distribution & CI:** automated semantic versioning (`semantic-release`), manual npm publishing with OIDC provenance attestations (`--provenance`), and packaged as a reusable composite GitHub Action (`action.yml`). Supply chain and security gating via Actionlint, CodeQL, Gitleaks, and packaging smoke testing.

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
    index.ts            # Public programmatic API exports and types
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
      crawl-markers.mjs     # The crawler's own "leg did not run" marker ids
      legacy-v1-inconclusive.mjs # FROZEN: decodes "unverified" warns in schemaVersion 1 archives
  test/                 # vitest suites covering checks, core, renderers, CLI, public API, registry, crawler
  .github/workflows/
    ci.yml              # Build, test, lint, typecheck, coverage, actionlint, pack & action smoke tests
    codeql.yml          # CodeQL security analysis
    dashboard-crawl.yml # Daily anchor crawl (0 0 * * *)
    dependency-review.yml # Dependency review on pull requests
    live-anchor.yml     # Scheduled run against the live testnet reference anchor
    publish.yml         # npm publish on manual dispatch with provenance attestation
    registry-validate.yml # Registry schema + domain reachability gates on PRs
    release.yml         # Semantic-release automated versioning and tagging on main
    secret-scan.yml     # Gitleaks credential scanning on push and PR
  docs/
    dashboard-design.md # Architecture and data model for hosted dashboard web app
  .gitleaks.toml
  .releaserc.json
  eslint.config.js
  package.json
  tsconfig.json
  tsconfig.test.json
  vitest.config.ts
  LICENSE
  SECURITY.md
  CODE_OF_CONDUCT.md
  README.md
  PRD.md
  ARCHITECTURE.md
  CONTRIBUTING.md
```

Each check module in `checks/` runs a sequence of spec assertions and returns an array
of `CheckResult` objects (`{ id, description, status: "pass" | "fail" | "warn", severity, message }`).
The CLI action aggregates all results into a unified `Report` object before dispatching
to the chosen formatter.

### Not exercised vs advisory

A `warn` answers one of two different questions, and `exercised` says which:

- `exercised: false` — the condition under test was never reached, so the result reports a
  limit of this run and says nothing about the anchor. A missing optional endpoint, a
  `--no-write` skip, an anchor that short-circuited before the condition was evaluated.
- `exercised: true` — the check reached a verdict and found something advisory. A real, if
  minor, finding about the anchor.

The field is **required on `warn`** and absent on `pass`/`fail`, which are always
exercised. That is a discriminated union in `src/core/report.ts`, so `tsc` — not a
reviewer — guarantees every warn site declares which kind it is. Adding a check that emits
a warn without deciding this will not compile.

`severity` does not encode this: it distinguishes "counts toward the exit code" from "does
not", and both kinds are `severity: "warning"`. Message prose does not encode it reliably
either — four different phrasings were in use before the field existed, which is what
motivated it (#124).

Consequences worth knowing:

- `--fail-on-warn` gates on advisory warnings only. Failing a build for a condition the
  validator could not reach would fail it for something the operator cannot act on.
- The table and HTML renderers show a not-exercised result as `SKIP`, not `WARN`.
- `summarize()` reports `warn` (both kinds, unchanged), plus `advisory` and `notExercised`.
- `rollUpStatus` in the crawler is deliberately unchanged: a run whose only warnings were
  not exercised still rolls up to `warn`, never `pass`, because nothing was verified.

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
- adding a field whose *absence* is meaningful, because a consumer cannot otherwise tell
  "absent because this report predates the field" from "absent because it does not apply"

**Do not bump it** for a purely additive optional field whose absence carries no meaning.
Well-behaved parsers ignore unknown keys, and bumping would force a pointless migration on
every consumer.

**v1 → v2** added `exercised` to every `warn` (#124). It is additive, but it earns a bump
under the fourth rule above: on a v1 report the field is simply missing, and a reader that
assumed "missing means advisory" would silently report zero not-exercised results for the
dashboard's entire history. `schemaVersion` is how a reader picks the right
interpretation, which is why `aggregate-summary.mjs` branches on it rather than reading
the field unconditionally.

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
- **Retiring the v1 inconclusive heuristic:** `CheckResult.exercised` (#124) replaced the
  message-text heuristic for reports the CLI produces now. What remains is
  `scripts/crawl/legacy-v1-inconclusive.mjs`, which decodes schemaVersion 1 reports still
  inside the archive's retention window; `aggregate-summary.mjs` uses it only on the
  `schemaVersion === 1` branch. It is frozen, not maintained — it decodes a closed set of
  reports that will never gain new check ids, so the rot that motivated #124 (every new
  inconclusive check having to be taught to a parallel list) no longer applies. Delete it
  and that branch once no v1 report remains within `HISTORY_RETENTION_DAYS`.
- **SEP-6 Programmatic Flows:** validation of non-interactive deposit and withdrawal flows,
  deferred due to real/test fund movement considerations.
