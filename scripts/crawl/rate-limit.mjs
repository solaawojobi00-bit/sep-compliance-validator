import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { latestPath } from "./storage-paths.mjs";
import { enabledEntries, normalizeDomain } from "../registry-lib.mjs";

export const RATE_LIMIT_HOURS = 6;
export const RATE_LIMIT_MS = RATE_LIMIT_HOURS * 60 * 60 * 1000;

/**
 * Reads the latest report timestamp for a domain and network from durable storage.
 * Returns the Date instance or null if no report exists.
 */
export async function getLatestReportTimestamp(dataRoot, domain, network) {
  const filePath = join(dataRoot, latestPath(domain, network));
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = await readFile(filePath, "utf-8");
    const json = JSON.parse(raw.replace(/^﻿/, ""));
    if (json.timestamp && typeof json.timestamp === "string") {
      const parsed = new Date(json.timestamp);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }
  } catch {
    // If the file is unreadable or malformed, treat as no valid previous report
  }
  return null;
}

/**
 * Enforces the 6-hour cooldown against durable state in dataRoot.
 *
 * @param {object} options
 * @param {string} options.dataRoot - Directory containing the data/ store
 * @param {string} options.domain - Normalized domain name
 * @param {string} options.network - Network ('testnet' | 'mainnet')
 * @param {Date} [options.now] - Current time (defaults to new Date())
 * @param {number} [options.rateLimitMs] - Cooldown period in ms (defaults to 6 hours)
 * @returns {Promise<{ allowed: boolean, lastChecked: string | null, nextAllowed: string | null, reason?: string }>}
 */
export async function checkRateLimit({
  dataRoot,
  domain,
  network,
  now = new Date(),
  rateLimitMs = RATE_LIMIT_MS,
}) {
  const normalized = normalizeDomain(domain);
  const lastCheckedDate = await getLatestReportTimestamp(dataRoot, normalized, network);

  if (!lastCheckedDate) {
    return {
      allowed: true,
      lastChecked: null,
      nextAllowed: null,
    };
  }

  const elapsed = now.getTime() - lastCheckedDate.getTime();
  if (elapsed < rateLimitMs && elapsed >= 0) {
    const nextAllowedDate = new Date(lastCheckedDate.getTime() + rateLimitMs);
    const lastChecked = lastCheckedDate.toISOString().replace(/\.\d{3}Z$/, "Z");
    const nextAllowed = nextAllowedDate.toISOString().replace(/\.\d{3}Z$/, "Z");
    return {
      allowed: false,
      lastChecked,
      nextAllowed,
      reason: `Rate limit exceeded: ${normalized} (${network}) was last checked at ${lastChecked}. Next run permitted after ${nextAllowed} (cooldown: ${RATE_LIMIT_HOURS} hours).`,
    };
  }

  return {
    allowed: true,
    lastChecked: lastCheckedDate.toISOString().replace(/\.\d{3}Z$/, "Z"),
    nextAllowed: null,
  };
}

/**
 * Validates that an on-demand domain and network request is present and enabled in the registry.
 *
 * @param {Array<object>} registry - Raw anchors.json array
 * @param {string} domain - Domain to look up
 * @param {string} [network] - Optional network filter
 * @returns {{ valid: boolean, targets: Array<object>, reason?: string }}
 */
export function validateOnDemandTarget(registry, domain, network) {
  if (!domain || typeof domain !== "string" || !domain.trim()) {
    return {
      valid: false,
      targets: [],
      reason: "Domain parameter is required for on-demand re-check.",
    };
  }

  const normalized = normalizeDomain(domain);
  const matchingAll = registry.filter(
    (e) => normalizeDomain(e.domain) === normalized && (!network || e.network === network),
  );

  if (matchingAll.length === 0) {
    const networkClause = network ? ` for network "${network}"` : "";
    return {
      valid: false,
      targets: [],
      reason: `Domain "${normalized}"${networkClause} is not registered in registry/anchors.json. On-demand validation is only permitted for opted-in anchors.`,
    };
  }

  const enabled = enabledEntries(registry).filter(
    (e) => normalizeDomain(e.domain) === normalized && (!network || e.network === network),
  );

  if (enabled.length === 0) {
    const networkClause = network ? ` on network "${network}"` : "";
    return {
      valid: false,
      targets: [],
      reason: `Domain "${normalized}"${networkClause} is disabled ("enabled": false) in registry/anchors.json. Opted-out domains cannot be re-checked.`,
    };
  }

  return {
    valid: true,
    targets: enabled,
  };
}
