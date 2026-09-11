/**
 * Main application script for the Stellar SEP Compliance Dashboard.
 */
import {
  computeMetrics,
  filterEntries,
  getLast7Runs,
  formatRelativeTime,
  groupResultsBySep,
  getFailingChecks,
  validateReportSchema,
} from "./dashboard-lib.mjs";

// Application State
const state = {
  currentView: "directory", // "directory" | "detail"
  detailDomain: null,
  detailNetwork: "testnet",
  currentReport: null,
  allEntries: [],
  filteredEntries: [],
  search: "",
  network: "all",
  status: "all",
  loading: true,
  error: null,
};

// DOM Elements
const elements = {
  themeToggle: document.getElementById("theme-toggle"),
  directoryView: document.getElementById("directory-view"),
  detailView: document.getElementById("detail-view"),

  // Directory View elements
  searchInput: document.getElementById("search-input"),
  clearSearchBtn: document.getElementById("clear-search-btn"),
  filterPills: document.querySelectorAll(".filter-pill"),
  filterStatusBar: document.getElementById("filter-status-bar"),
  resultsCountText: document.getElementById("results-count-text"),
  resetFiltersBtn: document.getElementById("reset-filters-btn"),
  clearFiltersAction: document.getElementById("clear-filters-action"),
  emptyState: document.getElementById("empty-state"),
  directoryContainer: document.getElementById("directory-container"),
  anchorRows: document.getElementById("anchor-rows"),

  // Metric elements
  metricTotalAnchors: document.getElementById("metric-total-anchors"),
  metricComplianceRate: document.getElementById("metric-compliance-rate"),
  metricPassingCount: document.getElementById("metric-passing-count"),
  metricFailingCount: document.getElementById("metric-failing-count"),
  metricLastUpdated: document.getElementById("metric-last-updated"),
  metricLastUpdatedRelative: document.getElementById("metric-last-updated-relative"),

  // Detail View elements
  detailDomain: document.getElementById("detail-domain"),
  detailNetworkBadge: document.getElementById("detail-network-badge"),
  detailStatusBadge: document.getElementById("detail-status-badge"),
  detailSchemaBadge: document.getElementById("detail-schema-badge"),
  detailPassCount: document.getElementById("detail-pass-count"),
  detailFailCount: document.getElementById("detail-fail-count"),
  detailWarnCount: document.getElementById("detail-warn-count"),
  detailTotalCount: document.getElementById("detail-total-count"),
  detailTimestamp: document.getElementById("detail-timestamp"),
  downloadReportBtn: document.getElementById("download-report-btn"),
  failingChecksSection: document.getElementById("failing-checks-section"),
  failingChecksList: document.getElementById("failing-checks-list"),
  sepGroupsList: document.getElementById("sep-groups-list"),

  // Global State containers
  loadingState: document.getElementById("loading-state"),
  errorState: document.getElementById("error-state"),
  errorTitle: document.getElementById("error-title"),
  errorMessage: document.getElementById("error-message"),
  errorBackBtn: document.getElementById("error-back-btn"),
  retryBtn: document.getElementById("retry-btn"),
};

// Theme Management
function initTheme() {
  const savedTheme = localStorage.getItem("sep-dashboard-theme");
  const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const initialTheme = savedTheme || (systemPrefersDark ? "dark" : "light");
  
  setTheme(initialTheme);

  elements.themeToggle?.addEventListener("click", () => {
    const currentTheme = document.documentElement.getAttribute("data-theme") || "dark";
    const nextTheme = currentTheme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
  });
}

function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("sep-dashboard-theme", theme);
}

// Router
function parseRoute() {
  const hash = window.location.hash || "";
  if (hash.startsWith("#/anchor/")) {
    const raw = hash.replace("#/anchor/", "");
    const parts = raw.split("?");
    const domain = decodeURIComponent(parts[0]);
    let network = "testnet";
    if (parts[1]) {
      const params = new URLSearchParams(parts[1]);
      network = params.get("network") || "testnet";
    }
    return { view: "detail", domain, network };
  }
  return { view: "directory" };
}

