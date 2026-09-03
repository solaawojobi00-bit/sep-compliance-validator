# Design Proposal: Public Anchor Compliance Dashboard

## Status
- **Status:** Proposed
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
To eliminate server hosting costs and retain high availability, results will be stored as static JSON artifacts published to GitHub Pages or Cloudflare R2 / S3:

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

| Issue | Title | Tier & Estimate | Scope & Deliverables |
|---|---|---|---|
| **Sub-Issue 1** | **Anchor Opt-In Registry & Schema Validation** | Low (30 pts) | Add `registry/anchors.json`, define JSON Schema for registry entries, and write CI workflow to validate PR submissions and domain reachability. |
| **Sub-Issue 2** | **Automated Validation Runner & Results Pipeline** | Medium (80 pts) | Build the daily GitHub Actions runner to iterate through active registry domains, invoke `sep-compliance-validator`, output `Report` JSONs, and compile `data/summary.json`. |
| **Sub-Issue 3** | **Dashboard Web App — Overview & Directory Listing** | Medium (80 pts) | Set up static frontend app (Vite/React/HTML), parse `summary.json`, implement table listing with domain search, status filters, and pass/fail badges. |
| **Sub-Issue 4** | **Dashboard Web App — Detailed Anchor Report View** | Medium (60 pts) | Implement anchor detail route showing check results grouped by SEP, error message inspection, and link to raw report JSON. |
| **Sub-Issue 5** | **On-Demand Re-check Trigger & Webhook Integration** | Low (40 pts) | Add `workflow_dispatch` support with rate limiting to allow maintainers to trigger validation after releasing endpoint fixes. |
