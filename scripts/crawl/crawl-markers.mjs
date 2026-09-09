/**
 * The crawler's own "this leg did not run" markers.
 *
 * These are structural, not heuristic: the crawler mints these ids itself in
 * `merge-legs.mjs`, so recognising one is an exact suffix match rather than a guess about
 * free text. They were previously colocated with the message/id heuristics, which are now
 * a frozen schemaVersion 1 decoder (`legacy-v1-inconclusive.mjs`). These outlive it: the
 * markers are still minted for every new crawl.
 */

/** Marker id suffix minted by merge-legs.mjs when a whole leg could not run. */
export const CRAWL_UNAVAILABLE_SUFFIX = ".crawl_unavailable";

/** True when this result is a leg-level "did not run" marker minted by the crawler. */
export function isCrawlUnavailable(result) {
  return typeof result?.id === "string" && result.id.endsWith(CRAWL_UNAVAILABLE_SUFFIX);
}
