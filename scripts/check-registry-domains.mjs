#!/usr/bin/env node
/**
 * For each domain newly added to (or re-enabled in) the registry, confirms
 * https://<domain>/.well-known/stellar.toml is reachable and parses. This is the
 * automated half of the ownership check in docs/dashboard-design.md §3.2: an anchor that
 * cannot serve a parseable stellar.toml has nothing for the dashboard to publish.
 *
 * Deliberately reuses the validator's own parser (dist/checks/sep1.js) rather than a
 * second TOML implementation, so "parses" means the same thing here as it does in a
 * compliance run. Requires `npm run build` first.
 *
 * Usage: node scripts/check-registry-domains.mjs <base-registry.json> <head-registry.json>
 */
import { readFileSync } from "node:fs";
import { changedEntries, normalizeDomain } from "./registry-lib.mjs";
import { parseStellarToml } from "../dist/checks/sep1.js";
// fetchWithTimeout rather than bare fetch: it applies the timeout and, per #78, unwraps
// err.cause so a DNS or TLS failure says what actually went wrong instead of the
// useless "fetch failed" that Node's fetch reports.
import { fetchWithTimeout } from "../dist/core/http.js";

const TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 10_000;

function readRegistry(path, fallbackToEmpty) {
  try {
    // Matches validate-registry.mjs: a BOM from a Windows editor must not read as a
    // corrupt registry.
    return JSON.parse(readFileSync(path, "utf-8").replace(/^﻿/, ""));
  } catch (err) {
    if (fallbackToEmpty) {
      // The base branch may predate the registry existing at all.
      return [];
    }
    console.error(`::error::Cannot read registry at ${path}: ${err.message}`);
    process.exit(1);
  }
}

/** One attempt: returns { ok, status, text } or throws for a transport-level failure. */
async function fetchToml(domain) {
  const url = `https://${domain}/.well-known/stellar.toml`;
  const res = await fetchWithTimeout(url, {}, TIMEOUT_MS);
  return { ok: res.ok, status: res.status, text: res.ok ? await res.text() : "" };
}

/**
 * Fetches once, and retries a single time after a delay on a transport error or 5xx.
 * A 4xx is not retried: it is an answer, not a hiccup.
 */
async function fetchTomlWithRetry(domain) {
  try {
    const first = await fetchToml(domain);
    if (first.ok || (first.status >= 400 && first.status < 500)) {
      return first;
    }
    console.log(`  ${domain}: HTTP ${first.status}, retrying once in ${RETRY_DELAY_MS / 1000}s`);
  } catch (err) {
    console.log(`  ${domain}: ${err.message}, retrying once in ${RETRY_DELAY_MS / 1000}s`);
  }

  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  return await fetchToml(domain);
}

const base = readRegistry(process.argv[2], true);
const head = readRegistry(process.argv[3], false);
const pending = changedEntries(base, head);

if (pending.length === 0) {
  console.log("No newly added or re-enabled domains in this change; nothing to verify.");
  process.exit(0);
}

console.log(`Verifying ${pending.length} domain(s) added or re-enabled by this change:`);

const failures = [];

for (const entry of pending) {
  const domain = normalizeDomain(entry.domain);
  const network = entry.network;

  try {
    const res = await fetchTomlWithRetry(domain);

    if (!res.ok) {
      failures.push(
        `${domain}: https://${domain}/.well-known/stellar.toml returned HTTP ${res.status}`,
      );
      continue;
    }

    // parseStellarToml reports the parse outcome as a sep1.parse CheckResult; anything
    // other than a pass means the body is not a stellar.toml (commonly an HTML error
    // page served with a 200).
    const { results } = parseStellarToml(res.text, network, domain);
    const parse = results.find((r) => r.id === "sep1.parse");

    if (!parse || parse.status !== "pass") {
      failures.push(`${domain}: stellar.toml did not parse - ${parse?.message ?? "no parse result"}`);
      continue;
    }

    console.log(`  ${domain} (${network}): stellar.toml reachable and parseable`);
  } catch (err) {
    failures.push(`${domain}: could not fetch stellar.toml - ${err.message}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`::error::${failure}`);
  }
  console.error(
    "\nA registered anchor must serve a parseable stellar.toml: the dashboard has nothing " +
      "to publish otherwise, and an unreachable domain cannot be shown to be yours. Fix " +
      "the anchor and push again, or ask a maintainer to re-run this job if the failure " +
      "was a transient outage.",
  );
  process.exit(1);
}

console.log(`\nAll ${pending.length} domain(s) verified.`);
