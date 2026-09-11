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
