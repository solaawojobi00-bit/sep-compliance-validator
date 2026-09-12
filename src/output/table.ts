import Table from "cli-table3";
import type { Report } from "../core/report.js";
import { isNotExercised, summarize } from "../core/report.js";

const STATUS_ICON: Record<string, string> = {
  pass: "PASS",
  fail: "FAIL",
  warn: "WARN",
};

/**
 * A terminal reader has the same interpretation problem a dashboard does: a `warn` that
 * means "we could not exercise this" is not a finding, and rendering it as WARN reads as
 * one. `SKIP` keeps the two apart at a glance.
 */
const NOT_EXERCISED_ICON = "SKIP";

export function renderTable(report: Report): string {
  const parts: string[] = [];
  parts.push(`\nSEP Compliance Report for ${report.domain} (${report.network})\n`);

  const table = new Table({
    head: ["Status", "Check", "Message"],
    wordWrap: true,
    colWidths: [8, 55, 50],
  });

  for (const r of report.results) {
    const icon = isNotExercised(r) ? NOT_EXERCISED_ICON : (STATUS_ICON[r.status] ?? r.status);
    table.push([icon, `${r.id}\n${r.description}`, r.message]);
  }
  parts.push(table.toString());

  const { pass, fail, advisory, notExercised, total } = summarize(report);
  const counts = [`${pass}/${total} passed`, `${fail} failed`, `${advisory} warnings`];
  if (notExercised > 0) {
    counts.push(`${notExercised} not exercised`);
  }
  parts.push(`\n${counts.join(", ")}\n`);
  return parts.join("\n");
}

export function printTable(report: Report): void {
  console.log(renderTable(report));
}
