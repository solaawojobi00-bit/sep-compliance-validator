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
        exercised: true,
        severity: "warning",
        message: "Missing optional field",
      },
      {
        id: "sep10.jwt_signature",
        description: "Verify JWT signature via JWKS",
        status: "warn",
        exercised: false,
        severity: "warning",
        message: "Skipped: no JWKS endpoint declared",
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
    expect(tableStr).toContain("1/4 passed, 1 failed, 1 warnings, 1 not exercised");
  });

  it("renders a not-exercised warn as SKIP, not WARN", () => {
    const tableStr = renderTable(mockReport);

    // The advisory warn keeps WARN; the not-exercised one must be visibly distinct, or a
    // terminal reader has the same "how many of these are problems?" question a dashboard
    // does.
    const skipRow = tableStr.split("\n").find((line) => line.includes("sep10.jwt_signature"));
    expect(skipRow).toContain("SKIP");
    expect(skipRow).not.toContain("WARN");
  });

  it("omits the not-exercised count when there are none", () => {
    const clean: Report = {
      ...mockReport,
      results: mockReport.results.filter((r) => r.status !== "warn" || r.exercised !== false),
    };

    expect(renderTable(clean)).toContain("1/3 passed, 1 failed, 1 warnings\n");
    expect(renderTable(clean)).not.toContain("not exercised");
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
