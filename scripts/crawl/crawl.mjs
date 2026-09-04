#!/usr/bin/env node
/**
 * The crawler entry point: iterates every enabled registry entry, runs both legs, merges
 * them, writes the archive, prunes it, and regenerates data/summary.json.
 *
 * Usage: node scripts/crawl/crawl.mjs [--data-root <dir>] [--domain <domain>] [--network <network>]
 *
 * `--domain` narrows the run to one registered anchor, which is what #91's on-demand
 * trigger will use. It cannot introduce an unregistered domain: the entry still has to be
 * present and enabled in the registry.
 *
 * `--data-root` is where `data/` is read and written, defaulting to the repository root.
 * The workflow points it at a checkout of the published data branch, so the archive and
 * its daily commits stay out of main's history while still being read back to regenerate
 * history (section 4.2 requires summary.json be rebuilt from the archive, not accumulated
 * in place).
 *
 * Requires `npm run build` first - it spawns dist/cli.js.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPORT_SCHEMA_VERSION } from "../../dist/core/report.js";
import { enabledEntries, normalizeDomain } from "../registry-lib.mjs";
import { buildInvocations } from "./build-cli-args.mjs";
import { mergeLegs } from "./merge-legs.mjs";
import { runLeg } from "./run-anchor.mjs";
import { anchorDir, latestPath, parseFileStamp, reportPath, SUMMARY_PATH } from "./storage-paths.mjs";
import { classifyDetailFiles } from "./prune-retention.mjs";
import { buildSummary } from "./aggregate-summary.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliPath = join(repoRoot, "dist", "cli.js");
const registryPath = join(repoRoot, "registry", "anchors.json");

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** Where data/ is read and written; the code itself always lives at repoRoot. */
const dataRoot = arg("data-root") ? resolve(process.cwd(), arg("data-root")) : repoRoot;

/** Whole seconds: the merged timestamp is a crawl marker, not a precise measurement. */
function crawlTimestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

const notes = [];
function warn(message) {
  notes.push(message);
  console.log(`::warning::${message}`);
}

async function readJson(path) {
  const text = await readFile(path, "utf-8");
  // Strip a UTF-8 BOM: invisible in an editor, fatal to JSON.parse.
  return JSON.parse(text.replace(/^﻿/, ""));
}

/** Every stored report for one anchor, for regenerating history from the archive. */
async function readArchive(domain, network) {
  const dir = join(dataRoot, anchorDir(domain, network));
  if (!existsSync(dir)) {
    return [];
  }

  const reports = [];
  for (const name of await readdir(dir)) {
    if (!parseFileStamp(name)) {
      continue;
    }
    try {
      const report = await readJson(join(dir, name));
      if (report.schemaVersion !== undefined && report.schemaVersion > REPORT_SCHEMA_VERSION) {
        // Section 4.1: surfaced, never parsed optimistically.
        warn(
          `${domain}/${network}: skipping ${name}, schemaVersion ${report.schemaVersion} is newer than this crawler understands (${REPORT_SCHEMA_VERSION})`,
        );
        continue;
      }
      reports.push(report);
    } catch (err) {
      warn(`${domain}/${network}: skipping unreadable archive file ${name} (${err.message})`);
    }
  }
  return reports;
}

async function pruneArchive(domain, network, now) {
  const dir = join(dataRoot, anchorDir(domain, network));
  if (!existsSync(dir)) {
    return 0;
  }
  const { prune, unrecognised } = classifyDetailFiles(await readdir(dir), now);
  for (const name of unrecognised) {
    warn(`${domain}/${network}: leaving unrecognised archive file in place: ${name}`);
  }
  for (const name of prune) {
    await rm(join(dir, name));
  }
  return prune.length;
}