function handleRoute() {
  const route = parseRoute();
  if (route.view === "detail" && route.domain) {
    state.currentView = "detail";
    state.detailDomain = route.domain;
    state.detailNetwork = route.network;
    loadAnchorDetail(route.domain, route.network);
  } else {
    state.currentView = "directory";
    state.detailDomain = null;
    showDirectoryView();
  }
}

// Data Fetching for Directory Overview
async function fetchSummaryData() {
  state.loading = true;
  state.error = null;
  renderState();

  const candidates = [
    "./data/summary.json",
    "../data/summary.json",
    "data/summary.json",
  ];

  let data = null;
  let lastError = null;

  for (const url of candidates) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const text = await response.text();
        data = JSON.parse(text.replace(/^\uFEFF/, ""));
        break;
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (data && Array.isArray(data)) {
    state.allEntries = data;
    state.loading = false;
    updateMetrics();
    applyFilters();
  } else {
    state.loading = false;
    state.error = lastError ? lastError.message : "Failed to load summary.json (file missing or malformed)";
    renderState();
  }
}

// Data Fetching for Anchor Detail View
async function loadAnchorDetail(domain, network) {
  state.loading = true;
  state.error = null;
  state.currentReport = null;
  renderState();

  const candidates = [
    `./data/reports/${encodeURIComponent(domain)}/${encodeURIComponent(network)}/latest.json`,
    `../data/reports/${encodeURIComponent(domain)}/${encodeURIComponent(network)}/latest.json`,
    `data/reports/${encodeURIComponent(domain)}/${encodeURIComponent(network)}/latest.json`,
  ];

  let report = null;
  let lastError = null;

  for (const url of candidates) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const text = await response.text();
        report = JSON.parse(text.replace(/^\uFEFF/, ""));
        break;
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (!report) {
    state.loading = false;
    state.error = `No report found for anchor "${domain}" on ${network}. ${lastError ? lastError.message : ""}`;
    renderState();
    return;
  }

  const validation = validateReportSchema(report);
  if (!validation.valid) {
    state.loading = false;
    state.error = `Invalid report structure: ${validation.error}`;
    renderState();
    return;
  }

  state.currentReport = report;
  state.loading = false;
  renderDetailView(report);
  renderState();
}

