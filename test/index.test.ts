import { describe, expect, it } from "vitest";
import * as index from "../src/index.js";

describe("package entrypoint exports (src/index.ts)", () => {
  it("exports all checker functions", () => {
    expect(index.fetchStellarToml).toBeDefined();
    expect(typeof index.fetchStellarToml).toBe("function");

    expect(index.parseStellarToml).toBeDefined();
    expect(typeof index.parseStellarToml).toBe("function");

    expect(index.validateCurrencies).toBeDefined();
    expect(typeof index.validateCurrencies).toBe("function");

    expect(index.validateDocumentation).toBeDefined();
    expect(typeof index.validateDocumentation).toBe("function");

    expect(index.runSep10Checks).toBeDefined();
    expect(typeof index.runSep10Checks).toBe("function");

    expect(index.runSep12Checks).toBeDefined();
    expect(typeof index.runSep12Checks).toBe("function");

    expect(index.runSep24Checks).toBeDefined();
    expect(typeof index.runSep24Checks).toBe("function");

    expect(index.runSep24BrowserChecks).toBeDefined();
    expect(typeof index.runSep24BrowserChecks).toBe("function");

    expect(index.runSep38Checks).toBeDefined();
    expect(typeof index.runSep38Checks).toBe("function");
  });

  it("exports core reporting utilities and error boundaries", () => {
    expect(index.summarize).toBeDefined();
    expect(typeof index.summarize).toBe("function");

    expect(index.guardChecker).toBeDefined();
    expect(typeof index.guardChecker).toBe("function");
  });

  it("exports public constants", () => {
    expect(index.MAX_CHALLENGE_TIMEOUT_SECONDS).toBe(900);

    expect(index.VALID_SEP24_STATUSES).toBeDefined();
    expect(Array.isArray(index.VALID_SEP24_STATUSES)).toBe(true);
    expect(index.VALID_SEP24_STATUSES).toContain("completed");
    expect(index.VALID_SEP24_STATUSES).toContain("incomplete");
  });
});
