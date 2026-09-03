# PRD: SEP Compliance Validator

## Problem

Stellar anchors (the services that connect fiat rails to the Stellar network for
deposits, withdrawals, KYC, and quotes) implement a set of open specs called SEPs
(Stellar Ecosystem Proposals) — chiefly SEP-1 (`stellar.toml` discovery), SEP-10
(web authentication), SEP-12 (KYC), SEP-24 (interactive deposit/withdraw), and
SEP-38 (quotes). Anchors self-report which SEPs they support and how well, but
there is no independent, automated way to verify that an anchor's implementation
actually conforms to spec.

This causes real, recurring problems:

- Wallets and dApp integrators write integration code against an anchor's stated
  SEP support, only to discover mid-integration that a required field is missing,
  a signature check is wrong, or an endpoint returns a non-conformant response.
- Anchor operators — especially smaller or newer ones serving underserved
  corridors, who may not have a large engineering team to cross-check every
  spec detail — have no self-check tool to validate their own implementation
  before going live or after a change.
- There is no neutral, third-party signal of "this anchor's endpoints actually
  behave per spec," which slows trust-building between anchors and integrators
  across the ecosystem.

## Target Users

- **Anchor developers/operators** who want to run an automated check against
  their own SEP implementations before deploying, or as part of CI,
  to catch regressions before they reach production.
- **Wallet and dApp integrators** evaluating whether a candidate anchor's
  endpoints are safe to integrate against, before writing integration code.

Explicitly not targeting end users depositing/withdrawing funds — this is a
developer/operator tool, not a consumer-facing product.

## Delivered Scope (v1)

Given an anchor's home domain, the tool supports:

1. **SEP-1 discovery and validation** (`src/checks/sep1.ts`, `src/checks/sep1-currencies.ts`)
   - Fetches `https://<domain>/.well-known/stellar.toml` over HTTPS with CORS, Content-Type, and size limit checks.
   - Parses TOML structure and validates required SEP-10 fields (`WEB_AUTH_ENDPOINT`, `SIGNING_KEY`, `NETWORK_PASSPHRASE`), and the `ANCHOR_QUOTE_SERVER` URL used by SEP-38.
   - Validates `[[CURRENCIES]]` asset table definitions (codes, issuers, display decimals, status, and supply/anchoring field consistency).

2. **SEP-10 web authentication flow validation** (`src/checks/sep10.ts`, `src/checks/sep10-negative.ts`)
   - Generates random testnet/mainnet keypairs to request and sign challenge transactions.
   - Validates challenge transaction structure (source accounts, `Manage Data` operations, sequence numbers, timebounds, server signature).
   - Supports custodial memo authentication (`--memo <id>`) and multiplexed accounts (`--muxed`).
   - Supports `client_domain` verification and TOML cross-signing (`--client-domain <domain>`).
   - Validates returned JWT claims and verifies signatures via anchor JWKS endpoints (`jose`).
   - Validates negative cases: expired challenge rejection, wrong-network passphrase rejection, tampered challenge rejection, and unauthorized client rejection.

3. **SEP-12 KYC customer API validation** (`src/checks/sep12.ts`)
   - Discovers KYC server via `KYC_SERVER` or fallback to `TRANSFER_SERVER`.
   - Probes `GET /customer` with authenticated JWT.
   - Creates randomized synthetic test customers using non-resolvable `@invalid.test` email addresses.
   - Validates input error handling by submitting malformed field types.
   - Purges created test customer records via best-effort `DELETE /customer/{account}` teardown.
   - Supports a read-only write-safety guard (`--no-write`) that skips mutating PUT calls with warnings.

4. **SEP-24 interactive deposit and withdrawal validation** (`src/checks/sep24.ts`, `src/checks/sep24-browser.ts`)
   - Validates `GET /info` supported deposit/withdraw assets (`enabled`, `min_amount`, `max_amount`).
   - Validates `POST /transactions/deposit/interactive` and `POST /transactions/withdraw/interactive`.
   - Validates transaction query endpoints (`GET /transaction`, `GET /transactions`).
   - Supports automated headless browser testing via Playwright (`--interactive-browser`) to probe interactive webapp forms and postMessage/redirect completion callbacks.

5. **SEP-38 quote server validation** (`src/checks/sep38.ts`)
   - Validates `GET /info` supported quote assets and conversion pairs.
   - Validates `GET /prices` single and multi-asset price quotes, requiring valid assets and reporting schema errors.
   - Validates `GET /price` indicative price quotes, schema types, positive numbers, and expiration timestamps.
   - Validates `POST /quote` firm quote creation and schema conformance.

6. **CLI and Output Renderers** (`src/cli.ts`, `src/output/`)
   - Flexible output formats: terminal ASCII table (`table`), machine-readable JSON (`json`), and standalone HTML report with dashboard CSS (`html`).
   - Output routing to stdout or file destination (`-o, --output <file>`).
   - Filterable execution targeting specific SEPs (`--only sep1,sep10`).
   - CI gating control (`--fail-on-warn`).
   - Verbose HTTP request/response debugging diagnostics (`-v, --verbose`).

7. **Mainnet validation guard**
   - Requires explicit opt-in confirmation (`--i-understand-this-touches-production`) when executing checks against mainnet anchors to protect production infrastructure.

8. **GitHub Action Composite Workflow** (`action.yml`)
   - Reusable GitHub Action for anchor CI pipelines.
   - Outputs metrics (`pass`, `fail`, `warn`, `total`, `report-path`).
   - Automatically writes summary tables to `$GITHUB_STEP_SUMMARY` and uploads report artifacts.

## Out of Scope / Future Work

- **SEP-6 programmatic deposit/withdraw execution** — moves real/test funds; deferred permanently or until mock sandbox infrastructure exists.
- **Hosted public dashboard / leaderboard** — technical design completed in [`docs/dashboard-design.md`](./docs/dashboard-design.md); implementation of the hosted web application and registry crawler is planned for Phase 3.
