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
  their own SEP-10/SEP-1 implementation before deploying, or as part of CI,
  to catch regressions before they reach production.
- **Wallet and dApp integrators** evaluating whether a candidate anchor's
  endpoints are safe to integrate against, before writing integration code.

Explicitly not targeting end users depositing/withdrawing funds — this is a
developer/operator tool, not a consumer-facing product.

## Core Scope (v1)

Given an anchor's home domain, the tool will:

1. **SEP-1 discovery and validation** — fetch `https://<domain>/.well-known/stellar.toml`,
   parse it, and validate presence/shape of the fields required for SEP-10 to
   function (`WEB_AUTH_ENDPOINT`, `SIGNING_KEY`, `NETWORK_PASSPHRASE`), flagging
   missing or malformed fields with clear error messages.
2. **SEP-10 web authentication flow validation** — using a freshly generated
   Stellar testnet keypair, perform the full SEP-10 challenge/response handshake
   against the anchor's `WEB_AUTH_ENDPOINT`:
   - Request a challenge transaction and validate its structure (correct source
     account, correct `Manage Data` operations, correct network passphrase,
     unexpired timebounds, signed by the anchor's `SIGNING_KEY`).
   - Sign the challenge with the client keypair and submit it.
   - Validate the returned JWT (correct issuer, subject matches client account,
     not expired).
   - Test negative cases: expired challenge rejected, wrong-network challenge
     rejected, tampered challenge rejected.
3. **Report output** — a structured JSON report (machine-readable, one object
   per check with `pass`/`fail`/`warn`, a message, and severity) and a
   human-readable CLI table summary.
4. **CLI entry point** — `npx sep-compliance-validator check <domain>`, runnable
   with zero local setup beyond Node.js, against real Stellar testnet anchors.

5. **Mainnet validation (supported, opt-in)** — `--network mainnet` is supported
   with an explicit confirmation flag (`--i-understand-this-touches-production`)
   to prevent unintended test runs against live production anchor infrastructure.
6. **SEP-24 interactive webapp automation** — `--interactive-browser` uses headless
   browser automation (Playwright) to validate form discovery and postMessage/redirect completion.

## Out of Scope (v1)

- SEP-6 programmatic deposit/withdraw execution (moves real/test funds —
  deferred, may remain out of scope permanently or sandboxed only).
- Hosted public dashboard / leaderboard of tested anchors (Phase 3).
- GitHub Action / CI packaging for anchor repos (Phase 2/3).
