/**
 * FROZEN. Classifies a `warn` in a **schemaVersion 1** report as "the validator could not
 * verify this" rather than "the anchor has an advisory finding".
 *
 * #124 replaced this with an explicit `exercised` field on `CheckResult` (schemaVersion 2).
 * New reports carry the field, and `aggregate-summary.mjs` reads it directly.
 *
 * This file survives only because v1 reports are still inside the archive's retention
 * window, and `crawl.mjs` reads back every archived report to regenerate `summary.json`.
 * Deleting it outright would silently report `notVerified: 0` for every historical run —
 * exactly the "eight problems, seven of which are ours" misreading #124 set out to fix,
 * reintroduced through the back door for the dashboard's entire history.
 *
 * **It is frozen, not maintained.** The rot #124 objected to came from this being a live
 * parallel classifier that every new inconclusive check had to be taught about (#105 and
 * #106 each added one within two days, and nothing failed when the list fell behind). It
 * is no longer that: it decodes a closed set of reports that will never gain new check
 * ids, so it never needs updating again. Do not add ids here — a new check gets
 * `exercised` at its call site instead.
 *
 * Retire this file, and the `schemaVersion === 1` branch in `aggregate-summary.mjs`, once
 * no v1 report remains within `HISTORY_RETENTION_DAYS`.
 *
 * Two signals are used, because neither alone was sufficient:
 *
 *  1. A message prefix. Every unexercised v1 result opens with one of four phrasings
 *     ("Skipped:", "Not exercised:", "Inconclusive:", or "... NOT verified by this run").
 *  2. An explicit id list, as a backstop for results whose wording did not follow the
 *     convention.
 *
 * Both are heuristics over free text, which is precisely why the field superseded them.
 */
import { isCrawlUnavailable } from "./crawl-markers.mjs";

/**
 * Warn results that report a limit of the validator rather than a finding about the
 * anchor, listed where the v1 message convention did not already make that clear.
 *
 * The two SEP-10 negative cases are the load-bearing entries: their messages say the
 * anchor *was* rejected and then explain that the condition under test was not reached,
 * so they must never render as "this anchor has a problem" (see #77).
 */
const V1_NOT_VERIFIED_CHECK_IDS = new Set([
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

/**
 * Messages that state the check did not reach a verdict.
 *
 * Two regexes rather than one alternation, because the two halves are anchored
 * differently on purpose: three of the four v1 phrasings were message *prefixes*, while
 * "... NOT verified by this run" appeared mid-sentence after the anchor's own rejection
 * reason. Expressing that as `/^(a|b|c)\b|d/` puts an anchored and an unanchored branch in
 * one alternation, where the `^` silently applies to only the first — correct here, but
 * indistinguishable from the bug where someone meant it to apply to all of them
 * (CodeQL js/regex/missing-regexp-anchor).
 */
const V1_NOT_VERIFIED_PREFIX = /^(?:skipped|not exercised|inconclusive)\b/i;
const V1_NOT_VERIFIED_SUBSTRING = /not verified by this run/i;

/**
 * True when `result` — from a v1 report — is a warn that reports a limit of that run
 * rather than a property of the anchor.
 *
 * Only warns qualify: a `fail` is always a finding about the anchor, and a `pass` is a
 * verified one.
 */
export function isNotVerifiedV1(result) {
  if (!result || result.status !== "warn") {
    return false;
  }
  if (typeof result.id === "string") {
    if (isCrawlUnavailable(result) || V1_NOT_VERIFIED_CHECK_IDS.has(result.id)) {
      return true;
    }
  }
  if (typeof result.message !== "string") {
    return false;
  }
  return (
    V1_NOT_VERIFIED_PREFIX.test(result.message) ||
    V1_NOT_VERIFIED_SUBSTRING.test(result.message)
  );
}
