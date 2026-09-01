import { describe, expect, it } from "vitest";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { parseStellarToml } from "../src/checks/sep1.js";
import { guardChecker } from "../src/core/guard.js";

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
});
