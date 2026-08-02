export type Severity = "error" | "warning";
export type CheckStatus = "pass" | "fail" | "warn";

export interface CheckResult {
  id: string;
  description: string;
  status: CheckStatus;
  severity: Severity;
  message: string;
}

export interface Report {
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
