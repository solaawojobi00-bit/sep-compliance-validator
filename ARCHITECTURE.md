# Architecture: SEP Compliance Validator

## Tech Stack

- **Language/runtime:** TypeScript on Node.js (LTS, 20+).
- **Stellar SDK:** [`@stellar/stellar-sdk`](https://github.com/stellar/js-stellar-sdk) —
  the official JS SDK ships purpose-built SEP-10 helpers
  (`Utils.buildChallengeTx`, `Utils.readChallengeTx`, `Utils.verifyChallengeTxSigners`,
  `Utils.verifyTxSignedBy`) that implement the exact transaction-shape checks
  SEP-10 requires. Using these instead of hand-rolling XDR parsing keeps the
  validator's own logic correct and in sync with any future SDK-level spec fixes.
- **TOML parsing:** `smol-toml` (small, spec-compliant, no native deps).
- **CLI framework:** `commander` — minimal, well-understood, easy for
  contributors to extend with new subcommands per SEP.
- **HTTP:** native `fetch` (Node 20+ has it built in — no extra dependency).
- **CLI output:** `cli-table3` for terminal tables; JSON output is the
  primary machine-readable artifact.
- **Testing:** `vitest`.
- **Package distribution:** published to npm so it's runnable via
  `npx sep-compliance-validator` with zero local install — important for
  adoption, since the target users (anchor devs, integrators) want a
  quick one-off check, not a repo clone.

## Why this stack

The target users are Stellar ecosystem developers who are already working in
JS/TS in most cases (anchor reference implementations, wallet SDKs, and the
Stellar JS SDK itself are the dominant tooling language in this part of the
ecosystem). Building on the official SDK means SEP-10's cryptographic and
transaction-structure validation reuses audited, spec-maintained code rather
than a reimplementation that could silently drift from the spec.

## Integration with Stellar / Horizon

This tool validates **SEP-level HTTP/auth flows**, not on-chain Soroban
contracts — the SEPs it targets (1, 10, and later 12/24/38) are protocols
anchors implement as web services, not smart contracts. Its Stellar-network
touchpoints are:

- **Keypair generation:** uses `Keypair.random()` from the SDK to create a
  fresh testnet client account for each SEP-10 run — no funding or Horizon
  submission needed, since SEP-10 challenge transactions are never submitted
  to the network; they exist only to be signed and returned.
- **Network passphrase validation:** validates the anchor's declared
  `NETWORK_PASSPHRASE` in `stellar.toml` against the target network's
  passphrase (`Networks.TESTNET` or `Networks.PUBLIC`) with an actionable failure
  recommending the correct `--network` flag, and ensures the challenge transaction's
  passphrase matches the resolved network, preventing cascading downstream failures.
- **Horizon** is not required for v1's checks (SEP-10 doesn't touch Horizon
  directly). It becomes relevant in Phase 2 for SEP-6/SEP-24 flows that may
  need to confirm on-chain transaction effects.

## Structure

Single npm package for v1 (kept intentionally un-split — a multi-package
monorepo would be premature for the current scope):

```
sep-compliance-validator/
  src/
    cli.ts              # commander entrypoint, `check <domain>` command
    checks/
      sep1.ts            # stellar.toml fetch + field validation
      sep10.ts           # challenge/response flow + negative-case checks
    core/
      report.ts          # shared Check/Report types, pass/fail/warn aggregation
      http.ts            # thin fetch wrapper (timeouts, error normalization)
    output/
      json.ts            # JSON report writer
      table.ts           # CLI table renderer (cli-table3)
  test/
    sep1.test.ts
    sep10.test.ts
  package.json
  tsconfig.json
  README.md
  .env.example           # placeholder for any future config (e.g. custom RPC/Horizon URLs)
```

Each `checks/*.ts` module exports a list of `Check` objects with a common
shape (`{ id, description, severity, run(ctx) => CheckResult }`), so adding a
new SEP in Phase 2 (SEP-38, SEP-12, SEP-24) means adding a new file under
`checks/` and registering it in the CLI — this is the seam that keeps the
backlog sliceable into per-SEP, per-check issues rather than one monolithic
validation engine.
