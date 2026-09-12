/**
 * Core dashboard logic and data calculation functions.
 * Pure functions without DOM dependencies for easy unit testing.
 */

/**
 * Computes high-level dashboard metrics from summary entries.
 */
export function computeMetrics(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const total = list.length;
  const passing = list.filter((e) => e.status === "pass").length;
  const failing = list.filter((e) => e.status === "fail").length;
  const warnings = list.filter((e) => e.status === "warn").length;

  const complianceRate = total > 0 ? Math.round((passing / total) * 100) : 0;

  // Find most recent lastChecked timestamp
  let lastUpdated = null;
  for (const entry of list) {
    if (entry.lastChecked) {
      if (!lastUpdated || Date.parse(entry.lastChecked) > Date.parse(lastUpdated)) {
        lastUpdated = entry.lastChecked;
      }
    }
  }

  return {
    total,
    passing,
    failing,
    warnings,
    complianceRate,
    lastUpdated,
  };
}

/**
 * Filters summary entries by search query, network, and status.
 */
export function filterEntries(entries, { search = "", network = "all", status = "all" } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const query = search.trim().toLowerCase();

  return list.filter((entry) => {
    // Search filter
    if (query) {
      const domainMatch = entry.domain?.toLowerCase().includes(query);
      const nameMatch = entry.name?.toLowerCase().includes(query);
      if (!domainMatch && !nameMatch) {
        return false;
      }
    }

    // Network filter
    if (network !== "all" && entry.network !== network) {
      return false;
    }

    // Status filter
    if (status !== "all" && entry.status !== status) {
      return false;
    }

    return true;
  });
}

/**
 * Extracts the last 7 daily run statuses for sparkline rendering.
 */
export function getLast7Runs(history, lastChecked, currentStatus) {
  const list = Array.isArray(history) ? [...history] : [];
  
  // Sort ascending by timestamp
  list.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  // If history is empty but we have a current status
  if (list.length === 0 && currentStatus && lastChecked) {
    list.push({ timestamp: lastChecked, status: currentStatus });
  }

  // Take the last 7 runs
  const last7 = list.slice(-7);

  return last7.map((item) => ({
    date: item.timestamp ? item.timestamp.split("T")[0] : "unknown",
    timestamp: item.timestamp,
    status: item.status ?? "none",
    completeness: item.completeness ?? "full",
  }));
}

/**
 * Formats an ISO timestamp into a user-friendly relative string.
 */
export function formatRelativeTime(isoString, nowMs = Date.now()) {
  if (!isoString) return "Never";
  const timestamp = Date.parse(isoString);
  if (Number.isNaN(timestamp)) return "Invalid date";

  const diffSeconds = Math.floor((nowMs - timestamp) / 1000);
  if (diffSeconds < 60) return "Just now";
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * Validates a Report object's structure and schemaVersion.
 */
export function validateReportSchema(report) {
  if (!report || typeof report !== "object") {
    return { valid: false, error: "Report is missing or not a valid JSON object." };
  }

  if (report.schemaVersion !== undefined && typeof report.schemaVersion === "number") {
    // Current supported versions are 1 and 2
    if (report.schemaVersion > 2) {
      return {
        valid: false,
        error: `Report carries unsupported schemaVersion ${report.schemaVersion} (highest supported is 2). Please upgrade validator.`,
      };
    }
  }

  if (!report.domain || typeof report.domain !== "string") {
    return { valid: false, error: "Report is missing 'domain' field." };
  }

  if (!Array.isArray(report.results)) {
    return { valid: false, error: "Report is missing 'results' array." };
  }

  return { valid: true };
}

/**
 * Extracts checks that are failing or producing warnings for top-level surfacing.
 */
export function getFailingChecks(results) {
  const list = Array.isArray(results) ? results : [];
  return list.filter((r) => r.status === "fail" || r.status === "warn");
}

/**
 * Groups check results by SEP specification prefix.
 */
export function groupResultsBySep(results) {
  const list = Array.isArray(results) ? results : [];

  const groups = [
    { key: "sep1", title: "SEP-1: Info Discovery (stellar.toml)", checks: [] },
    { key: "sep10", title: "SEP-10: Stellar Web Authentication", checks: [] },
    { key: "sep12", title: "SEP-12: KYC & Customer Identification", checks: [] },
    { key: "sep24", title: "SEP-24: Interactive Deposit & Withdrawal", checks: [] },
    { key: "sep38", title: "SEP-38: Anchor Quotes & Rates", checks: [] },
    { key: "other", title: "Other Diagnostic Checks", checks: [] },
  ];

  const groupMap = new Map(groups.map((g) => [g.key, g]));

  for (const check of list) {
    const id = check.id || "";
    if (id.startsWith("sep1.")) {
      groupMap.get("sep1").checks.push(check);
    } else if (id.startsWith("sep10.")) {
      groupMap.get("sep10").checks.push(check);
    } else if (id.startsWith("sep12.")) {
      groupMap.get("sep12").checks.push(check);
    } else if (id.startsWith("sep24.")) {
      groupMap.get("sep24").checks.push(check);
    } else if (id.startsWith("sep38.")) {
      groupMap.get("sep38").checks.push(check);
    } else {
      groupMap.get("other").checks.push(check);
    }
  }

  // Return non-empty groups
  return groups.filter((g) => g.checks.length > 0);
}

