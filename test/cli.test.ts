import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exec } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { promisify } from "node:util";
import { buildProgram, runCheckAction, type CheckCommandOptions } from "../src/cli.js";
import { parseStellarToml } from "../src/checks/sep1.js";
import { guardChecker } from "../src/core/guard.js";
import { REPORT_SCHEMA_VERSION } from "../src/core/report.js";

const execAsync = promisify(exec);
const cliPath = "node dist/cli.js";

describe("runCheckAction in-process branch coverage", () => {
  const originalExitCode = process.exitCode;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.exitCode = 0;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const baseOpts: CheckCommandOptions = {
    network: "testnet",
    format: "json",
    timeout: "10000",
  };

  it("stamps every report it builds with the current schemaVersion", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("network disabled for this test");
    }) as unknown as typeof fetch;

    const report = await runCheckAction("example.com", baseOpts);

    // Stamped even on a run where every check failed — a stored report is only useful
    // for migration if the version is unconditional.
    expect(report?.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(Number.isInteger(report?.schemaVersion)).toBe(true);
  });

  it("returns undefined and sets exitCode 2 for invalid format", async () => {
    const report = await runCheckAction("example.com", { ...baseOpts, format: "xml" });
    expect(report).toBeUndefined();
    expect(process.exitCode).toBe(2);
  });

  it("returns undefined and sets exitCode 2 for invalid network", async () => {
    const report = await runCheckAction("example.com", { ...baseOpts, network: "devnet" });
    expect(report).toBeUndefined();
    expect(process.exitCode).toBe(2);
  });

  it("returns undefined and sets exitCode 2 for non-numeric timeout", async () => {
    const report = await runCheckAction("example.com", { ...baseOpts, timeout: "not-a-number" });
    expect(report).toBeUndefined();
    expect(process.exitCode).toBe(2);
  });

  it("returns undefined and sets exitCode 2 for non-positive timeout", async () => {
    const report = await runCheckAction("example.com", { ...baseOpts, timeout: "0" });
    expect(report).toBeUndefined();
    expect(process.exitCode).toBe(2);
  });

  it("returns undefined and sets exitCode 2 for empty --only", async () => {
    const report = await runCheckAction("example.com", { ...baseOpts, only: "  " });
    expect(report).toBeUndefined();
    expect(process.exitCode).toBe(2);
  });

  it("returns undefined and sets exitCode 2 for invalid SEP in --only", async () => {
    const report = await runCheckAction("example.com", { ...baseOpts, only: "sep999" });
    expect(report).toBeUndefined();
    expect(process.exitCode).toBe(2);
  });

  it("returns undefined and sets exitCode 2 for non-numeric memo", async () => {
    const report = await runCheckAction("example.com", { ...baseOpts, memo: "notdigits" });
    expect(report).toBeUndefined();
    expect(process.exitCode).toBe(2);
  });

  it("returns undefined and sets exitCode 2 for simultaneous memo and muxed", async () => {
    const report = await runCheckAction("example.com", { ...baseOpts, memo: "12345", muxed: true });
    expect(report).toBeUndefined();
    expect(process.exitCode).toBe(2);
  });

  it("returns undefined and sets exitCode 2 for mainnet without confirmation", async () => {
    const report = await runCheckAction("example.com", { ...baseOpts, network: "mainnet" });
    expect(report).toBeUndefined();
    expect(process.exitCode).toBe(2);
  });

  it("executes successfully against mainnet when confirmed", async () => {
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes(".well-known/stellar.toml")) {
        return new Response('VERSION="2.0.0"\nSIGNING_KEY="GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"\n', { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });

    const report = await runCheckAction("example.com", {
      ...baseOpts,
      network: "mainnet",
      iUnderstandThisTouchesProduction: true,
      only: "sep1",
    });

    expect(report).toBeDefined();
    expect(report?.network).toBe("mainnet");
  });

  it("exercises --client-domain toml fetch path", async () => {
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes("anchor.com/.well-known/stellar.toml")) {
        return new Response('VERSION="2.0.0"\nSIGNING_KEY="GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"\n', { status: 200 });
      }
      if (url.includes("wallet.com/.well-known/stellar.toml")) {
        return new Response('VERSION="2.0.0"\nSIGNING_KEY="GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"\n', { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });

    const report = await runCheckAction("anchor.com", {
      ...baseOpts,
      clientDomain: "wallet.com",
      only: "sep1,sep10",
    });

    expect(report).toBeDefined();
    const clientTomlCheck = report?.results.find((r) => r.message.includes("wallet.com"));
    expect(clientTomlCheck).toBeDefined();
  });

  it("exercises table and html format renderers and --output file writing", async () => {
    global.fetch = vi.fn(async () => {
      return new Response('VERSION="2.0.0"\n', { status: 200 });
    });

    const tempTable = "test-temp-table.txt";
    const tempHtml = "test-temp-report.html";

    try {
      await runCheckAction("example.com", {
        ...baseOpts,
        format: "table",
        output: tempTable,
        only: "sep1",
      });
      expect(existsSync(tempTable)).toBe(true);
      expect(readFileSync(tempTable, "utf-8")).toContain("SEP Compliance Report");

      await runCheckAction("example.com", {
        ...baseOpts,
        format: "html",
        output: tempHtml,
        only: "sep1",
      });
      expect(existsSync(tempHtml)).toBe(true);
      expect(readFileSync(tempHtml, "utf-8")).toContain("<!DOCTYPE html>");
    } finally {
      if (existsSync(tempTable)) unlinkSync(tempTable);
      if (existsSync(tempHtml)) unlinkSync(tempHtml);
    }
  });

  it("handles server discovery fallbacks for KYC, SEP-24, and SEP-38", async () => {
    const mockToml = `
VERSION = "2.0.0"
TRANSFER_SERVER = "https://transfer.example.com"
TRANSFER_SERVER_SEP0024 = "https://sep24.example.com"
ANCHOR_QUOTE_SERVER = "https://sep38.example.com"
`;
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes(".well-known/stellar.toml")) {
        return new Response(mockToml, { status: 200 });
      }
      if (url.includes("/info")) {
        return new Response(JSON.stringify({ assets: [] }), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const report = await runCheckAction("example.com", {
      ...baseOpts,
      only: "sep38",
    });

    expect(report).toBeDefined();
    expect(report?.results.some((r) => r.id.startsWith("sep38"))).toBe(true);
  });

  it("sets exitCode 1 when --fail-on-warn is active and warnings exist", async () => {
    global.fetch = vi.fn(async () => {
      // Incomplete TOML produces warnings
      return new Response('VERSION="2.0.0"\n', { status: 200 });
    });

    await runCheckAction("example.com", {
      ...baseOpts,
      failOnWarn: true,
      only: "sep1",
    });

    expect(process.exitCode).toBe(1);
  });

  it("passes --no-write flag to SEP-12 runner", async () => {
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes(".well-known/stellar.toml")) {
        return new Response('VERSION="2.0.0"\nKYC_SERVER="https://kyc.example.com"\n', { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });

    const report = await runCheckAction("example.com", {
      ...baseOpts,
      only: "sep12",
      noWrite: true,
    });

    expect(report).toBeDefined();
    const skipCheck = report?.results.find((r) => r.id === "sep12.skipped");
    expect(skipCheck).toBeDefined();
  });

  it("passes --no-write flag to SEP-38 runner, skipping mutating quote checks", async () => {
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes(".well-known/stellar.toml")) {
        return new Response('VERSION="2.0.0"\nANCHOR_QUOTE_SERVER="https://quote.example.com"\n', {
          status: 200,
        });
      }
      if (url === "https://quote.example.com/info") {
        return new Response(
          JSON.stringify({
            assets: [
              { asset: "iso4217:USD" },
              { asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    const report = await runCheckAction("example.com", {
      ...baseOpts,
      only: "sep38",
      noWrite: true,
    });

    expect(report).toBeDefined();
    const quoteUnauthCheck = report?.results.find((r) => r.id === "sep38.quote_unauthenticated");
    expect(quoteUnauthCheck?.status).toBe("warn");
    expect(quoteUnauthCheck?.message).toContain("--no-write");
  });

  it("catches uncaught crash and reports unexpected_error check", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("Catastrophic network socket error");
    });

    const report = await runCheckAction("example.com", baseOpts);
    expect(report).toBeDefined();
    expect(process.exitCode).toBe(1);
  });

  it("buildProgram creates CLI and parses options", async () => {
    global.fetch = vi.fn(async () => {
      return new Response('VERSION="2.0.0"\n', { status: 200 });
    });

    const program = buildProgram();
    expect(program.name()).toBe("sep-compliance-validator");

    await program.parseAsync(["node", "cli.js", "check", "example.com", "--only", "sep1"]);
    expect(global.fetch).toHaveBeenCalled();
  });
});

describe("CLI subprocess integration and input validation", () => {
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

  it("rejects invalid SEP in --only with code 2", async () => {
    try {
      await execAsync(`${cliPath} check example.com --only sep99`);
      expect.fail("Expected CLI to exit with code 2");
    } catch (err: any) {
      expect(err.code).toBe(2);
      expect(err.stderr).toContain('Invalid SEP in --only: "sep99"');
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

  it("guardChecker falls back to String(err) when the thrown value has no message property", async () => {
    const results = await guardChecker("sep10", "Run SEP-10 flow", async () => {
      throw "raw string failure";
    });

    expect(results).toHaveLength(1);
    expect(results[0].message).toContain("raw string failure");
  });
});
