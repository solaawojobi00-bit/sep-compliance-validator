import { describe, expect, it, vi } from "vitest";
import { REPORT_SCHEMA_VERSION, type Report } from "../src/core/report.js";
import { printTable, renderTable } from "../src/output/table.js";

describe("output/table", () => {
  const mockReport: Report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    domain: "anchor.test.org",
    network: "testnet",
    timestamp: "2026-09-01T12:00:00.000Z",
    results: [
      {
        id: "sep1.stellar_toml_exists",
        description: "Fetch stellar.toml",
        status: "pass",
        severity: "error",
        message: "Found stellar.toml",
      },
      {
        id: "sep10.challenge",
        description: "Validate challenge transaction",
        status: "fail",
        severity: "error",
        message: "Invalid challenge transaction",
      },
      {
        id: "sep1.signing_key",
        description: "SIGNING_KEY present",
        status: "warn",
        severity: "warning",
        message: "Missing optional field",
      },
    ],
  };

  it("renderTable builds formatted table with icons and summary", () => {
    const tableStr = renderTable(mockReport);

    expect(tableStr).toContain("SEP Compliance Report for anchor.test.org (testnet)");
    expect(tableStr).toContain("PASS");
    expect(tableStr).toContain("FAIL");
    expect(tableStr).toContain("WARN");
    expect(tableStr).toContain("sep1.stellar_toml_exists");
    expect(tableStr).toContain("sep10.challenge");
    expect(tableStr).toContain("sep1.signing_key");
    expect(tableStr).toContain("1/3 passed, 1 failed, 1 warnings");
  });

  it("printTable logs rendered table to console.log", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    printTable(mockReport);
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0];
    expect(output).toContain("anchor.test.org");
    logSpy.mockRestore();
  });
});
