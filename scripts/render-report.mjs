#!/usr/bin/env node
/**
 * Renders a saved JSON compliance report to stdout in the format the GitHub Action was
 * asked for. Used by the "Display Report in Console" step of action.yml.
 *
 * This lives in a file rather than inline in the workflow on purpose. The previous
 * inline version read `"${RUNNER_TEMP}/sep-compliance-report.json"` from inside a
 * single-quoted `node -e` script, so bash never expanded the variable and the read
 * always failed — and it `require()`d the ESM build of the renderers, which this
 * package's "type": "module" forbids. Neither bug was visible because the step ran
 * under continue-on-error.
 *
 * Env: REPORT_FILE (required), REPORT_FORMAT (table | json | html, default table).
 */
import { readFileSync } from "node:fs";

const reportFile = process.env.REPORT_FILE;
if (!reportFile) {
  console.error("REPORT_FILE is not set");
  process.exit(1);
}

const format = process.env.REPORT_FORMAT || "table";
const report = JSON.parse(readFileSync(reportFile, "utf-8"));

if (format === "json") {
  console.log(JSON.stringify(report, null, 2));
} else if (format === "html") {
  const { renderHtml } = await import("../dist/output/html.js");
  console.log(renderHtml(report));
} else {
  const { renderTable } = await import("../dist/output/table.js");
  console.log(renderTable(report));
}
