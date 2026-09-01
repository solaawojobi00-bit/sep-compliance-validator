#!/usr/bin/env node
import { Command } from "commander";
import { fetchStellarToml, type StellarToml } from "./checks/sep1.js";
import { runSep10Checks } from "./checks/sep10.js";
import { runSep12Checks } from "./checks/sep12.js";
import { runSep24Checks } from "./checks/sep24.js";
import { runSep38Checks } from "./checks/sep38.js";
import { guardChecker } from "./core/guard.js";
import type { CheckResult, Report } from "./core/report.js";
import { summarize } from "./core/report.js";
import { printHtml } from "./output/html.js";
import { printJson } from "./output/json.js";
import { printTable } from "./output/table.js";

const VALID_FORMATS = ["table", "json", "html"] as const;
const VALID_NETWORKS = ["testnet", "mainnet"] as const;

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
  .action(
    async (
      domain: string,
      options: {
        network: string;
        format: string;
        clientDomain?: string;
        timeout: string;
        iUnderstandThisTouchesProduction?: boolean;
        interactiveBrowser?: boolean;
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

      // 4. Validate mainnet production guard
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

      const network = options.network as "testnet" | "mainnet";
      const results: CheckResult[] = [];
      let toml: StellarToml | undefined;

      try {
        const sep1Results = await guardChecker("sep1", "Fetch and validate stellar.toml", async () => {
          const res = await fetchStellarToml(domain, timeoutMs);
          toml = res.toml;
          return res.results;
        });
        results.push(...sep1Results);

        let clientSigningKey: string | undefined;
        if (options.clientDomain) {
          const clientTomlResults = await guardChecker("sep1.client", "Fetch client domain stellar.toml", async () => {
            const res = await fetchStellarToml(options.clientDomain!, timeoutMs);
            clientSigningKey = res.toml.signingKey;
            return res.results;
          });
          results.push(...clientTomlResults);
        }

        if (toml) {
          const sep10Results = await guardChecker("sep10", "Run SEP-10 challenge/response flow", async () => {
            return await runSep10Checks({
              domain,
              toml: toml!,
              network,
              clientDomain: options.clientDomain,
              clientSigningKey,
              timeoutMs,
            });
          });
          results.push(...sep10Results);

          const sep10Succeeded =
            Boolean((sep10Results as any).jwt) &&
            !sep10Results.some((r) => r.status === "fail");

          const kycServer =
            toml.kycServer ??
            toml.transferServer ??
            (typeof toml.raw.KYC_SERVER === "string"
              ? toml.raw.KYC_SERVER
              : typeof toml.raw.TRANSFER_SERVER === "string"
                ? toml.raw.TRANSFER_SERVER
                : undefined);

          if (sep10Succeeded && kycServer) {
            const sep12Results = await guardChecker("sep12", "Validate SEP-12 KYC endpoints", async () => {
              return await runSep12Checks({
                domain,
                toml: toml!,
                network,
                jwt: (sep10Results as any).jwt!,
              });
            });
            results.push(...sep12Results);
          }

          const sep24Server =
            toml.transferServerSep24 ??
            (typeof toml.raw.TRANSFER_SERVER_SEP0024 === "string"
              ? toml.raw.TRANSFER_SERVER_SEP0024
              : undefined);

          if (sep10Succeeded && sep24Server) {
            const sep24Results = await guardChecker("sep24", "Validate SEP-24 interactive deposit/withdraw endpoints", async () => {
              return await runSep24Checks({
                domain,
                toml: toml!,
                network,
                jwt: (sep10Results as any).jwt!,
                timeoutMs,
                interactiveBrowser: options.interactiveBrowser,
              });
            });
            results.push(...sep24Results);
          }

          const quoteServer =
            toml.anchorQuoteServer ??
            (typeof toml.raw.ANCHOR_QUOTE_SERVER === "string"
              ? toml.raw.ANCHOR_QUOTE_SERVER
              : undefined);

          if (quoteServer) {
            const sep38Results = await guardChecker("sep38", "Validate SEP-38 quote endpoints", async () => {
              return await runSep38Checks({ domain, toml: toml!, network });
            });
            results.push(...sep38Results);
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

        if (options.format === "json") {
          printJson(report);
        } else if (options.format === "html") {
          printHtml(report);
        } else {
          printTable(report);
        }

        const { fail } = summarize(report);
        process.exitCode = fail > 0 ? 1 : 0;
      }
    },
  );

program.parse();