// Render Anchor Detail View
function renderDetailView(report) {
  const domain = report.domain;
  const network = report.network || state.detailNetwork;
  const results = Array.isArray(report.results) ? report.results : [];

  const passCount = results.filter((r) => r.status === "pass").length;
  const failCount = results.filter((r) => r.status === "fail").length;
  const warnCount = results.filter((r) => r.status === "warn").length;
  const totalCount = results.length;

  let overallStatus = "pass";
  if (failCount > 0) overallStatus = "fail";
  else if (warnCount > 0 || totalCount === 0) overallStatus = "warn";

  // Set Header Info
  if (elements.detailDomain) elements.detailDomain.textContent = domain;
  if (elements.detailNetworkBadge) {
    elements.detailNetworkBadge.className = `badge ${network === "mainnet" ? "badge-network-mainnet" : "badge-network-testnet"}`;
    elements.detailNetworkBadge.textContent = network.toUpperCase();
  }
  if (elements.detailStatusBadge) {
    elements.detailStatusBadge.className = `badge badge-status-${overallStatus}`;
    elements.detailStatusBadge.textContent = overallStatus.toUpperCase();
  }
  if (elements.detailSchemaBadge) {
    elements.detailSchemaBadge.textContent = `Schema v${report.schemaVersion ?? 1}`;
  }

  // Set Stats Counts
  if (elements.detailPassCount) elements.detailPassCount.textContent = passCount.toString();
  if (elements.detailFailCount) elements.detailFailCount.textContent = failCount.toString();
  if (elements.detailWarnCount) elements.detailWarnCount.textContent = warnCount.toString();
  if (elements.detailTotalCount) elements.detailTotalCount.textContent = totalCount.toString();
  if (elements.detailTimestamp) {
    elements.detailTimestamp.textContent = report.timestamp
      ? new Date(report.timestamp).toLocaleString()
      : "Unknown";
  }

  // Render Failing / Warning Checks Banner
  const failingChecks = getFailingChecks(results);
  if (elements.failingChecksSection && elements.failingChecksList) {
    if (failingChecks.length > 0) {
      elements.failingChecksSection.classList.remove("hidden");
      elements.failingChecksList.innerHTML = failingChecks.map((check) => renderCheckCard(check)).join("");
    } else {
      elements.failingChecksSection.classList.add("hidden");
      elements.failingChecksList.innerHTML = "";
    }
  }

  // Render Checks Grouped by SEP
  const sepGroups = groupResultsBySep(results);
  if (elements.sepGroupsList) {
    elements.sepGroupsList.innerHTML = sepGroups.map((group) => {
      const gPass = group.checks.filter((c) => c.status === "pass").length;
      const gFail = group.checks.filter((c) => c.status === "fail").length;
      const gWarn = group.checks.filter((c) => c.status === "warn").length;

      return `
        <div class="sep-group-card">
          <div class="sep-group-header">
            <span class="sep-group-title">${group.title}</span>
            <div class="sep-group-counts">
              <span class="badge badge-status-pass">${gPass} Pass</span>
              ${gFail > 0 ? `<span class="badge badge-status-fail">${gFail} Fail</span>` : ""}
              ${gWarn > 0 ? `<span class="badge badge-status-warn">${gWarn} Warn</span>` : ""}
            </div>
          </div>
          <div class="checks-list">
            ${group.checks.map((check) => renderCheckCard(check)).join("")}
          </div>
        </div>
      `;
    }).join("");
  }
}

