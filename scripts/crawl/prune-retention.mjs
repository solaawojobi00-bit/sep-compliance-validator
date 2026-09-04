/**
 * Retention rules from docs/dashboard-design.md §4.3:
 *
 *   detail snapshots           90 days
 *   rolled-up daily statuses   1 year (enforced in aggregate-summary.mjs)
 *
 * This is what stands in for an object store's lifecycle rules, and is one of the reasons
 * §4.4 chose GitHub Pages over R2 / S3.
 */
import { LATEST_FILENAME, parseFileStamp } from "./storage-paths.mjs";

export const DETAIL_RETENTION_DAYS = 90;

function ageInDays(nowIso, iso) {
  return (Date.parse(nowIso) - Date.parse(iso)) / 86_400_000;
}

/**
 * Splits an anchor directory's filenames into what to keep and what to delete.
 *
 * Three rules, each with a reason:
 *
 *  - `latest.json` is never pruned. It is the pointer the detail view reads; deleting it
 *    would break the page for an anchor that simply has not been crawled lately.
 *  - A name that is not a recognisable stamp is never pruned. An unknown file in the
 *    archive is reported, not deleted - a pruner that removes what it does not understand
 *    is how an archive gets quietly destroyed.
 *  - A partial run ages exactly like a complete one. It is evidence of what was known at
 *    the time; `completeness` in summary.json is what stops it being *scored* like a
 *    complete run, so there is no reason to also shorten its life here.
 */
export function classifyDetailFiles(filenames, nowIso, retentionDays = DETAIL_RETENTION_DAYS) {
  const keep = [];
  const prune = [];
  const unrecognised = [];

  for (const name of filenames) {
    if (name === LATEST_FILENAME) {
      keep.push(name);
      continue;
    }

    const iso = parseFileStamp(name);
    if (!iso) {
      unrecognised.push(name);
      keep.push(name);
      continue;
    }

    if (ageInDays(nowIso, iso) > retentionDays) {
      prune.push(name);
    } else {
      keep.push(name);
    }
  }

  return { keep, prune, unrecognised };
}
