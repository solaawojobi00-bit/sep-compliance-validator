import type { Report } from "../core/report.js";

export function printJson(report: Report): void {
  console.log(JSON.stringify(report, null, 2));
}
