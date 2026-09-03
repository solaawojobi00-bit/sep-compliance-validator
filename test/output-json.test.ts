import { describe, expect, it, vi } from "vitest";
import { REPORT_SCHEMA_VERSION, type Report } from "../src/core/report.js";
import { printJson, renderJson } from "../src/output/json.js";

describe("output/json", () => {
  const mockReport: Report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    domain: "anchor.example.com",
    network: "mainnet",
    timestamp: "2026-09-01T15:30:00.000Z",
    results: [
      {
        id: "sep1.stellar_toml_exists",
        description: "Fetch stellar.toml",
        status: "pass",
        severity: "error",
        message: "Found stellar.toml",
      },
    ],
  };

  it("renderJson serializes report to formatted JSON string", () => {
    const jsonStr = renderJson(mockReport);
    expect(typeof jsonStr).toBe("string");
    const parsed = JSON.parse(jsonStr);
    expect(parsed.domain).toBe(mockReport.domain);
    expect(parsed.network).toBe(mockReport.network);
    expect(parsed.timestamp).toBe(mockReport.timestamp);
    expect(parsed.results).toEqual(mockReport.results);
  });

  it("renderJson emits schemaVersion as an integer so stored reports identify their schema", () => {
    const parsed = JSON.parse(renderJson(mockReport));
    expect(parsed.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(typeof parsed.schemaVersion).toBe("number");
    expect(Number.isInteger(parsed.schemaVersion)).toBe(true);
    // A stored report is worthless for migration if the version can be mistaken for
    // absent, so guard the one value that would serialize ambiguously.
    expect(parsed.schemaVersion).toBeGreaterThanOrEqual(1);
  });

  it("printJson prints serialized JSON to console.log", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    printJson(mockReport);
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.domain).toBe("anchor.example.com");
    logSpy.mockRestore();
  });
});
