import { describe, expect, it } from "vitest";
import {
  isNotExercised,
  REPORT_SCHEMA_VERSION,
  summarize,
  type CheckResult,
  type Report,
} from "../src/core/report.js";

/**
 * #124: `warn` used to mean two unrelated things — "we could not exercise this" and "we
 * exercised it and found something advisory" — and nothing in the schema separated them.
 * These tests pin the field that does.
 */
const advisory = (id: string): CheckResult => ({
  id,
  description: id,
  status: "warn",
  exercised: true,
  severity: "warning",
  message: "advisory finding",
});

const notExercised = (id: string): CheckResult => ({
  id,
  description: id,
  status: "warn",
  exercised: false,
  severity: "warning",
  message: "Skipped: nothing to measure",
});

const passing = (id: string): CheckResult => ({
  id,
  description: id,
  status: "pass",
  severity: "error",
  message: "ok",
});

const failing = (id: string): CheckResult => ({
  id,
  description: id,
  status: "fail",
  severity: "error",
  message: "not conformant",
});

const reportOf = (results: CheckResult[]): Report => ({
  schemaVersion: REPORT_SCHEMA_VERSION,
  domain: "anchor.example.com",
  network: "testnet",
  timestamp: "2026-09-08T00:00:00.000Z",
  results,
});

describe("core/report: not-exercised vs advisory", () => {
  it("emits schemaVersion 2, because absence of the field is meaningful", () => {
    // A consumer reading an archived report cannot tell "absent because advisory" from
    // "absent because the report predates the field" without the version, so this bump is
    // load-bearing rather than cosmetic.
    expect(REPORT_SCHEMA_VERSION).toBe(2);
  });

  it("treats only a warn with exercised:false as not exercised", () => {
    expect(isNotExercised(notExercised("a"))).toBe(true);
    expect(isNotExercised(advisory("a"))).toBe(false);
    expect(isNotExercised(passing("a"))).toBe(false);
    expect(isNotExercised(failing("a"))).toBe(false);
  });

  it("splits warn into advisory and notExercised without changing the warn total", () => {
    const summary = summarize(
      reportOf([
        passing("p"),
        failing("f"),
        advisory("w1"),
        notExercised("s1"),
        notExercised("s2"),
      ]),
    );

    expect(summary.total).toBe(5);
    expect(summary.pass).toBe(1);
    expect(summary.fail).toBe(1);
    // `warn` keeps its v1 meaning: every warn, of both kinds.
    expect(summary.warn).toBe(3);
    expect(summary.advisory).toBe(1);
    expect(summary.notExercised).toBe(2);
    expect(summary.advisory + summary.notExercised).toBe(summary.warn);
  });

  it("reproduces the split the issue observed on a conformant anchor", () => {
    // 8 warnings, 7 of them the validator reporting its own limits and exactly 1 advisory.
    // Rendering that as "8 things to look at" is the bug; the counts must separate them.
    const summary = summarize(
      reportOf([
        notExercised("sep10.jwt_signature"),
        notExercised("sep10.negative.expired"),
        notExercised("sep10.negative.wrong_network"),
        notExercised("sep12.verification_wrong_code"),
        notExercised("sep12.verification_response_schema"),
        notExercised("sep12.verification_unauthenticated"),
        notExercised("sep24.transactions_list_asset_filter"),
        advisory("sep12.fields.unknown_name"),
      ]),
    );

    expect(summary.fail).toBe(0);
    expect(summary.warn).toBe(8);
    expect(summary.notExercised).toBe(7);
    expect(summary.advisory).toBe(1);
  });

  it("counts an empty report as nothing of either kind", () => {
    const summary = summarize(reportOf([]));
    expect(summary).toEqual({
      pass: 0,
      fail: 0,
      warn: 0,
      advisory: 0,
      notExercised: 0,
      total: 0,
    });
  });
});
