# Architecture: SEP Compliance Validator

## Tech Stack

- **Language/runtime:** TypeScript on Node.js 22+ (`engines: ">=22"`). Node 20 was dropped
  when it reached end-of-life in April 2026; CI tests against 22.x and 24.x.
- **Stellar SDK:** [`@stellar/stellar-sdk`](https://github.com/stellar/js-stellar-sdk) v17
  — the official JS SDK ships purpose-built SEP-10 helpers in its `WebAuth` namespace. The
  validator uses two of them: `WebAuth.readChallengeTx`, which parses the anchor's
  challenge and verifies it against the `SIGNING_KEY` declared in `stellar.toml`
  (`sep10.ts`), and `WebAuth.buildChallengeTx`, which forges the wrong-network challenge
  used as a negative case (`sep10-negative.ts`). Using these instead of hand-rolling XDR
  parsing keeps the validator's own logic correct and in sync with any future SDK-level
  spec fixes. The optional `client_domain` co-signature is checked separately with
  `Keypair.verify` against the transaction hash, since it is verified against a key
  discovered from the client domain's own TOML rather than the anchor's.

  The v13 -> v17 upgrade (#145) was driven by a vulnerable transitive `toml` dependency,
  and it is a breaking change worth knowing about before editing the SEP-10 checkers: in
  v17, XDR unions expose class properties rather than accessor functions, byte fields come
  back as `Uint8Array` rather than `Buffer`, and signatures are `Signature` objects. That
  is most of what `sep10-negative.ts` has to work around when it assembles a deliberately
  malformed challenge by hand.
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
- **Testing:** `vitest` with v8 coverage across unit, integration, and CLI entry points. The
  thresholds in `vitest.config.ts` are a blocking CI gate, not just a report: 85% lines and
  statements, 82% branches, and 100% functions, with `src/checks/**` held to 80% branches.
- **Package distribution & CI:** automated semantic versioning (`semantic-release`), manual npm publishing with OIDC provenance attestations (`--provenance`), and packaged as a reusable composite GitHub Action (`action.yml`). Supply chain and security gating via Actionlint, CodeQL, Gitleaks, Dependabot, GitHub dependency review, a blocking production dependency audit (`npm audit --omit=dev --audit-level=high`, with the full tree audited advisory-only so dev-side advisories stay visible without turning CI red), and packaging smoke testing.

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
  dashboard/            # The public dashboard web app - static, no build step
    index.html          # Both views; the detail view is a hash route, #/anchor/<domain>
    app.js              # ES module: routing, data fetching, rendering, filters
    dashboard-lib.mjs   # Pure view logic (metrics, filtering, grouping), unit tested
    style.css           # Light/dark theming via [data-theme] and CSS custom properties
    data/               # Fallback sample data, used when dashboard-data has none yet
  registry/             # Anchor opt-in registry - the only source of crawlable domains
    anchors.json        # One entry per anchor per network
    schema.json         # JSON Schema (draft 2020-12) enforced in CI
    proofs/             # One signed ownership proof per entry, <domain>.<network>.json
    README.md           # Operator-facing opt-in / opt-out instructions
  scripts/
    registry-lib.mjs    # Registry parsing, normalization, duplicates, ownership proofs
    validate-registry.mjs   # Offline schema + duplicate gate (npm run validate:registry)
    check-registry-domains.mjs # Reachability + ownership gate for domains a PR adds
    sign-registry-proof.mjs # Operator-run signer for a registration proof
    render-report.mjs   # Renders a stored Report for the Action's job summary
    crawl/              # The dashboard crawler (see "Dashboard data pipeline" below)
      crawl.mjs         # Entry point: iterate registry, run legs, merge, archive, prune
      build-cli-args.mjs  # Leg definitions and argv construction
      run-anchor.mjs      # CLI spawn with the one retry, per-leg failure containment
      merge-legs.mjs      # Merges both legs into one canonical Report
      aggregate-summary.mjs # Regenerates data/summary.json from the archive
      prune-retention.mjs   # 90-day detail retention
      rate-limit.mjs        # On-demand registry gate and 6-hour per-domain cooldown
      storage-paths.mjs     # Archive layout and path-safety validation
      crawl-markers.mjs     # The crawler's own "leg did not run" marker ids
      legacy-v1-inconclusive.mjs # FROZEN: decodes "unverified" warns in schemaVersion 1 archives
  test/                 # vitest suites covering checks, core, renderers, CLI, public API,
                        # registry (schema, duplicates, ownership proofs), crawler
                        # (legs, merge, retention, rate limiting), and dashboard view logic
    fixtures/anchor/    # Hermetic self-signed-TLS stand-in for a SEP-1 conformant anchor,
                        # so the Action smoke test does not depend on a third party's uptime
  .github/
    dependabot.yml      # Weekly npm (production/development split) and github-actions updates
    PULL_REQUEST_TEMPLATE.md # Mirrors CONTRIBUTING's pull request checklist
    ISSUE_TEMPLATE/     # Bug report, feature request, and new-SEP-checker forms
    workflows/
      ci.yml            # Build, test, lint, typecheck, coverage gate, actionlint,
                        # dependency audits, pack & action smoke tests
      codeql.yml        # CodeQL security analysis
      dashboard-crawl.yml # Daily anchor crawl (0 0 * * *) and on-demand re-check
      dashboard-deploy.yml # Builds dashboard/ + dashboard-data into the Pages site
      dependency-review.yml # Dependency review on pull requests
      live-anchor.yml   # Scheduled run against the live testnet reference anchor
      publish.yml       # npm publish on manual dispatch with provenance attestation
      registry-validate.yml # Registry schema + domain reachability gates on PRs
      release.yml       # Semantic-release automated versioning and tagging on main
      secret-scan.yml   # Gitleaks credential scanning on push and PR
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
rather than silently mis-parsing it. There are two such consumers today. The crawler
validates `schemaVersion` both on the reports it has just produced and on every archived
report it reads back to regenerate `summary.json`; the dashboard web app validates it on
every `latest.json` it renders, against a version literal it has to keep in step by hand
(see *The web app* below).

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

The public dashboard is delivered end to end: registry, crawler, web app, and on-demand
re-check. Full design rationale is in
[`docs/dashboard-design.md`](./docs/dashboard-design.md); this section records what is
actually deployed.

**Flow:** `registry/anchors.json` → `.github/workflows/dashboard-crawl.yml` (daily,
`0 0 * * *`, or on demand) → `scripts/crawl/crawl.mjs` → archive on the `dashboard-data`
branch → `.github/workflows/dashboard-deploy.yml` → GitHub Pages.

### The registry is the only input

Nothing is crawled that is not listed in `registry/anchors.json` with `"enabled": true`.
There is no discovery and no scraping. The registry is schema-validated before it is used,
so a malformed entry fails the run rather than being crawled — being listed has to be
something an operator chose, because the dashboard publishes verdicts next to a named
operator's domain.

Choosing has to be provable, not merely asserted in a pull request, or anyone could list
someone else's domain. A registration therefore carries a proof file in `registry/proofs/`:
the operator signs the canonical string
`stellar-anchor-registry:<domain>:<network>:<addedAt>` with the secret key behind the
`SIGNING_KEY` their `stellar.toml` publishes, and `check-registry-domains.mjs` verifies that
ed25519 signature against the key it fetches live from the domain (`registry-lib.mjs`,
`evaluateOwnershipProof`). Binding the message to all three fields is what stops a proof
being replayed onto a different network or a re-registration.

A missing, replayed, or mis-signed proof fails the pull request. An anchor whose
`stellar.toml` declares no `SIGNING_KEY` — SEP-1 makes it optional — cannot be checked this
way, so it falls back to maintainer review rather than being refused outright. The registry
deliberately does not ask operators to add a non-standard TOML key such as
`[VALIDATOR] PUBLIC_DASHBOARD`, which §3.2 of the design doc floated as the alternative: a
signature proves control of the key SEP-10 already depends on, and invents nothing.

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

### On-demand re-checks

`dashboard-crawl.yml` also accepts a `workflow_dispatch` with a `domain` and an optional
`network`, so an operator who has shipped a fix does not wait for midnight UTC. With no
`domain` the dispatch is an ordinary full crawl.

Two gates apply, both in `scripts/crawl/rate-limit.mjs` rather than in the workflow YAML,
so they hold for a local `crawl.mjs --domain` run too:

- **Registry gate** (`validateOnDemandTarget`). The domain must be present *and* enabled.
  An unregistered domain and a disabled one are rejected with different messages, because
  they are different mistakes — one is "you never opted in", the other "you opted out".
  Without this gate the dispatch input would be a way to make the crawler visit any domain
  on demand, which is precisely what the opt-in registry exists to prevent.
- **6-hour cooldown** (`checkRateLimit`). Derived from the `timestamp` inside the archived
  `latest.json` for that domain and network, not from workflow run history or any counter
  the workflow keeps. The archive is the durable state the crawler already maintains, so
  the limit survives a lost run, a re-created branch, and a fresh runner; anything held in
  the workflow would not. The refusal names the exact instant the next run is permitted.

Both refusals exit non-zero, so an over-eager re-check shows as a failed run rather than
silently doing nothing. `crawl.mjs` accepts `--force` (`--skip-rate-limit`) to bypass the
cooldown for a maintainer running it locally; the workflow never passes it.

### The web app

`dashboard/` is plain HTML, CSS, and ES modules — no framework, no bundler, no build step.
The whole app is a `summary.json` fetch and a hash route, and a build pipeline would add a
toolchain to maintain and a compiled artifact to review for no behaviour the static files
do not already have.

Two views share one page. The directory (`/`) reads `data/summary.json` and renders the
metric row, search, network and status filters, and a 7-run sparkline per anchor. The
detail view (`#/anchor/<domain>?network=<network>`) reads that anchor's
`data/reports/<domain>/<network>/latest.json`, surfaces everything that failed or warned in
one section, and groups every `CheckResult` by SEP below it.

`schemaVersion` is validated on read here exactly as it is in the crawler: a report newer
than the app understands is refused with an explanatory message, never rendered
optimistically. One maintenance note — the browser cannot import `REPORT_SCHEMA_VERSION`
from the TypeScript source, so `validateReportSchema` carries the highest supported version
as a literal. **Bumping `REPORT_SCHEMA_VERSION` means updating `dashboard-lib.mjs` too**, or
the site starts refusing the reports the crawler has just published.

The view logic that is worth testing — metrics, filtering, sparkline windowing, SEP
grouping, schema validation — lives in `dashboard/dashboard-lib.mjs` as pure functions with
no DOM access, which is what lets `test/dashboard.test.mjs` cover it under the same vitest
run as everything else. `app.js` holds only the DOM wiring.

### Hosting

**GitHub Pages**, decided in [`docs/dashboard-design.md`](./docs/dashboard-design.md) §4.4
and now wired up. `dashboard-deploy.yml` checks out `main` and the `dashboard-data` branch,
copies the crawled `data/` tree in alongside the static assets, and deploys the combined
directory. Data and app therefore ship from separate branches on separate schedules — a
daily crawl does not redeploy the site, and a CSS change does not touch the archive. If the
data branch does not exist yet, the sample data committed under `dashboard/data/` is served
instead, so the site renders on a fresh clone and before the first crawl.

## Remaining Work

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
