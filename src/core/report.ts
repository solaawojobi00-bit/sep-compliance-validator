export type Severity = "error" | "warning";
export type CheckStatus = "pass" | "fail" | "warn";

interface CheckResultFields {
  id: string;
  description: string;
  severity: Severity;
  message: string;
}

/**
 * A single check's verdict.
 *
 * `status` alone cannot express the difference between the two things a `warn` used to
 * mean: "we could not exercise this condition" and "we exercised it and found something
 * advisory". `exercised` carries that distinction, and it is **required on `warn`** so the
 * compiler — not a reviewer — guarantees every warn site declares which kind it is.
 *
 * A `pass` or `fail` is always exercised: you cannot verify a condition you never reached,
 * and a failure is always a finding about the anchor. Those arms therefore do not carry
 * the field, which keeps the distinction where it is actually ambiguous.
 */
export type CheckResult =
  | (CheckResultFields & { status: "pass" | "fail"; exercised?: undefined })
  | (CheckResultFields & {
      status: "warn";
      /**
       * `false` when this result reports a limit of the run rather than a property of the
       * anchor — the condition under test was never reached, so the result says nothing
       * about the anchor. `true` for a genuine, if minor, advisory finding.
       */
      exercised: boolean;
    });

/**
 * True when `result` is a warn that reports a limit of this run rather than a property of
 * the anchor.
 *
 * Only warns qualify: a `fail` is always a finding about the anchor and a `pass` is a
 * verified one. This replaces the message-prefix and id-list heuristics the crawler used
 * before this field existed, now frozen as a schemaVersion 1 decoder in
 * `scripts/crawl/legacy-v1-inconclusive.mjs`.
 */
export function isNotExercised(result: CheckResult): boolean {
  return result.status === "warn" && result.exercised === false;
}

/**
 * Version of the `Report` schema this build emits.
 *
 * A monotonic integer rather than a semver string: the only question a consumer of a
 * stored report needs answered is "can I parse this?", and one comparison settles it.
 * Semver's minor/patch distinction carries no meaning for a data schema.
 *
 * **Bump it** when a change would break a parser written against the previous version:
 * removing or renaming a field, changing a field's type, or adding a member to the
 * `CheckStatus` / `Severity` unions that a consumer handling them exhaustively would not
 * recognise.
 *
 * **Also bump it** for an added field whose *absence* is meaningful, because a consumer
 * cannot otherwise tell "absent because this report predates the field" from "absent
 * because the field does not apply". `exercised` is the case in point: absent on a `warn`
 * means v1, where the distinction was unavailable and every warn had to be treated as a
 * possible finding.
 *
 * **Do not bump it** for a purely additive optional field whose absence carries no
 * meaning. Well-behaved parsers ignore unknown keys, and bumping would force a pointless
 * migration on every consumer.
 */
export const REPORT_SCHEMA_VERSION = 2;

export interface Report {
  /** Schema version of this report; see {@link REPORT_SCHEMA_VERSION}. */
  schemaVersion: number;
  domain: string;
  network: "testnet" | "mainnet";
  timestamp: string;
  results: CheckResult[];
}

export interface ReportSummary {
  pass: number;
  fail: number;
  /**
   * Every `warn`, of both kinds. Unchanged from v1 so that existing readers of this
   * number keep their meaning; `advisory` and `notExercised` split it.
   */
  warn: number;
  /** Warns that found something advisory about the anchor. */
  advisory: number;
  /** Warns that report a limit of this run rather than anything about the anchor. */
  notExercised: number;
  total: number;
}

export function summarize(report: Report): ReportSummary {
  const pass = report.results.filter((r) => r.status === "pass").length;
  const fail = report.results.filter((r) => r.status === "fail").length;
  const warn = report.results.filter((r) => r.status === "warn").length;
  const notExercised = report.results.filter(isNotExercised).length;
  return { pass, fail, warn, advisory: warn - notExercised, notExercised, total: report.results.length };
}