// Render individual check item card
function renderCheckCard(check) {
  const status = check.status || "warn";
  const severity = check.severity || "error";
  const statusClass = `check-card-${status}`;
  const messageClass = `check-message-${status}`;

  const statusLabel = status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "WARN";
  const badgeClass = `badge-status-${status}`;

  return `
    <div class="check-card ${statusClass}">
      <div class="check-card-header">
        <div class="check-meta-left">
          <span class="badge ${badgeClass}">${statusLabel}</span>
          <span class="check-id">${check.id}</span>
          <span class="badge badge-subtle">${severity.toUpperCase()}</span>
        </div>
        <span class="check-desc">${check.description || ""}</span>
      </div>
      ${check.message ? `<div class="check-message ${messageClass}">${escapeHtml(check.message)}</div>` : ""}
    </div>
  `;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showDirectoryView() {
  state.currentView = "directory";
  renderState();
  if (state.allEntries.length === 0) {
    fetchSummaryData();
  }
}

// Download raw report JSON
function downloadRawReport() {
  if (!state.currentReport) return;
  const jsonStr = JSON.stringify(state.currentReport, null, 2);
  const blob = new Blob([jsonStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${state.currentReport.domain}-${state.currentReport.network || "report"}-latest.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Metrics Updating for Directory View
function updateMetrics() {
  const metrics = computeMetrics(state.allEntries);

  if (elements.metricTotalAnchors) elements.metricTotalAnchors.textContent = metrics.total.toString();
  if (elements.metricComplianceRate) elements.metricComplianceRate.textContent = `${metrics.complianceRate}%`;
  if (elements.metricPassingCount) elements.metricPassingCount.textContent = `${metrics.passing} of ${metrics.total} passing`;
  if (elements.metricFailingCount) elements.metricFailingCount.textContent = metrics.failing.toString();
  if (elements.metricLastUpdated) {
    elements.metricLastUpdated.textContent = metrics.lastUpdated
      ? new Date(metrics.lastUpdated).toLocaleDateString()
      : "N/A";
  }
  if (elements.metricLastUpdatedRelative) {
    elements.metricLastUpdatedRelative.textContent = formatRelativeTime(metrics.lastUpdated);
  }
}

// Filtering
function applyFilters() {
  state.filteredEntries = filterEntries(state.allEntries, {
    search: state.search,
    network: state.network,
    status: state.status,
  });

  renderState();
  renderDirectory();
}

// Status Rendering Helpers
function renderStatusBadge(status) {
  switch (status) {
    case "pass":
      return `<span class="badge badge-status-pass" aria-label="Status: Passing">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        Passing
      </span>`;
    case "fail":
      return `<span class="badge badge-status-fail" aria-label="Status: Failing">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
        Failing
      </span>`;
    case "warn":
    default:
      return `<span class="badge badge-status-warn" aria-label="Status: Warnings">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true">
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        Warnings
      </span>`;
  }
}

function renderNetworkBadge(network) {
  const isMainnet = network === "mainnet";
  const badgeClass = isMainnet ? "badge-network-mainnet" : "badge-network-testnet";
  const label = isMainnet ? "Mainnet" : "Testnet";
  return `<span class="badge ${badgeClass}">${label}</span>`;
}

function renderSparkline(entry) {
  const last7 = getLast7Runs(entry.history, entry.lastChecked, entry.status);
  
  const dotsHtml = last7.map((run) => {
    const statusClass = `dot-${run.status}`;
    const tooltip = `${run.date}: ${run.status.toUpperCase()}`;
    return `<span class="history-dot ${statusClass}" data-tooltip="${tooltip}" aria-label="${tooltip}"></span>`;
  }).join("");

  return `<div class="sparkline-container" role="group" aria-label="Last 7 runs history">${dotsHtml}</div>`;
}

// Render Directory Table
function renderDirectory() {
  if (!elements.anchorRows) return;
  elements.anchorRows.innerHTML = "";

  for (const entry of state.filteredEntries) {
    const tr = document.createElement("tr");

    const passCount = entry.summary?.pass ?? 0;
    const totalCount = entry.summary?.total ?? 0;
    const ratioClass = entry.status === "pass" ? "ratio-pass" : "ratio-fail";

    const tomlUrl = `https://${entry.domain}/.well-known/stellar.toml`;
    const reportUrl = `#/anchor/${encodeURIComponent(entry.domain)}?network=${encodeURIComponent(entry.network || "testnet")}`;

    tr.innerHTML = `
      <td>
        <div class="domain-cell">
          <a href="${tomlUrl}" target="_blank" rel="noopener noreferrer" class="domain-link" title="Open stellar.toml">
            ${entry.domain}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
          </a>
          ${entry.name ? `<span class="anchor-name">${entry.name}</span>` : ""}
        </div>
      </td>
      <td>${renderNetworkBadge(entry.network)}</td>
      <td>${renderStatusBadge(entry.status)}</td>
      <td><span class="ratio-cell ${ratioClass}">${passCount} / ${totalCount}</span></td>
      <td>${renderSparkline(entry)}</td>
      <td>
        <a href="${reportUrl}" class="btn btn-outline btn-sm">
          View Report
        </a>
      </td>
    `;

    elements.anchorRows.appendChild(tr);
  }
}

// UI State Management
function renderState() {
  elements.loadingState?.classList.add("hidden");
  elements.errorState?.classList.add("hidden");

  if (state.loading) {
    elements.loadingState?.classList.remove("hidden");
    elements.directoryView?.classList.add("hidden");
    elements.detailView?.classList.add("hidden");
    return;
  }

  if (state.error) {
    if (elements.errorMessage) elements.errorMessage.textContent = state.error;
    if (elements.errorTitle) {
      elements.errorTitle.textContent = state.currentView === "detail" ? "Report Not Found" : "Unable to Load Data";
    }
    if (elements.errorBackBtn) {
      elements.errorBackBtn.classList.toggle("hidden", state.currentView !== "detail");
    }
    elements.errorState?.classList.remove("hidden");
    elements.directoryView?.classList.add("hidden");
    elements.detailView?.classList.add("hidden");
    return;
  }

  if (state.currentView === "detail") {
    elements.directoryView?.classList.add("hidden");
    elements.detailView?.classList.remove("hidden");
  } else {
    elements.detailView?.classList.add("hidden");
    elements.directoryView?.classList.remove("hidden");

    if (state.filteredEntries.length === 0) {
      elements.emptyState?.classList.remove("hidden");
      elements.directoryContainer?.classList.add("hidden");
    } else {
      elements.emptyState?.classList.add("hidden");
      elements.directoryContainer?.classList.remove("hidden");
    }

    // Filter status bar
    const hasActiveFilters = state.search || state.network !== "all" || state.status !== "all";
    if (hasActiveFilters) {
      elements.filterStatusBar?.classList.remove("hidden");
      if (elements.resultsCountText) {
        elements.resultsCountText.textContent = `Showing ${state.filteredEntries.length} of ${state.allEntries.length} anchors`;
      }
    } else {
      elements.filterStatusBar?.classList.add("hidden");
    }
  }
}

// Event Listeners
function setupEventListeners() {
  // Hash Routing
  window.addEventListener("hashchange", handleRoute);

  // Search input
  elements.searchInput?.addEventListener("input", (e) => {
    state.search = e.target.value;
    elements.clearSearchBtn?.classList.toggle("hidden", !state.search);
    applyFilters();
  });

  // Clear search button
  elements.clearSearchBtn?.addEventListener("click", () => {
    if (elements.searchInput) elements.searchInput.value = "";
    state.search = "";
    elements.clearSearchBtn?.classList.add("hidden");
    applyFilters();
    elements.searchInput?.focus();
  });

  // Filter pills
  elements.filterPills?.forEach((pill) => {
    pill.addEventListener("click", () => {
      const filterType = pill.getAttribute("data-filter-type");
      const filterValue = pill.getAttribute("data-value");

      if (filterType === "network") {
        state.network = filterValue;
      } else if (filterType === "status") {
        state.status = filterValue;
      }

      const parent = pill.parentElement;
      parent?.querySelectorAll(".filter-pill").forEach((p) => {
        p.classList.remove("active");
        p.setAttribute("aria-checked", "false");
      });
      pill.classList.add("active");
      pill.setAttribute("aria-checked", "true");

      applyFilters();
    });
  });

  // Reset filters
  const resetHandler = () => {
    state.search = "";
    state.network = "all";
    state.status = "all";

    if (elements.searchInput) elements.searchInput.value = "";
    elements.clearSearchBtn?.classList.add("hidden");

    document.querySelectorAll(".filter-pill-group").forEach((group) => {
      group.querySelectorAll(".filter-pill").forEach((pill) => {
        const isAll = pill.getAttribute("data-value") === "all";
        pill.classList.toggle("active", isAll);
        pill.setAttribute("aria-checked", isAll ? "true" : "false");
      });
    });

    applyFilters();
  };

  elements.resetFiltersBtn?.addEventListener("click", resetHandler);
  elements.clearFiltersAction?.addEventListener("click", resetHandler);

  elements.retryBtn?.addEventListener("click", () => {
    if (state.currentView === "detail" && state.detailDomain) {
      loadAnchorDetail(state.detailDomain, state.detailNetwork);
    } else {
      fetchSummaryData();
    }
  });

  // Download Report Action
  elements.downloadReportBtn?.addEventListener("click", downloadRawReport);
}

// Initialization
document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  setupEventListeners();
  handleRoute();
});
