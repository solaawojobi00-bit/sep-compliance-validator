import { describe, expect, it } from "vitest";
import { exec } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { promisify } from "node:util";
import { parseStellarToml } from "../src/checks/sep1.js";
import { guardChecker } from "../src/core/guard.js";
import type { Report } from "../src/core/report.js";
import { renderHtml } from "../src/output/html.js";
import { renderJson } from "../src/output/json.js";
import { renderTable } from "../src/output/table.js";

const execAsync = promisify(exec);
const cliPath = "node dist/cli.js";

describe("CLI input validation and error boundaries", () => {
  it("rejects invalid --format with code 2", async () => {
    try {
      await execAsync(`${cliPath} check example.com --format xml`);
      expect.fail("Expected CLI to exit with code 2");
    } catch (err: any) {
      expect(err.code).toBe(2);
      expect(err.stderr).toContain('Invalid format "xml"');
    }
  });

  it("rejects invalid --network with code 2", async () => {
    try {
      await execAsync(`${cliPath} check example.com --network mars`);
      expect.fail("Expected CLI to exit with code 2");
    } catch (err: any) {
      expect(err.code).toBe(2);
      expect(err.stderr).toContain('Invalid network "mars"');
    }
  });

  it("rejects non-numeric --timeout with code 2", async () => {
    try {
      await execAsync(`${cliPath} check example.com --timeout abc`);
      expect.fail("Expected CLI to exit with code 2");
    } catch (err: any) {
      expect(err.code).toBe(2);
      expect(err.stderr).toContain('Invalid timeout "abc"');
    }
  });

  it("rejects non-positive --timeout 0 with code 2", async () => {
    try {
      await execAsync(`${cliPath} check example.com --timeout 0`);
      expect.fail("Expected CLI to exit with code 2");
    } catch (err: any) {
      expect(err.code).toBe(2);
      expect(err.stderr).toContain('Invalid timeout "0"');
    }
  });

  it("rejects mainnet without confirmation flag with code 2", async () => {
    try {
      await execAsync(`${cliPath} check example.com --network mainnet`);
      expect.fail("Expected CLI to exit with code 2");
    } catch (err: any) {
      expect(err.code).toBe(2);
      expect(err.stderr).toContain("Running checks against mainnet touches production");
    }
  });

  it("rejects non-numeric --memo with code 2", async () => {
    try {
      await execAsync(`${cliPath} check example.com --memo notdigits`);
      expect.fail("Expected CLI to exit with code 2");
    } catch (err: any) {
      expect(err.code).toBe(2);
      expect(err.stderr).toContain('Invalid memo "notdigits"');
    }
  });

  it("rejects simultaneous --memo and --muxed with code 2", async () => {
    try {
      await execAsync(`${cliPath} check example.com --memo 12345 --muxed`);
      expect.fail("Expected CLI to exit with code 2");
    } catch (err: any) {
      expect(err.code).toBe(2);
      expect(err.stderr).toContain("Cannot specify both --memo and --muxed");
    }
  });

  it("fails sep1.web_auth_endpoint when WEB_AUTH_ENDPOINT is not a valid absolute URL", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"
WEB_AUTH_ENDPOINT = "example.com/auth"
`;
    const { toml, results } = parseStellarToml(rawToml);
    expect(toml.webAuthEndpoint).toBeUndefined();

    const authCheck = results.find((r) => r.id === "sep1.web_auth_endpoint");
    expect(authCheck?.status).toBe("fail");
    expect(authCheck?.message).toContain("not a valid absolute URL");
  });

  it("guardChecker catches unexpected exceptions and returns a fail CheckResult", async () => {
    const results = await guardChecker("sep10", "Run SEP-10 flow", async () => {
      throw new Error("Simulated unexpected crash");
    });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("sep10.unexpected_error");
    expect(results[0].status).toBe("fail");
    expect(results[0].message).toContain("Simulated unexpected crash");
  });

  it("rejects invalid SEP in --only with code 2", async () => {
    try {
      await execAsync(`${cliPath} check example.com --only sep99`);
      expect.fail("Expected CLI to exit with code 2");
    } catch (err: any) {
      expect(err.code).toBe(2);
      expect(err.stderr).toContain('Invalid SEP in --only: "sep99"');
    }
  });

  it("supports --output <file> writing report and leaving stdout silent", async () => {
    const testFile = "temp-report.json";
    try {
      const { stdout } = await execAsync(
        `${cliPath} check example.com --format json --output ${testFile}`,
      ).catch((err) => err);
      // stdout should be empty
      expect(stdout.trim()).toBe("");
      expect(existsSync(testFile)).toBe(true);
      const content = readFileSync(testFile, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.domain).toBe("example.com");
      expect(Array.isArray(parsed.results)).toBe(true);
    } finally {
      if (existsSync(testFile)) {
        unlinkSync(testFile);
      }
    }
  });

  it("--verbose writes diagnostics to stderr and leaves stdout clean parseable JSON", async () => {
    try {
      const { stdout, stderr } = await execAsync(
        `${cliPath} check example.com --format json --verbose`,
      );
      expect(stderr).toContain("[http]");
      const parsed = JSON.parse(stdout);
      expect(parsed.domain).toBe("example.com");
    } catch (err: any) {
      // If anchor check fails exit 1, stdout is still valid JSON and stderr has diagnostics
      if (err.stdout) {
        expect(err.stderr).toContain("[http]");
        const parsed = JSON.parse(err.stdout);
        expect(parsed.domain).toBe("example.com");
      } else {
        throw err;
      }
    }
  });

  it("--only sep12 without sep10 produces a skip warning", async () => {
    try {
      const { stdout } = await execAsync(
        `${cliPath} check example.com --only sep12 --format json`,
      );
      const parsed = JSON.parse(stdout);
      const sep12Skip = parsed.results.find((r: any) => r.id === "sep12.skipped");
      expect(sep12Skip).toBeDefined();
      expect(sep12Skip.status).toBe("warn");
      expect(sep12Skip.message).toContain("requires SEP-10 for a JWT");
    } catch (err: any) {
      if (err.stdout) {
        const parsed = JSON.parse(err.stdout);
        const sep12Skip = parsed.results.find((r: any) => r.id === "sep12.skipped");
        expect(sep12Skip).toBeDefined();
        expect(sep12Skip.status).toBe("warn");
      } else {
        throw err;
      }
    }
  });
});

describe("Output renderers unit tests", () => {
  const mockReport: Report = {
    domain: "anchor.example.com",
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
        id: "sep1.signing_key",
        description: "SIGNING_KEY is present",
        status: "warn",
        severity: "warning",
        message: "Optional field missing",
      },
    ],
  };

  it("renderJson formats report into JSON string", () => {
    const jsonStr = renderJson(mockReport);
    const parsed = JSON.parse(jsonStr);
    expect(parsed.domain).toBe("anchor.example.com");
    expect(parsed.results).toHaveLength(2);
  });

  it("renderTable formats report into table string with summary", () => {
    const tableStr = renderTable(mockReport);
    expect(tableStr).toContain("anchor.example.com");
    expect(tableStr).toContain("sep1.stellar_toml_exists");
    expect(tableStr).toContain("1/2 passed, 0 failed, 1 warnings");
  });

  it("renderHtml formats report into html document", () => {
    const htmlStr = renderHtml(mockReport);
    expect(htmlStr).toContain("<!DOCTYPE html>");
    expect(htmlStr).toContain("anchor.example.com");
    expect(htmlStr).toContain("sep1.stellar_toml_exists");
  });
});

