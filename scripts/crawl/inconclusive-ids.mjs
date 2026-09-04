/**
 * INTERIM. Classifies a `warn` result as "the validator could not verify this" rather
 * than "the anchor has an advisory finding".
 *
 * Why this file exists: `CheckResult` has no field for the distinction. `status` is
 * pass/fail/warn and `severity` is error/warning, and both an unexercised check and a
 * genuine advisory finding are `warn` + `warning`. On a fully conformant live anchor
 * today, 7 of 8 warnings are unexercised checks and exactly 1 is advisory
 * (`sep12.fields.unknown_name`), so a dashboard that treats warnings uniformly tells an
 * operator with a perfect anchor that they have eight problems, seven of which are ours.
 *
 * **#124 is the real fix** - an explicit field on `CheckResult`, which is a
 * REPORT_SCHEMA_VERSION bump and touches every checker. When it lands, this file and its
 * tests are deleted and `aggregate-summary.mjs` reads the field instead.
 *
 * Two signals are used, because neither alone is sufficient:
 *
 *  1. A message prefix. Every unexercised result today opens with one of four phrasings
 *     ("Skipped:", "Not exercised:", "Inconclusive:", or "... NOT verified by this run").
 *     Matching them covers checks added after this file was written, which an id list
 *     cannot - #105 and #106 each added an inconclusive state within two days.
 *  2. An explicit id list, as a backstop for results whose wording does not follow the
 *     convention.
 *
 * Both are heuristics over free text, which is precisely why #124 supersedes them.
 */

/** Marker id suffix minted by merge-legs.mjs when a whole leg could not run. */
export const CRAWL_UNAVAILABLE_SUFFIX = ".crawl_unavailable";

/**
 * Warn results that report a limit of the validator rather than a finding about the
 * anchor, listed where the message convention does not already make that clear.
 *
 * The two SEP-10 negative cases are the load-bearing entries: their messages say the
 * anchor *was* rejected and then explain that the condition under test was not reached,
 * so they must never render as "this anchor has a problem" (see #77).
 */
export const NOT_VERIFIED_CHECK_IDS = new Set([
  // Rejected for a reason that shows the anchor short-circuited before the condition
  // under test was evaluated. A forged challenge cannot carry the anchor's real source
  // account, so expiry and passphrase are never reached.
  "sep10.negative.expired",
  "sep10.negative.wrong_network",
  // No JWKS endpoint published, so the JWT signature could not be checked at all.
  "sep10.jwt_signature",
  // Emitted as warn only when the SEP was skipped wholesale (server URL absent, or no
  // SEP-10 JWT available to authenticate with).
  "sep12.skipped",
  "sep24.skipped",
  "sep38.skipped",
]);

/** Messages that state the check did not reach a verdict. */
const NOT_VERIFIED_MESSAGE = /^(skipped|not exercised|inconclusive)\b|not verified by this run/i;

/**
 * True when `result` is a warn that reports a limit of this run rather than a property
 * of the anchor. Only warns qualify: a `fail` is always a finding about the anchor, and
 * a `pass` is a verified one.
 */
export function isNotVerified(result) {
  if (!result || result.status !== "warn") {
    return false;
  }
  if (typeof result.id === "string") {
    if (result.id.endsWith(CRAWL_UNAVAILABLE_SUFFIX) || NOT_VERIFIED_CHECK_IDS.has(result.id)) {
      return true;
    }
  }
  return typeof result.message === "string" && NOT_VERIFIED_MESSAGE.test(result.message);
}

/** True when this result is a leg-level "did not run" marker minted by the crawler. */
export function isCrawlUnavailable(result) {
  return typeof result?.id === "string" && result.id.endsWith(CRAWL_UNAVAILABLE_SUFFIX);
}
