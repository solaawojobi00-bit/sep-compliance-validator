# Anchor opt-in registry

This directory decides which anchors the public compliance dashboard is allowed to
validate and publish. **An anchor that is not listed here with `"enabled": true` is never
crawled and never appears on the dashboard.** There is no discovery, no scraping, and no
list of "known" anchors elsewhere — this file is the only source.

That is a deliberate design constraint, not an implementation detail: the dashboard
publishes pass/fail verdicts next to a named operator's domain, so being listed has to be
something an operator chose.

| File | Purpose |
|---|---|
| [`anchors.json`](./anchors.json) | The registry itself. One entry per anchor per network. |
| [`schema.json`](./schema.json) | JSON Schema (draft 2020-12) every entry must satisfy. Enforced in CI. |

## Opting in

Open a pull request adding one entry to [`anchors.json`](./anchors.json):

```json
{
  "domain": "anchor.example.com",
  "name": "Example Anchor",
  "network": "testnet",
  "enabled": true,
  "contact": "ops@example.com",
  "addedAt": "2026-09-04T00:00:00Z"
}
```

| Field | Notes |
|---|---|
| `domain` | Your anchor's home domain, exactly as you would pass it to the CLI: lowercase, no `https://`, no port, no path, no trailing dot. This is the entry's key. |
| `name` | How your anchor is labelled in the dashboard directory. |
| `network` | `testnet` or `mainnet`. Serving both? Add one entry per network — results are stored and shown separately. |
| `enabled` | `true` to be validated. See [Opting out](#opting-out). |
| `contact` | An email address, used only to contact you about your own results. |
| `addedAt` | The date you are adding the entry, as an ISO 8601 instant in UTC (e.g. `2026-09-04T00:00:00Z`). Not updated by later edits. |

Two CI checks run on your pull request:

1. **Schema and duplicates** — offline. Your entry must satisfy `schema.json`, and the
   domain must not already be registered for that network.
2. **stellar.toml reachable for added domains** — fetches
   `https://<your-domain>/.well-known/stellar.toml` and confirms it parses with the same
   parser the validator itself uses. Only domains *added or re-enabled* by your pull
   request are fetched, so an unrelated registry edit is never blocked by someone else's
   downtime.

If the second check fails on a transient outage rather than a real problem, ask a
maintainer to re-run the job.

### Proving the domain is yours

The automated `stellar.toml` check confirms your endpoint parses and extracts your published `SIGNING_KEY`.

To prove that you control the domain, you must sign a canonical registration challenge using the private key corresponding to the `SIGNING_KEY` declared in your `stellar.toml`.

#### Generating the proof

Run the helper script with your domain, network, `addedAt` timestamp, and secret key:

```bash
node scripts/sign-registry-proof.mjs <domain> <network> <addedAt> <SECRET_KEY> --out registry/proofs/<domain>.<network>.json
```

For example:

```bash
node scripts/sign-registry-proof.mjs anchor.example.com testnet 2026-09-04T00:00:00Z SXXX... --out registry/proofs/anchor.example.com.testnet.json
```

Or provide `STELLAR_SECRET_KEY` in your environment:

```bash
STELLAR_SECRET_KEY=SXXX... node scripts/sign-registry-proof.mjs anchor.example.com testnet 2026-09-04T00:00:00Z --out registry/proofs/anchor.example.com.testnet.json
```

The resulting file in `registry/proofs/<domain>.<network>.json` contains:

```json
{
  "domain": "anchor.example.com",
  "network": "testnet",
  "addedAt": "2026-09-04T00:00:00Z",
  "signingKey": "GXXX...",
  "signature": "..."
}
```

Commit this proof file alongside your change to `registry/anchors.json`. CI will verify the signature against the live `SIGNING_KEY` fetched from your `stellar.toml`.

#### Anchors without a `SIGNING_KEY`

If your `stellar.toml` does not declare a `SIGNING_KEY` (which SEP-1 allows as optional), automated signature verification is skipped and the registration falls back to maintainer review. Note that this registry deliberately does **not** ask you to add non-standard keys such as `[VALIDATOR] PUBLIC_DASHBOARD`.

## Opting out

Change your entry to `"enabled": false` in a pull request. The crawler stops visiting your
domain immediately on merge.

The entry itself is kept rather than deleted, so the record of who was listed and when
stays auditable — an entry vanishing from history would make it impossible to explain why
results exist for a domain that is no longer listed. Opting out is never blocked by the
reachability check: a domain that is already down is exactly when an operator may want out.

To have historical results removed as well, say so in the pull request; that is a
maintainer action, separate from the flag.

## Validating locally

```bash
npm run validate:registry
```

Checks the committed registry against the schema and reports duplicates — the same
offline gate CI runs. The logic lives in [`../scripts/registry-lib.mjs`](../scripts/registry-lib.mjs)
and is unit tested in [`../test/registry.test.mjs`](../test/registry.test.mjs).
