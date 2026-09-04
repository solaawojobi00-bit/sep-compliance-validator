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

**Delivered (v1):**
- SEP-1 discovery and `[[CURRENCIES]]` asset table validation.
- SEP-10 web authentication challenge/response flow, JWKS verification, custodial memo and muxed accounts, client domain verification, and negative-case challenge validation.
- SEP-12 KYC customer probing, synthetic identity generation, DELETE teardown, and `--no-write` read-only mode.
- SEP-24 interactive deposit/withdraw endpoints and Playwright headless browser automation (`--interactive-browser`).
- SEP-38 price and quote endpoint conformance checks.
- Formats: Table, JSON, and standalone HTML dashboard reports.
- Opt-in mainnet production validation guard (`--i-understand-this-touches-production`).
- Reusable GitHub Action composite workflow (`action.yml`) with job summaries and step outputs.

**Future Phases:**
- SEP-6 programmatic transfer flows.
- Hosted public dashboard web application (see [`docs/dashboard-design.md`](./docs/dashboard-design.md)).

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
- `-o, --output <file>`: Write rendered report to a file instead of stdout.
- `--only <seps>`: Comma-separated list of SEPs to validate (e.g. `sep1,sep10`).
- `--fail-on-warn`: Exit with status 1 if any check generates a warning.
- `-v, --verbose`: Print detailed HTTP request and response diagnostics to stderr.
- `--client-domain <domain>`: Client domain to exercise SEP-10 `client_domain` verification.
- `-t, --timeout <ms>`: Request timeout in milliseconds (default: `10000`).
- `--interactive-browser`: Run headless browser automation (Playwright) against SEP-24 interactive URL to validate forms and completion callbacks. Requires Playwright (`npm install playwright && npx playwright install chromium`).
- `--memo <id>`: Numeric ID memo for SEP-10 challenge authentication to validate custodial wallet flows.
- `--muxed`: Authenticate using a muxed (`M...`) account for SEP-10.
- `--no-write`: Disable state-mutating requests (such as SEP-12 `PUT /customer`). By default, SEP-12 validation performs mutating writes with randomized synthetic identities (`@invalid.test`) and cleans them up via `DELETE /customer/{account}` upon completion. Passing `--no-write` restricts checks to read-only probing and skips mutating operations with a warning.
- `--sep12-verification-code <code>`: A correct confirmation code for SEP-12 `PUT /customer/verification`. Without it the success path cannot be exercised — a correct code is delivered out of band to the customer, so the validator submits only a deliberately wrong one and reports the success-response schema as *not exercised*. Supplying a real code makes `sep12.verification_response_schema` a genuine pass or fail. Intended for an anchor operator validating their own anchor, who can read the code from their own logs, test phone, or staging stub. The code is never written to the report, the console, or a CI log. Has no effect under `--no-write`.
- `--sep12-verification-field <field>`: The SEP-9 field to verify with `--sep12-verification-code`, for anchors that flag several. Defaults to the first field the anchor flags as `VERIFICATION_REQUIRED`.

> **Note on `--sep12-verification-code` and failed-attempt lockouts.** The wrong-code probe (`sep12.verification_wrong_code`) is the flow's security assertion and always runs first — once a correct code has advanced a field to `ACCEPTED`, a later wrong-code request proves nothing. On an anchor that locks a customer out after N failed attempts, that first wrong code counts against the limit, so a supplied code may be refused for reasons unrelated to its correctness. This case is reported as a warning that names the lockout as a possible cause, not as a failure of your anchor's success response; resetting the synthetic test customer and re-running clears it.

### Exit Codes

- `0`: All checks passed (or warnings produced when `--fail-on-warn` is omitted).
- `1`: One or more checks failed (or produced warnings when `--fail-on-warn` is active).
- `2`: CLI usage / argument validation error.

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

### Action Inputs

| Input | Description | Default |
|---|---|---|
| `domain` | Anchor home domain to validate (**required**) | — |
| `network` | Target network (`testnet` or `mainnet`) | `testnet` |
| `format` | Console log format (`table`, `json`, or `html`) | `table` |
| `timeout` | Request timeout in milliseconds | `10000` |
| `client-domain` | Client domain for SEP-10 verification | — |
| `confirm-mainnet` | Set to `true` to confirm testing against production anchor on mainnet | `false` |
| `fail-on-warn` | Set to `true` to treat warning checks as failures | `false` |
| `only` | Comma-separated list of SEPs to validate (e.g. `sep1,sep10`) | — |
| `interactive-browser`| Run headless browser checks against SEP-24 interactive URL | `false` |
| `no-write` | Set to `true` to disable state-mutating requests (e.g. SEP-12 `PUT /customer`) | `false` |
| `artifact-name` | Name for the uploaded report artifact. Artifact names are unique per workflow run, so set this when the Action runs more than once in a run | `sep-compliance-report-<network>` |

### Action Outputs

| Output | Description |
|---|---|
| `pass` | Number of passed checks |
| `fail` | Number of failed checks |
| `warn` | Number of warning checks |
| `total` | Total number of checks executed |
| `report-path` | File path to the generated JSON compliance report |
| `exit-code` | Validator CLI exit code: `0` all checks passed, `1` one or more checks failed, `2` the invocation was rejected. Lets a pipeline tell "this anchor is non-conformant" apart from "the validator was called wrong" |

### Example Workflow

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
        id: validator
        uses: solaawojobi00-bit/sep-compliance-validator@main
        with:
          domain: "staging.anchor.example.com"
          network: "testnet"
          format: "table"
          fail-on-warn: "true"

      - name: Report Summary Metrics
        if: always()
        run: |
          echo "Validator results: ${{ steps.validator.outputs.pass }}/${{ steps.validator.outputs.total }} passed"
          echo "Report saved to ${{ steps.validator.outputs.report-path }}"
```

The action:
- Generates a Markdown summary table under `$GITHUB_STEP_SUMMARY` in the Actions UI.
- Uploads the full JSON report as a workflow artifact named `sep-compliance-report-<network>`.
- Fails the step (non-zero exit) whenever any check fails (or on warnings if `fail-on-warn: "true"`), blocking non-conformant changes from being merged.

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


