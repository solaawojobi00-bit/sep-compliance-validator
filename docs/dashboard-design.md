# Design Proposal: Public Anchor Compliance Dashboard

## Status
- **Status:** Partially implemented — sub-issues 1 and 2 of 5 are merged (see [§7](#7-follow-up-issues-breakdown-tiered--scoped)).
  The registry and the daily crawler exist and run; no frontend has been built, so nothing
  is rendered yet. Sections describing those two pieces now document deployed behaviour
  rather than a proposal.
- **Related Issue:** [#16](https://github.com/solaawojobi00-bit/sep-compliance-validator/issues/16)
- **Target Phase:** Phase 3 (as identified in `PRD.md`)

---

## 1. Overview & Problem Statement

Stellar anchors implement Stellar Ecosystem Proposals (SEPs) to provide interoperable fiat on/off-ramps, authentication, and quote services. While `sep-compliance-validator` provides a CLI for local and CI-based testing against testnet anchors, integrators and wallet developers currently lack a centralized, neutral trust signal indicating which anchors conform to spec over time.

This document proposes the architecture for a hosted public compliance dashboard. The dashboard will track opted-in anchors, execute automated compliance checks, store historical results, and display an accessible public overview of compliance health without requiring stakeholders to run the CLI locally.

---

## 2. Core Design Goals

1. **Explicit Opt-In:** Anchors must intentionally opt in; unverified or non-participating endpoints are not scraped or spammed.
2. **Deterministic & Auditable Storage:** Compliance records must use the existing `Report` schema (`src/core/report.ts`) with clear timestamps and verifiable audit trails.
3. **Low-Maintenance Automation:** Periodic checks must run reliably without complex server infrastructure.
4. **Lightweight, High-Performance Frontend:** Integrators must be able to view overall status, search by domain, and inspect per-check failures in a clean web UI.
5. **Phase-Gated Rollout:** The proposal must break down into small, independently reviewable and testable tasks.

---

## 3. Architecture & Opt-In Mechanism

### 3.1 Anchor Registry (`registry/anchors.json`)
Anchors opt in via GitOps by submitting a pull request to add an entry to a versioned registry file:

```json
[
  {
    "domain": "testanchor.stellar.org",
    "name": "Stellar Test Anchor",
    "network": "testnet",
    "enabled": true,
    "contact": "dev@stellar.org",
    "addedAt": "2026-09-01T00:00:00Z"
  }
]
```

### 3.2 Domain Verification & Ownership
To prevent unauthorized parties from registering third-party domains:
1. **Automated TOML Check:** The registration PR triggers a GitHub Action workflow that verifies `https://<domain>/.well-known/stellar.toml` is reachable and parses successfully.
2. **Opt-In Signal:** The anchor's `stellar.toml` may optionally declare:
   ```toml
   [VALIDATOR]
   PUBLIC_DASHBOARD = true
   ```
   Or alternatively, registration PRs must be authored by verified domain maintainers (or verified via a signed SEP-10 challenge using the anchor's published `SIGNING_KEY`).

### 3.3 Opt-Out
An anchor operator can opt out at any time by:
- Setting `"enabled": false` via a PR against `registry/anchors.json`.
- Setting `PUBLIC_DASHBOARD = false` in their `stellar.toml`.
The automated runner will cease checking the domain and archive or hide historical entries based on operator preference.

---

## 4. Storage for Historical Results

### 4.1 Storage Unit
Storage directly uses the canonical, **versioned** `Report` data structure defined in
`src/core/report.ts`:

```typescript
export interface Report {
  /** Schema version of this report; see REPORT_SCHEMA_VERSION. */
  schemaVersion: number;
  domain: string;
  network: "testnet" | "mainnet";
  timestamp: string;
  results: CheckResult[];
}
```

`schemaVersion` is a monotonic integer, bumped only when a change would break a parser
written against the previous version (see the *Report schema versioning* section of
[`ARCHITECTURE.md`](../ARCHITECTURE.md) for the bump policy).

**The runner must validate `schemaVersion` on read.** Detail snapshots are retained for 90
days and rolled-up summaries for a year, so the archive will outlive schema changes. A
stored report whose `schemaVersion` exceeds the reader's supported version must be skipped
or migrated explicitly — never parsed optimistically, since that is how a year of history
turns into silently wrong dashboard data. A report with no `schemaVersion` at all predates
this field and should be treated as unversioned legacy data.

### 4.2 Storage Layout & Artifact Strategy
To eliminate server hosting costs and retain high availability, results will be stored as static JSON artifacts published to **GitHub Pages** (decided; see [§4.4](#44-hosting-target-decision)):

- **Per-Run Historical Snapshots:**
  `data/reports/<domain>/<network>/<timestamp>.json`
- **Latest Report Pointer:**
  `data/reports/<domain>/<network>/latest.json`
- **Aggregated Dashboard Index (`data/summary.json`):**
  A generated index containing summaries for fast loading:
  ```json
  [
    {
      "domain": "testanchor.stellar.org",
      "network": "testnet",
      "lastChecked": "2026-09-01T00:00:00Z",
      "summary": {
        "pass": 10,
        "fail": 0,
        "warn": 0,
        "total": 10
      },
      "history": [
        { "timestamp": "2026-08-31T00:00:00Z", "status": "pass" },
        { "timestamp": "2026-09-01T00:00:00Z", "status": "pass" }
      ]
    }
  ]
  ```

### 4.3 Retention Policy
- Retain detailed run JSON reports for **90 days**.
- Retain rolled-up daily pass/fail statuses in `summary.json` for **1 year** for trend analysis.

### 4.4 Hosting Target (Decision)

**Decision: GitHub Pages, not Cloudflare R2 / S3.** §4.2 originally left this open; the
runner issue cannot be implemented without settling it, so it is settled here.

Rationale:

- **No new secrets or external accounts.** The repository already runs entirely on the
  existing GitHub PAT. R2 or S3 would add bucket credentials as repository secrets —
  extra attack surface and audit burden, which is a poor trade for a tool whose purpose
  is compliance assurance.
- **Retention does not need object-store lifecycle rules.** The 90-day and 1-year policy
  in §4.3 is enforced by the pruning step in the runner, which does the job S3 lifecycle
  rules would do. Lifecycle management is therefore not a reason to prefer R2 / S3 here.
- **Public verdicts belong behind a plain URL.** No bucket auth in front of the data,
  consistent with the transparency goal this dashboard exists to serve (§2, and the
  neutral trust signal in §1).
- **Not a one-way door.** If `summary.json` volume or Pages bandwidth limits become a
  real constraint, moving the publish step to R2 / S3 is a contained follow-up: the
  crawler, the storage layout in §4.2, the aggregation step, and the frontend's
  `summary.json` contract are all unchanged by that swap. Only the publish target moves.

---

## 5. Re-Check Cadence & Automation

### 5.1 Cadence
- **Scheduled Automated Runs:** Every 24 hours (daily at 00:00 UTC) via scheduled GitHub Actions cron (`0 0 * * *`).
- **On-Demand Runs:** Anchor maintainers can trigger a re-run via `workflow_dispatch` (or a webhook handler) when deploying fixes, with rate-limiting restricted to once per 6 hours per domain.

### 5.2 Failure & Transient Error Mitigation
To prevent false alarms caused by transient network blips:
1. If a check fails due to an HTTP timeout or network error (5xx), the runner immediately retries once with exponential backoff (10s delay).
2. If consecutive failures persist, the report records the failure with severity `"error"` and logs the normalized message.

---

## 6. Minimal Frontend for v1 Dashboard

The v1 dashboard is a lightweight static web app deployed on GitHub Pages or Cloudflare Pages, reading from `data/summary.json` and individual `latest.json` files.

### 6.1 Views & Capabilities
1. **Directory / Overview Page (`/`):**
   - **Header & Metrics:** Total anchors tracked, overall compliance rate, last update timestamp.
   - **Filter & Search:** Real-time search by anchor domain; filter by Network (`testnet` / `mainnet`) and Status (`Passing`, `Failing`, `Warnings`).
   - **Anchor Table / Cards:**
     - Domain name with link to `stellar.toml`
     - Network badge (`testnet`)
     - Status indicator (`PASS`, `FAIL`, `WARN`)
     - Passing checks ratio (e.g. `10/10`)
     - Sparkline / dots representing the last 7 daily runs
     - "View Report" action button
2. **Anchor Detail View (`/anchor/<domain>`):**
   - Summary status header.
   - Breakdown grouped by SEP (e.g., SEP-1: Discovery, SEP-10: Web Authentication).
   - List of individual checks with `id`, description, pass/fail status, and diagnostic error message when failing.
   - Download raw report as JSON button.

---

## 7. Follow-Up Issues Breakdown (Tiered & Scoped)

To ensure this initiative is delivered safely and incrementally, implementation will be split into 5 scoped follow-up issues:

| Issue | Title | Tier & Estimate | Status | Scope & Deliverables |
|---|---|---|---|---|
| **Sub-Issue 1** | **Anchor Opt-In Registry & Schema Validation** | Low (30 pts) | ✅ Merged (#87) | Add `registry/anchors.json`, define JSON Schema for registry entries, and write CI workflow to validate PR submissions and domain reachability. |
| **Sub-Issue 2** | **Automated Validation Runner & Results Pipeline** | Medium (80 pts) | ✅ Merged (#88) | Build the daily GitHub Actions runner to iterate through active registry domains, invoke `sep-compliance-validator`, output `Report` JSONs, and compile `data/summary.json`. Publishes to GitHub Pages per [§4.4](#44-hosting-target-decision). |
| **Sub-Issue 3** | **Dashboard Web App — Overview & Directory Listing** | Medium (80 pts) | Not started | Set up static frontend app (Vite/React/HTML), parse `summary.json`, implement table listing with domain search, status filters, and pass/fail badges. Also wires GitHub Pages to serve the `dashboard-data` branch — one repository has one Pages site, so the serving layout is decided here rather than in sub-issue 2. |
| **Sub-Issue 4** | **Dashboard Web App — Detailed Anchor Report View** | Medium (60 pts) | Not started | Implement anchor detail route showing check results grouped by SEP, error message inspection, and link to raw report JSON. |
| **Sub-Issue 5** | **On-Demand Re-check Trigger & Webhook Integration** | Low (40 pts) | Not started | Add `workflow_dispatch` support with rate limiting to allow maintainers to trigger validation after releasing endpoint fixes. The crawl workflow accepts a bare manual trigger today, with no per-domain input and no rate limiting. |

### Implementation notes from sub-issue 2

Two details worth recording, because they are non-obvious from the design above and a
future reader would otherwise reasonably assume the simpler thing:

- **Each anchor is crawled in two CLI invocations, not one.** SEP-12 requires `--no-write`
  (the crawler must never create KYC records), but `--no-write` also suppresses SEP-38's
  `POST /quote` checks. The two conditions are orthogonal, so a single call cannot satisfy
  both without losing coverage. See ARCHITECTURE.md, "Dashboard data pipeline".
- **`--only` is a hard gate, not a filter.** The SEP-12 leg must name `sep1` and `sep10` in
  `--only` to execute at all: SEP-12 needs the JWT SEP-10 issues, and SEP-10 needs SEP-1's
  TOML. It still publishes only its own `sep12.*` results.
