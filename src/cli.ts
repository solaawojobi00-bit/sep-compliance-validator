#!/usr/bin/env node
import { Command } from "commander";
import { fetchStellarToml } from "./checks/sep1.js";
import { runSep10Checks } from "./checks/sep10.js";
import type { CheckResult, Report } from "./core/report.js";
import { summarize } from "./core/report.js";
import { printJson } from "./output/json.js";
import { printTable } from "./output/table.js";

const program = new Command();

program
  .name("sep-compliance-validator")
  .description("Validate a Stellar anchor's SEP-1/SEP-10 implementation against spec")
  .version("0.1.0");

program
  .command("check")
  .description("Run SEP-1 and SEP-10 conformance checks against an anchor's home domain")
  .argument("<domain>", "Anchor home domain, e.g. example.com")
  .option("-n, --network <network>", "testnet or mainnet", "testnet")
  .option("-f, --format <format>", "output format: table or json", "table")
  .action(async (domain: string, options: { network: string; format: string }) => {
    const network = options.network === "mainnet" ? "mainnet" : "testnet";
    const results: CheckResult[] = [];

    const { toml, results: sep1Results } = await fetchStellarToml(domain);
    results.push(...sep1Results);

    const sep10Results = await runSep10Checks({ domain, toml, network });
    results.push(...sep10Results);

    const report: Report = {
      domain,
      network,
      timestamp: new Date().toISOString(),
      results,
    };

    if (options.format === "json") {
      printJson(report);
    } else {
      printTable(report);
    }

    const { fail } = summarize(report);
    process.exitCode = fail > 0 ? 1 : 0;
  });

program.parse();
