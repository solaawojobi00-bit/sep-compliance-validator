import type { Report } from "../core/report.js";

export function renderJson(report: Report): string {
  return JSON.stringify(report, null, 2);
}

export function printJson(report: Report): void {
  console.log(renderJson(report));
}
