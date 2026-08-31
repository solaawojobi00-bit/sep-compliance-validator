# SEP Compliance Validator

[![CI](https://github.com/solaawojobi00-bit/sep-compliance-validator/actions/workflows/ci.yml/badge.svg)](https://github.com/solaawojobi00-bit/sep-compliance-validator/actions/workflows/ci.yml)

Automated conformance checks for Stellar anchor [SEP](https://github.com/stellar/stellar-protocol/tree/master/ecosystem)
implementations. Point it at an anchor's home domain and it verifies that the
anchor's SEP-1 (`stellar.toml`), SEP-10 (web authentication), SEP-12 (KYC),
and SEP-38 (quotes) endpoints actually behave per spec — not just that the
anchor *claims* to support them.

See [PRD.md](./PRD.md) for scope/goals and [ARCHITECTURE.md](./ARCHITECTURE.md)
for design details.

## Status

Phase 1 (this repo's current state): SEP-1 discovery/validation, the full
SEP-10 challenge/response flow (including negative-case handling: wrong
signer, wrong home domain, malformed JWT), SEP-12 KYC field conformance checks,
and SEP-38 price/quote endpoint conformance checks. Later phases (SEP-24,
mainnet support, CI packaging) are tracked as GitHub issues.

## Install & use

```bash
npm install
npm run build
node dist/cli.js check <domain> [--network testnet|mainnet] [--format table|json] [--client-domain <domain>]
```

### CLI Options

- `-n, --network <testnet|mainnet>`: Target network (default: `testnet`).
- `-f, --format <table|json>`: Output format (default: `table`).
- `--client-domain <domain>`: Client domain to exercise SEP-10 `client_domain` verification.

### Example

```bash
node dist/cli.js check testanchor.stellar.org --network testnet
```

Runs against [Stellar's official testnet reference anchor](https://testanchor.stellar.org)
and prints a pass/fail table for every check, e.g.:

```
SEP Compliance Report for testanchor.stellar.org (testnet)
...
12/12 passed, 0 failed, 0 warnings
```

The process exits non-zero if any check fails, so it can be used as a CI gate.

## Contributing & Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local dev setup instructions and a step-by-step walkthrough on how to add a checker for a new SEP.

```bash
npm test        # run the test suite (vitest)
npm run build   # compile TypeScript to dist/
```

