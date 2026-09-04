/**
 * Builds data/summary.json from the stored report archive.
 *
 * Regenerated from the archive rather than accumulated in place (§4.2), so every field
 * here must be derivable from the stored reports alone. That is why a leg that did not
 * run is recorded as `*.crawl_unavailable` markers inside the report rather than as
 * crawler-side state: `completeness` below is read back out of those markers.
 */
import { isCrawlUnavailable, isNotVerified } from "./inconclusive-ids.mjs";

export const HISTORY_RETENTION_DAYS = 365;

/**
 * Counts by status, plus `notVerified` as a subset of `warn`.
 *
 * `notVerified` is not a fourth status - it counts the warnings that report a limit of
 * the validator rather than a finding about the anchor, so a consumer can say "8 warnings,
 * 7 of which we could not verify" instead of implying eight problems. See #124 for the
 * schema field that will replace the heuristic behind it.
 */
export function countResults(results) {
  const list = Array.isArray(results) ? results : [];
  return {
    pass: list.filter((r) => r.status === "pass").length,
    fail: list.filter((r) => r.status === "fail").length,
    warn: list.filter((r) => r.status === "warn").length,
    notVerified: list.filter((r) => isNotVerified(r)).length,
    total: list.length,
  };
}

/**
 * The single rolled-up status for a run.
 *
 * A `warn` never rolls up to `fail`. Only `fail` may be presented as a problem with the
 * anchor; `warn` is advisory or unverified. An empty result set rolls up to `warn`,
 * because nothing was verified - never to `pass`, which would read as a clean run.
 */
export function rollUpStatus(results) {
  const list = Array.isArray(results) ? results : [];
  if (list.length === 0) {
    return "warn";
  }
  if (list.some((r) => r.status === "fail")) {
    return "fail";
  }
  if (list.some((r) => r.status === "warn")) {
    return "warn";
  }
  return "pass";
}

/**
 * Whether every leg ran. Derived from the markers, so it survives regeneration.
 *
 * A `partial` run is retained on the same clock as a full one - it is evidence of what
 * was known at the time - but it is flagged so trend and compliance-rate math can exclude
 * it. Scoring a partial as if it were complete would make it *out-score* a full run: a
 * crawl where SEP-12 never executed would report 10/10 while a complete run with one real
 * failure reports 12/13, so the partial would look like an improvement.
 */
export function completenessOf(results) {
  const list = Array.isArray(results) ? results : [];
  return list.some((r) => isCrawlUnavailable(r)) ? "partial" : "full";
}

function daysBetween(laterIso, earlierIso) {
  return (Date.parse(laterIso) - Date.parse(earlierIso)) / 86_400_000;
}

/**
 * One summary entry for one anchor on one network.
 *
 * `reports` may be in any order; the newest by timestamp supplies the entry's headline
 * counts and status, and the history is every retained run in ascending order.
 */
export function buildEntry({ domain, network, reports, now, historyDays = HISTORY_RETENTION_DAYS }) {
  const sorted = [...reports].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const newest = sorted[sorted.length - 1];

  if (!newest) {
    throw new Error(`no reports for ${domain}/${network}`);
  }

  const history = sorted
    .filter((r) => daysBetween(now, r.timestamp) <= historyDays)
    .map((r) => ({
      timestamp: r.timestamp,
      status: rollUpStatus(r.results),
      completeness: completenessOf(r.results),
    }));

  return {
    domain,
    network,
    lastChecked: newest.timestamp,
    status: rollUpStatus(newest.results),
    completeness: completenessOf(newest.results),
    summary: countResults(newest.results),
    history,
  };
}

/**
 * The whole index. `groups` is `[{ domain, network, reports }]`; entries come out ordered
 * by domain then network so the published file is stable between runs.
 */
export function buildSummary(groups, { now, historyDays = HISTORY_RETENTION_DAYS } = {}) {
  const at = now ?? new Date().toISOString();
  return groups
    .map((group) => buildEntry({ ...group, now: at, historyDays }))
    .sort((a, b) => a.domain.localeCompare(b.domain) || a.network.localeCompare(b.network));
}
