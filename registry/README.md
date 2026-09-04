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

The automated `stellar.toml` check above proves the domain *works*, not that it is
*yours*. Registration is therefore also gated on human review: a maintainer confirms the
pull request comes from someone who controls the domain — typically by the PR being
authored from the anchor's own organisation, or by correspondence with the `contact`
address.

Stronger, automated proof — a signed SEP-10 challenge using the anchor's published
`SIGNING_KEY` — is tracked separately and is not yet implemented. Note that this registry
deliberately does **not** ask you to add a non-standard key such as
`[VALIDATOR] PUBLIC_DASHBOARD` to your `stellar.toml`: that field appears nowhere in
SEP-1, and one tool should not ask the ecosystem to carry a bespoke field on its behalf.

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
