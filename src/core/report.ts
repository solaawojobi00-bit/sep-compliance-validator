export type Severity = "error" | "warning";
export type CheckStatus = "pass" | "fail" | "warn";

export interface CheckResult {
  id: string;
  description: string;
  status: CheckStatus;
  severity: Severity;
  message: string;
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
 * **Do not bump it** for a purely additive optional field. Well-behaved parsers ignore
 * unknown keys, and bumping would force a pointless migration on every consumer.
 */
export const REPORT_SCHEMA_VERSION = 1;

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
  warn: number;
  total: number;
}

export function summarize(report: Report): ReportSummary {
  const pass = report.results.filter((r) => r.status === "pass").length;
  const fail = report.results.filter((r) => r.status === "fail").length;
  const warn = report.results.filter((r) => r.status === "warn").length;
  return { pass, fail, warn, total: report.results.length };
}
