/**
 * The one place the published storage layout is expressed.
 *
 * Layout per docs/dashboard-design.md §4.2:
 *
 *   data/reports/<domain>/<network>/<timestamp>.json   per-run snapshot
 *   data/reports/<domain>/<network>/latest.json        latest pointer
 *   data/summary.json                                  aggregated index
 *
 * Domain first, then network — the order in §4.2, which is authoritative.
 */

export const REPORTS_ROOT = "data/reports";
export const SUMMARY_PATH = "data/summary.json";
export const LATEST_FILENAME = "latest.json";

/**
 * A path segment must not be able to escape the reports root. The registry schema
 * already constrains `domain` to a lowercase hostname, but this runs over data that
 * arrives from a file on disk, so it is checked again here rather than assumed.
 */
function assertSafeSegment(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  if (value === "." || value === ".." || /[/\\]/.test(value)) {
    throw new Error(`${label} is not a safe path segment: ${JSON.stringify(value)}`);
  }
}

/**
 * Filesystem- and URL-safe form of an ISO instant, used as the snapshot filename.
 *
 * The colons in `2026-09-05T00:00:00Z` are illegal in Windows filenames and have to be
 * percent-encoded in a URL, which would make the published paths awkward to share and
 * to check into git from a Windows contributor's machine. Dropping just the colons keeps
 * the stamp sortable as a string and reversible.
 */
export function fileStamp(iso) {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(iso)) {
    throw new Error(`timestamp must be an ISO 8601 UTC instant, got ${JSON.stringify(iso)}`);
  }
  return iso.replace(/:/g, "");
}

/** Inverse of fileStamp, for reading an archive back without a sidecar index. */
export function parseFileStamp(name) {
  const base = name.replace(/\.json$/, "");
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/.exec(base);
  if (!match) {
    return undefined;
  }
  const [, date, hh, mm, ss, frac] = match;
  return `${date}T${hh}:${mm}:${ss}${frac ?? ""}Z`;
}

export function anchorDir(domain, network) {
  assertSafeSegment(domain, "domain");
  assertSafeSegment(network, "network");
  return `${REPORTS_ROOT}/${domain}/${network}`;
}

export function reportPath(domain, network, iso) {
  return `${anchorDir(domain, network)}/${fileStamp(iso)}.json`;
}

export function latestPath(domain, network) {
  return `${anchorDir(domain, network)}/${LATEST_FILENAME}`;
}
