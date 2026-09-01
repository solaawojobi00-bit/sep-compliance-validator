#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { Command } from "commander";
import { fetchStellarToml, type StellarToml } from "./checks/sep1.js";
import { runSep10Checks, runSep10NegativeChecks } from "./checks/sep10.js";
import { runSep12Checks } from "./checks/sep12.js";
import { runSep24Checks } from "./checks/sep24.js";
import { runSep38Checks } from "./checks/sep38.js";
import { guardChecker } from "./core/guard.js";
import { setVerbose } from "./core/http.js";
import type { CheckResult, Report } from "./core/report.js";
import { summarize } from "./core/report.js";
import { renderHtml } from "./output/html.js";
import { renderJson } from "./output/json.js";
import { renderTable } from "./output/table.js";

const VALID_FORMATS = ["table", "json", "html"] as const;
const VALID_NETWORKS = ["testnet", "mainnet"] as const;
const VALID_SEPS = ["sep1", "sep10", "sep12", "sep24", "sep38"] as const;

const program = new Command();

program
  .name("sep-compliance-validator")
  .description("Validate a Stellar anchor's SEP-1/SEP-10/SEP-12/SEP-24/SEP-38 implementation against spec")
  .version("0.1.0");

program
  .command("check")
  .description("Run SEP-1, SEP-10, SEP-12, SEP-24, and SEP-38 conformance checks against an anchor's home domain")
  .argument("<domain>", "Anchor home domain, e.g. example.com")
  .option("-n, --network <network>", "testnet or mainnet", "testnet")
  .option("-f, --format <format>", "output format: table, json, or html", "table")
  .option("-o, --output <file>", "Write report output to file instead of stdout")
  .option("--only <seps>", "Comma-separated list of SEPs to validate (sep1, sep10, sep12, sep24, sep38)")
  .option("--fail-on-warn", "Exit with non-zero code if any check produces a warning")
  .option("-v, --verbose", "Print detailed HTTP request and response diagnostics to stderr")
  .option("--client-domain <domain>", "Client domain for SEP-10 client_domain verification")
  .option("-t, --timeout <ms>", "Request timeout in milliseconds", "10000")
  .option(
    "--i-understand-this-touches-production",
    "Explicit confirmation required when running checks against mainnet",
  )
  .option(
    "--interactive-browser",
    "Run headless browser automation against SEP-24 interactive URL",
  )
  .option("--memo <id>", "Numeric ID memo for SEP-10 challenge authentication")
  .option("--muxed", "Authenticate using a muxed (M...) account for SEP-10")
  .action(
    async (
      domain: string,
      options: {
        network: string;
        format: string;
        output?: string;
        only?: string;
        failOnWarn?: boolean;
        verbose?: boolean;
        clientDomain?: string;
        timeout: string;
        iUnderstandThisTouchesProduction?: boolean;
        interactiveBrowser?: boolean;
        memo?: string;
        muxed?: boolean;
      },
    ) => {
      // 1. Validate --format
      if (!VALID_FORMATS.includes(options.format as (typeof VALID_FORMATS)[number])) {
        console.error(
          `Error: Invalid format "${options.format}". Supported formats: ${VALID_FORMATS.join(", ")}`,
        );
        process.exitCode = 2;
        return;
      }

      // 2. Validate --network
      if (!VALID_NETWORKS.includes(options.network as (typeof VALID_NETWORKS)[number])) {
        console.error(
          `Error: Invalid network "${options.network}". Supported networks: ${VALID_NETWORKS.join(", ")}`,
        );
        process.exitCode = 2;
        return;
      }

      // 3. Validate --timeout
      const timeoutMs = Number(options.timeout);
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        console.error(
          `Error: Invalid timeout "${options.timeout}". Timeout must be a positive integer.`,
        );
        process.exitCode = 2;
        return;
      }

      // 4. Validate --only if present
      let onlySet: Set<string> | undefined;
      if (options.only) {
        const rawTokens = options.only
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        if (rawTokens.length === 0) {
          console.error("Error: Empty --only list specified.");
          process.exitCode = 2;
          return;
        }
        onlySet = new Set<string>();
        for (const token of rawTokens) {
          const normalized = token.startsWith("sep") ? token : `sep${token}`;
          if (!VALID_SEPS.includes(normalized as (typeof VALID_SEPS)[number])) {
            console.error(
              `Error: Invalid SEP in --only: "${token}". Supported SEPs: ${VALID_SEPS.join(", ")}`,
            );
            process.exitCode = 2;
            return;
          }
          onlySet.add(normalized);
        }
      }

      // 5. Validate memo
      if (options.memo && !/^\d+$/.test(options.memo)) {
        console.error(
          `Error: Invalid memo "${options.memo}". Memo must be a positive integer string.`,
        );
        process.exitCode = 2;
        return;
      }

      if (options.memo && options.muxed) {
        console.error(
          "Error: Cannot specify both --memo and --muxed. SEP-10 forbids memo with muxed accounts.",
        );
        process.exitCode = 2;
        return;
      }

      // 6. Validate mainnet production guard
      if (
        options.network === "mainnet" &&
        !options.iUnderstandThisTouchesProduction
      ) {
        console.error(
          "Error: Running checks against mainnet touches production anchor infrastructure. " +
            "To confirm, re-run with the flag: --i-understand-this-touches-production",
        );
        process.exitCode = 2;
        return;
      }

      if (options.verbose) {
        setVerbose(true);
      }

      const network = options.network as "testnet" | "mainnet";
      const results: CheckResult[] = [];
      let toml: StellarToml | undefined;

      try {
        const sep1Results = await guardChecker("sep1", "Fetch and validate stellar.toml", async () => {
          const res = await fetchStellarToml(domain, timeoutMs, network);
          toml = res.toml;
          return res.results;
        });
        if (!onlySet || onlySet.has("sep1") || !toml) {
          results.push(...sep1Results);
        }

        let clientSigningKey: string | undefined;
        if (options.clientDomain && (!onlySet || onlySet.has("sep10"))) {
          const clientTomlResults = await guardChecker("sep1.client", "Fetch client domain stellar.toml", async () => {
            const res = await fetchStellarToml(options.clientDomain!, timeoutMs, network);
            clientSigningKey = res.toml.signingKey;
            return res.results;
          });
          if (!onlySet || onlySet.has("sep1")) {
            results.push(...clientTomlResults);
          }
        }

        let jwt: string | undefined;

        if (toml) {
          if (!onlySet || onlySet.has("sep10")) {
            const sep10Results = await guardChecker("sep10", "Run SEP-10 challenge/response flow", async () => {
              return await runSep10Checks({
                domain,
                toml: toml!,
                network,
                clientDomain: options.clientDomain,
                clientSigningKey,
                timeoutMs,
                memo: options.memo,
                useMuxedAccount: options.muxed,
              });
            });
            results.push(...sep10Results);

            const sep10Succeeded =
              Boolean((sep10Results as any).jwt) &&
              !sep10Results.some((r) => r.status === "fail");

            if (sep10Succeeded) {
              jwt = (sep10Results as any).jwt;
              const sep10NegResults = await guardChecker(
                "sep10.negative",
                "Run SEP-10 negative-case challenge validation",
                async () => {
                  return await runSep10NegativeChecks({
                    webAuthEndpoint: toml!.webAuthEndpoint!,
                    domain,
                    network,
                    serverSigningKey: toml!.signingKey!,
                    challengeXdr: (sep10Results as any).challengeXdr,
                    clientKeypair: (sep10Results as any).clientKeypair,
                    timeoutMs,
                  });
                },
              );
              results.push(...sep10NegResults);
            }
          }

          if (!onlySet || onlySet.has("sep12")) {
            if (!jwt) {
              results.push({
                id: "sep12.skipped",
                description: "Validate SEP-12 KYC endpoints",
                status: "warn",
                severity: "error",
                message: "Skipped: SEP-12 requires SEP-10 for a JWT",
              });
            } else {
              const kycServer =
                toml.kycServer ??
                toml.transferServer ??
                (typeof toml.raw.KYC_SERVER === "string"
                  ? toml.raw.KYC_SERVER
                  : typeof toml.raw.TRANSFER_SERVER === "string"
                    ? toml.raw.TRANSFER_SERVER
                    : undefined);

              if (kycServer) {
                const sep12Results = await guardChecker("sep12", "Validate SEP-12 KYC endpoints", async () => {
                  return await runSep12Checks({
                    domain,
                    toml: toml!,
                    network,
                    jwt: jwt!,
                    timeoutMs,
                  });
                });
                results.push(...sep12Results);
              }
            }
          }

          if (!onlySet || onlySet.has("sep24")) {
            if (!jwt) {
              results.push({
                id: "sep24.skipped",
                description: "Validate SEP-24 interactive deposit/withdraw endpoints",
                status: "warn",
                severity: "error",
                message: "Skipped: SEP-24 requires SEP-10 for a JWT",
              });
            } else {
              const sep24Server =
                toml.transferServerSep24 ??
                (typeof toml.raw.TRANSFER_SERVER_SEP0024 === "string"
                  ? toml.raw.TRANSFER_SERVER_SEP0024
                  : undefined);

              if (sep24Server) {
                const sep24Results = await guardChecker("sep24", "Validate SEP-24 interactive deposit/withdraw endpoints", async () => {
                  return await runSep24Checks({
                    domain,
                    toml: toml!,
                    network,
                    jwt: jwt!,
                    timeoutMs,
                    interactiveBrowser: options.interactiveBrowser,
                  });
                });
                results.push(...sep24Results);
              }
            }
          }

          if (!onlySet || onlySet.has("sep38")) {
            const quoteServer =
              toml.anchorQuoteServer ??
              (typeof toml.raw.ANCHOR_QUOTE_SERVER === "string"
                ? toml.raw.ANCHOR_QUOTE_SERVER
                : undefined);

            if (quoteServer) {
              const sep38Results = await guardChecker("sep38", "Validate SEP-38 quote endpoints", async () => {
                return await runSep38Checks({
                  domain,
                  toml: toml!,
                  network,
                  timeoutMs,
                });
              });
              results.push(...sep38Results);
            }
          }
        }
      } catch (err) {
        results.push({
          id: "cli.unexpected_error",
          description: "Execution run without uncaught crash",
          status: "fail",
          severity: "error",
          message: `Unexpected error: ${(err as Error).message || String(err)}`,
        });
      } finally {
        const report: Report = {
          domain,
          network,
          timestamp: new Date().toISOString(),
          results,
        };

        let rendered: string;
        if (options.format === "json") {
          rendered = renderJson(report);
        } else if (options.format === "html") {
          rendered = renderHtml(report);
        } else {
          rendered = renderTable(report);
        }

        if (options.output) {
          writeFileSync(options.output, rendered, "utf-8");
        } else {
          console.log(rendered);
        }

        const { fail, warn } = summarize(report);
        if (fail > 0) {
          process.exitCode = 1;
        } else if (options.failOnWarn && warn > 0) {
          process.exitCode = 1;
        } else {
          process.exitCode = 0;
        }
      }
    },
  );

program.parse();
