import Table from "cli-table3";
import type { Report } from "../core/report.js";
import { summarize } from "../core/report.js";

const STATUS_ICON: Record<string, string> = {
  pass: "PASS",
  fail: "FAIL",
  warn: "WARN",
};

export function renderTable(report: Report): string {
  const parts: string[] = [];
  parts.push(`\nSEP Compliance Report for ${report.domain} (${report.network})\n`);

  const table = new Table({
    head: ["Status", "Check", "Message"],
    wordWrap: true,
    colWidths: [8, 55, 50],
  });

  for (const r of report.results) {
    table.push([STATUS_ICON[r.status] ?? r.status, `${r.id}\n${r.description}`, r.message]);
  }
  parts.push(table.toString());

  const { pass, fail, warn, total } = summarize(report);
  parts.push(`\n${pass}/${total} passed, ${fail} failed, ${warn} warnings\n`);
  return parts.join("\n");
}

export function printTable(report: Report): void {
  console.log(renderTable(report));
}
