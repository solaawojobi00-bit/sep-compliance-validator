#!/usr/bin/env node
import { Command } from "commander";
import { fetchStellarToml } from "./checks/sep1.js";
import { runSep10Checks } from "./checks/sep10.js";
import { runSep12Checks } from "./checks/sep12.js";
import { runSep24Checks } from "./checks/sep24.js";
import { runSep38Checks } from "./checks/sep38.js";
import type { CheckResult, Report } from "./core/report.js";
import { summarize } from "./core/report.js";
import { printHtml } from "./output/html.js";
import { printJson } from "./output/json.js";
import { printTable } from "./output/table.js";

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
  .action(
    async (
      domain: string,
      options: {
        network: string;
        format: string;
        clientDomain?: string;
        timeout: string;
        iUnderstandThisTouchesProduction?: boolean;
      },
    ) => {
      if (
        options.network === "mainnet" &&
        !options.iUnderstandThisTouchesProduction
      ) {
        console.error(
          "Error: Running checks against mainnet touches production anchor infrastructure. " +
            "To confirm, re-run with the flag: --i-understand-this-touches-production",
        );
        process.exitCode = 1;
        return;
      }

      const network = options.network === "mainnet" ? "mainnet" : "testnet";
      const timeoutMs = parseInt(options.timeout, 10) || 10000;
      const results: CheckResult[] = [];

      const { toml, results: sep1Results } = await fetchStellarToml(
        domain,
        timeoutMs,
      );
      results.push(...sep1Results);

      let clientSigningKey: string | undefined;
      if (options.clientDomain) {
        const { toml: clientToml, results: clientTomlResults } =
          await fetchStellarToml(options.clientDomain, timeoutMs);
        results.push(...clientTomlResults);
        clientSigningKey = clientToml.signingKey;
      }

      const sep10Results = await runSep10Checks({
        domain,
        toml,
        network,
        clientDomain: options.clientDomain,
        clientSigningKey,
        timeoutMs,
      });
      results.push(...sep10Results);

    const sep10Succeeded =
      Boolean(sep10Results.jwt) && !sep10Results.some((r) => r.status === "fail");
    const kycServer =
      toml.kycServer ??
      toml.transferServer ??
      (typeof toml.raw.KYC_SERVER === "string"
        ? toml.raw.KYC_SERVER
        : typeof toml.raw.TRANSFER_SERVER === "string"
          ? toml.raw.TRANSFER_SERVER
          : undefined);

    if (sep10Succeeded && kycServer) {
      const sep12Results = await runSep12Checks({
        domain,
        toml,
        network,
        jwt: sep10Results.jwt!,
      });
      results.push(...sep12Results);
    }

    const sep24Server =
      toml.transferServerSep24 ??
      (typeof toml.raw.TRANSFER_SERVER_SEP0024 === "string"
        ? toml.raw.TRANSFER_SERVER_SEP0024
        : undefined);

    if (sep10Succeeded && sep24Server) {
      const sep24Results = await runSep24Checks({
        domain,
        toml,
        network,
        jwt: sep10Results.jwt!,
      });
      results.push(...sep24Results);
    }

    const quoteServer =
      toml.anchorQuoteServer ??
      (typeof toml.raw.ANCHOR_QUOTE_SERVER === "string"
        ? toml.raw.ANCHOR_QUOTE_SERVER
        : undefined);

    if (quoteServer) {
      const sep38Results = await runSep38Checks({ domain, toml, network });
      results.push(...sep38Results);
    }

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
  });

program.parse();
