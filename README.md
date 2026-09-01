# SEP Compliance Validator

[![CI](https://github.com/solaawojobi00-bit/sep-compliance-validator/actions/workflows/ci.yml/badge.svg)](https://github.com/solaawojobi00-bit/sep-compliance-validator/actions/workflows/ci.yml)

Automated conformance checks for Stellar anchor [SEP](https://github.com/stellar/stellar-protocol/tree/master/ecosystem)
implementations. Point it at an anchor's home domain and it verifies that the
anchor's SEP-1 (`stellar.toml`), SEP-10 (web authentication), SEP-12 (KYC),
SEP-24 (interactive deposit/withdraw), and SEP-38 (quotes) endpoints actually behave
per spec — not just that the anchor *claims* to support them.

See [PRD.md](./PRD.md) for scope/goals and [ARCHITECTURE.md](./ARCHITECTURE.md)
for design details.

## Status

Phase 1 (this repo's current state): SEP-1 discovery/validation, the full
SEP-10 challenge/response flow (including negative-case handling: wrong
signer, wrong home domain, malformed JWT), SEP-12 KYC field conformance checks,
SEP-24 interactive deposit/withdraw endpoint checks, and SEP-38 price/quote
endpoint conformance checks. Later phases (mainnet support, CI packaging)
are tracked as GitHub issues.

## Install & use

### Zero-Install via npx

Run directly against any Stellar anchor with zero setup:

```bash
npx sep-compliance-validator check <domain> [--network testnet|mainnet] [--format table|json|html] [--client-domain <domain>] [--timeout <ms>] [--i-understand-this-touches-production]
```

### From Local Source

```bash
npm install
npm run build
node dist/cli.js check <domain> [--network testnet|mainnet] [--format table|json|html] [--client-domain <domain>] [--timeout <ms>] [--i-understand-this-touches-production]
```

### CLI Options

- `-n, --network <testnet|mainnet>`: Target network (default: `testnet`).
- `--i-understand-this-touches-production`: Required confirmation flag when running against `mainnet` to prevent unintended validation against production anchor infrastructure.
- `-f, --format <table|json|html>`: Output format (default: `table`).
- `--client-domain <domain>`: Client domain to exercise SEP-10 `client_domain` verification.
- `-t, --timeout <ms>`: Request timeout in milliseconds (default: `10000`).
- `--interactive-browser`: Run headless browser automation (Playwright) against SEP-24 interactive URL to validate forms and completion callbacks.

### Example

```bash
npx sep-compliance-validator check testanchor.stellar.org --network testnet
```

Runs against [Stellar's official testnet reference anchor](https://testanchor.stellar.org)
and prints a pass/fail table for every check, e.g.:

```
SEP Compliance Report for testanchor.stellar.org (testnet)
...
12/12 passed, 0 failed, 0 warnings
```

The process exits non-zero if any check fails, so it can be used as a CI gate.

## GitHub Action for Anchor CI Pipelines

You can use this validator directly as a GitHub Action in your anchor repository to automatically gate pull requests and deployments on SEP conformance.

Add a workflow file (e.g. `.github/workflows/sep-compliance.yml`):

```yaml
name: SEP Compliance Check

on:
  pull_request:
  push:
    branches: [main]

jobs:
  validate-anchor:
    runs-on: ubuntu-latest
    steps:
      - name: Validate Staging Anchor
        uses: solaawojobi00-bit/sep-compliance-validator@main
        with:
          domain: "staging.anchor.example.com"
          network: "testnet"
          format: "table"
```

The action fails the calling workflow (non-zero exit) whenever any check fails, blocking non-conformant changes from being merged.

## Publishing to npm

The repository includes a GitHub Actions workflow (`.github/workflows/publish.yml`) that automates publishing releases to npm when a version tag (e.g. `v0.1.0`) is pushed.

> [!NOTE]
> Automated publishing requires the repository secret `NPM_TOKEN` to be configured with an npm access token that has publishing permissions for `sep-compliance-validator`.

## Contributing & Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local dev setup instructions and a step-by-step walkthrough on how to add a checker for a new SEP.

```bash
npm test        # run the test suite (vitest)
npm run build   # compile TypeScript to dist/
```


