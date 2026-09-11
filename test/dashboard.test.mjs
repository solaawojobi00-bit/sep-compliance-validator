import { describe, expect, it } from "vitest";
import {
  computeMetrics,
  filterEntries,
  formatRelativeTime,
  getLast7Runs,
} from "../dashboard/dashboard-lib.mjs";

const sampleEntries = [
  {
    domain: "anchor-a.example.com",
    name: "Anchor A",
    network: "testnet",
    lastChecked: "2026-09-04T12:00:00Z",
    status: "pass",
    summary: { pass: 10, fail: 0, warn: 1, total: 11 },
    history: [
      { timestamp: "2026-08-29T00:00:00Z", status: "pass" },
      { timestamp: "2026-08-30T00:00:00Z", status: "pass" },
      { timestamp: "2026-08-31T00:00:00Z", status: "fail" },
      { timestamp: "2026-09-01T00:00:00Z", status: "pass" },
      { timestamp: "2026-09-02T00:00:00Z", status: "pass" },
      { timestamp: "2026-09-03T00:00:00Z", status: "warn" },
      { timestamp: "2026-09-04T00:00:00Z", status: "pass" },
    ],
  },
  {
    domain: "anchor-b.example.com",
    name: "Anchor B",
    network: "mainnet",
    lastChecked: "2026-09-04T14:00:00Z",
    status: "fail",
    summary: { pass: 8, fail: 2, warn: 0, total: 10 },
    history: [
      { timestamp: "2026-09-03T00:00:00Z", status: "pass" },
      { timestamp: "2026-09-04T00:00:00Z", status: "fail" },
    ],
  },
  {
    domain: "anchor-c.example.com",
    name: "Anchor C",
    network: "testnet",
    lastChecked: "2026-09-03T10:00:00Z",
    status: "warn",
    summary: { pass: 9, fail: 0, warn: 2, total: 11 },
    history: [],
  },
];

describe("computeMetrics", () => {
  it("calculates correct summary counts and compliance rate", () => {
    const metrics = computeMetrics(sampleEntries);
    expect(metrics.total).toBe(3);
    expect(metrics.passing).toBe(1);
    expect(metrics.failing).toBe(1);
    expect(metrics.warnings).toBe(1);
    expect(metrics.complianceRate).toBe(33); // 1 / 3 = 33%
    expect(metrics.lastUpdated).toBe("2026-09-04T14:00:00Z");
  });

  it("handles an empty entries array gracefully", () => {
    const metrics = computeMetrics([]);
    expect(metrics.total).toBe(0);
    expect(metrics.passing).toBe(0);
    expect(metrics.failing).toBe(0);
    expect(metrics.warnings).toBe(0);
    expect(metrics.complianceRate).toBe(0);
    expect(metrics.lastUpdated).toBeNull();
  });
});

describe("filterEntries", () => {
  it("returns all entries when default filters are used", () => {
    expect(filterEntries(sampleEntries)).toHaveLength(3);
  });

  it("filters by domain search case-insensitively", () => {
    const res = filterEntries(sampleEntries, { search: "ANCHOR-B" });
    expect(res).toHaveLength(1);
    expect(res[0].domain).toBe("anchor-b.example.com");
  });

  it("filters by anchor name search", () => {
    const res = filterEntries(sampleEntries, { search: "Anchor C" });
    expect(res).toHaveLength(1);
    expect(res[0].domain).toBe("anchor-c.example.com");
  });

  it("filters by network", () => {
    const testnet = filterEntries(sampleEntries, { network: "testnet" });
    expect(testnet).toHaveLength(2);
    const mainnet = filterEntries(sampleEntries, { network: "mainnet" });
    expect(mainnet).toHaveLength(1);
  });

  it("filters by status", () => {
    const passing = filterEntries(sampleEntries, { status: "pass" });
    expect(passing).toHaveLength(1);
    expect(passing[0].domain).toBe("anchor-a.example.com");

    const failing = filterEntries(sampleEntries, { status: "fail" });
    expect(failing).toHaveLength(1);
    expect(failing[0].domain).toBe("anchor-b.example.com");

    const warnings = filterEntries(sampleEntries, { status: "warn" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].domain).toBe("anchor-c.example.com");
  });

  it("combines search and multiple filters", () => {
    const res = filterEntries(sampleEntries, {
      search: "anchor",
      network: "testnet",
      status: "pass",
    });
    expect(res).toHaveLength(1);
    expect(res[0].domain).toBe("anchor-a.example.com");
  });

  it("returns an empty array when no entries match", () => {
    const res = filterEntries(sampleEntries, { search: "nonexistent" });
    expect(res).toHaveLength(0);
  });
});

describe("getLast7Runs", () => {
  it("extracts the last 7 daily runs ordered chronologically", () => {
    const history = sampleEntries[0].history;
    const runs = getLast7Runs(history, "2026-09-04T12:00:00Z", "pass");
    expect(runs).toHaveLength(7);
    expect(runs[0].date).toBe("2026-08-29");
    expect(runs[6].date).toBe("2026-09-04");
    expect(runs[2].status).toBe("fail");
  });

  it("falls back to current status when history is empty", () => {
    const runs = getLast7Runs([], "2026-09-04T12:00:00Z", "warn");
    expect(runs).toHaveLength(1);
    expect(runs[0].date).toBe("2026-09-04");
    expect(runs[0].status).toBe("warn");
  });
});

describe("formatRelativeTime", () => {
  const baseMs = Date.parse("2026-09-04T12:00:00Z");

  it("formats relative times accurately", () => {
    expect(formatRelativeTime("2026-09-04T11:59:30Z", baseMs)).toBe("Just now");
    expect(formatRelativeTime("2026-09-04T11:45:00Z", baseMs)).toBe("15m ago");
    expect(formatRelativeTime("2026-09-04T09:00:00Z", baseMs)).toBe("3h ago");
    expect(formatRelativeTime("2026-09-03T12:00:00Z", baseMs)).toBe("Yesterday");
    expect(formatRelativeTime("2026-09-01T12:00:00Z", baseMs)).toBe("3d ago");
  });

  it("handles null or invalid inputs", () => {
    expect(formatRelativeTime(null)).toBe("Never");
    expect(formatRelativeTime("invalid-date")).toBe("Invalid date");
  });
});
