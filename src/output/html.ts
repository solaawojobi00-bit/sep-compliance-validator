import type { Report } from "../core/report.js";
import { summarize } from "../core/report.js";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function renderHtml(report: Report): string {
  const { pass, fail, warn, total } = summarize(report);

  const rows = report.results
    .map((r) => {
      const statusClass = `status-${r.status}`;
      return `        <tr>
          <td><span class="badge ${statusClass}">${escapeHtml(r.status.toUpperCase())}</span></td>
          <td><strong>${escapeHtml(r.id)}</strong><br/><span class="desc">${escapeHtml(r.description)}</span></td>
          <td>${escapeHtml(r.severity)}</td>
          <td>${escapeHtml(r.message)}</td>
        </tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SEP Compliance Report: ${escapeHtml(report.domain)}</title>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --text-muted: #8b949e;
      --pass: #238636;
      --fail: #da3633;
      --warn: #d29922;
    }
    body {
      margin: 0;
      padding: 2rem;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      background-color: var(--bg);
      color: var(--text);
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    header {
      margin-bottom: 2rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 1rem;
    }
    h1 {
      margin: 0 0 0.5rem 0;
      font-size: 1.8rem;
    }
    .meta {
      color: var(--text-muted);
      font-size: 0.95rem;
    }
    .summary-cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 1rem;
      text-align: center;
    }
    .card .value {
      font-size: 2rem;
      font-weight: bold;
      margin-top: 0.25rem;
    }
    .card.pass .value { color: #3fb950; }
    .card.fail .value { color: #f85149; }
    .card.warn .value { color: #e3b341; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
    }
    th, td {
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--border);
      text-align: left;
      vertical-align: top;
      font-size: 0.9rem;
    }
    th {
      background: #21262d;
      color: var(--text-muted);
      font-weight: 600;
    }
    tr:last-child td {
      border-bottom: none;
    }
    .badge {
      display: inline-block;
      padding: 0.2rem 0.6rem;
      border-radius: 12px;
      font-size: 0.75rem;
      font-weight: bold;
      text-transform: uppercase;
    }
    .status-pass { background-color: rgba(35, 134, 54, 0.2); color: #3fb950; border: 1px solid #238636; }
    .status-fail { background-color: rgba(218, 54, 51, 0.2); color: #f85149; border: 1px solid #da3633; }
    .status-warn { background-color: rgba(210, 153, 34, 0.2); color: #e3b341; border: 1px solid #d29922; }
    .desc {
      color: var(--text-muted);
      font-size: 0.82rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>SEP Compliance Report</h1>
      <div class="meta">
        <strong>Domain:</strong> ${escapeHtml(report.domain)} &bull;
        <strong>Network:</strong> ${escapeHtml(report.network)} &bull;
        <strong>Generated:</strong> ${escapeHtml(report.timestamp)}
      </div>
    </header>

    <div class="summary-cards">
      <div class="card">
        <div>Total Checks</div>
        <div class="value">${total}</div>
      </div>
      <div class="card pass">
        <div>Passed</div>
        <div class="value">${pass}</div>
      </div>
      <div class="card fail">
        <div>Failed</div>
        <div class="value">${fail}</div>
      </div>
      <div class="card warn">
        <div>Warnings</div>
        <div class="value">${warn}</div>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th style="width: 100px;">Status</th>
          <th>Check</th>
          <th style="width: 100px;">Severity</th>
          <th>Message</th>
        </tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>
</body>
</html>`;
}

export function printHtml(report: Report): void {
  console.log(renderHtml(report));
}