/** Runs both legs for one entry and writes the merged report. Never throws. */
async function crawlAnchor(entry, tmpDir) {
  const domain = normalizeDomain(entry.domain);
  const network = entry.network;
  const timestamp = crawlTimestamp();
  const legs = [];

  for (const { leg, args, outputPath } of buildInvocations(entry, { outDir: tmpDir })) {
    console.log(`  ${domain} [${leg.id}]: dist/cli.js ${args.join(" ")}`);
    const outcome = await runLeg({
      cliPath,
      args,
      outputPath,
      log: (message) => console.log(`    ${domain} [${leg.id}]: ${message}`),
    });

    if (outcome.reason) {
      warn(
        `${domain}/${network}: the ${leg.id} leg did not run (${outcome.reason}); its SEPs are published as not run`,
      );
    }
    legs.push({ leg, report: outcome.report, reason: outcome.reason });
  }

  const { report, unavailable } = mergeLegs({
    domain,
    network,
    timestamp,
    legs,
    supportedVersion: REPORT_SCHEMA_VERSION,
  });

  if (unavailable.length === legs.length) {
    // Nothing was measured. Still published, so the dashboard shows the gap rather than
    // silently serving a stale latest.json as if it were current.
    warn(`${domain}/${network}: no leg produced a usable report this run`);
  }

  await mkdir(join(dataRoot, anchorDir(domain, network)), { recursive: true });
  const body = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(join(dataRoot, reportPath(domain, network, timestamp)), body);
  await writeFile(join(dataRoot, latestPath(domain, network)), body);

  return { domain, network, usableLegs: legs.length - unavailable.length };
}

async function main() {
  const registry = await readJson(registryPath);
  const onlyDomain = arg("domain") ? normalizeDomain(arg("domain")) : undefined;
  const onlyNetwork = arg("network");

  let targets = enabledEntries(registry);
  if (onlyDomain) {
    targets = targets.filter((e) => normalizeDomain(e.domain) === onlyDomain);
  }
  if (onlyNetwork) {
    targets = targets.filter((e) => e.network === onlyNetwork);
  }

  if (targets.length === 0) {
    console.error("::error::no enabled registry entries matched; nothing to crawl");
    process.exit(1);
  }

  // The system temp dir, never the repo: a leg's raw output is scratch, and writing it
  // into the working tree would show up as untracked files in a contributor's checkout.
  const tmpDir = join(process.env.RUNNER_TEMP ?? tmpdir(), "crawl-legs");
  await mkdir(tmpDir, { recursive: true });

  console.log(`Crawling ${targets.length} anchor(s) into ${dataRoot}:`);

  const crawled = [];
  for (const entry of targets) {
    try {
      crawled.push(await crawlAnchor(entry, tmpDir));
    } catch (err) {
      // Per-anchor containment: one anchor blowing up must not abort the batch.
      warn(`${entry.domain}/${entry.network}: crawl failed entirely (${err.message})`);
      crawled.push({ domain: normalizeDomain(entry.domain), network: entry.network, usableLegs: 0 });
    }
  }

  if (crawled.every((c) => c.usableLegs === 0)) {
    // Every anchor failing every leg is not a bad day for the ecosystem; it means the
    // crawler, the build, or the runner's network is broken. That should page someone,
    // which is the same distinction live-anchor.yml draws.
    console.error("::error::no anchor produced a usable leg - the crawler itself is failing, not the anchors");
    process.exit(1);
  }

  const now = crawlTimestamp();
  let pruned = 0;
  const groups = [];
  for (const { domain, network } of crawled) {
    pruned += await pruneArchive(domain, network, now);
    groups.push({ domain, network, reports: await readArchive(domain, network) });
  }

  const summary = buildSummary(
    groups.filter((g) => g.reports.length > 0),
    { now },
  );
  await mkdir(join(dataRoot, "data"), { recursive: true });
  await writeFile(join(dataRoot, SUMMARY_PATH), `${JSON.stringify(summary, null, 2)}\n`);

  const partial = summary.filter((e) => e.completeness === "partial").length;
  console.log(
    `\nsummary.json rebuilt from the archive: ${summary.length} entr${summary.length === 1 ? "y" : "ies"}, ` +
      `${partial} partial, ${pruned} snapshot(s) pruned past retention, ${notes.length} warning(s)`,
  );

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      "### Dashboard crawl",
      "",
      `Anchors crawled: ${crawled.length} / partial: ${partial} / pruned: ${pruned}`,
      "",
      ...summary.map(
        (e) =>
          `- \`${e.domain}\` (${e.network}): **${e.status}**${e.completeness === "partial" ? " _(partial)_" : ""} - ` +
          `${e.summary.pass}/${e.summary.total} passed, ${e.summary.fail} failed, ` +
          `${e.summary.warn} warned (${e.summary.notVerified} not verified)`,
      ),
      ...(notes.length > 0 ? ["", "#### Warnings", "", ...notes.map((n) => `- ${n}`)] : []),
    ];
    await writeFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`, { flag: "a" });
  }
}

await main();
