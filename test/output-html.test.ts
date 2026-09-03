import { describe, expect, it, vi } from "vitest";
import { REPORT_SCHEMA_VERSION, type Report } from "../src/core/report.js";
import { printHtml, renderHtml } from "../src/output/html.js";

describe("HTML output renderer", () => {
  const sampleReport: Report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    domain: "anchor.example.com",
    network: "testnet",
    timestamp: "2026-09-01T12:00:00.000Z",
    results: [
      {
        id: "sep1.fetch",
        description: "Fetch stellar.toml",
        status: "pass",
        severity: "error",
        message: "stellar.toml discovered",
      },
      {
        id: "sep10.jwt_algorithm",
        description: 'JWT "alg" header indicates signed token',
        status: "pass",
        severity: "error",
        message: 'JWT algorithm is "EdDSA"',
      },
      {
        id: "sep10.jwt_signature",
        description: "Verify JWT signature via JWKS",
        status: "warn",
        severity: "warning",
        message: "Skipped: no JWKS endpoint declared",
      },
      {
        id: "sep38.prices",
        description: "GET /prices returns indicative prices",
        status: "fail",
        severity: "error",
        message: "Endpoint returned HTTP 500",
      },
    ],
  };

  it("contains domain name, network, timestamp, and all check IDs", () => {
    const html = renderHtml(sampleReport);

    expect(html).toContain("anchor.example.com");
    expect(html).toContain("testnet");
    expect(html).toContain("2026-09-01T12:00:00.000Z");

    for (const r of sampleReport.results) {
      expect(html).toContain(r.id);
    }
    expect(html).toContain("stellar.toml discovered");
    expect(html).toContain("JWT &quot;alg&quot; header indicates signed token");
    expect(html).toContain("JWT algorithm is &quot;EdDSA&quot;");
    expect(html).toContain("Skipped: no JWKS endpoint declared");
    expect(html).toContain("Endpoint returned HTTP 500");
  });

  it("shows the schema version in the metadata header", () => {
    const html = renderHtml(sampleReport);

    expect(html).toContain("<strong>Schema:</strong>");
    expect(html).toContain(`v${REPORT_SCHEMA_VERSION}`);
  });

  it("produces valid HTML with doctype and balanced tags", () => {
    const html = renderHtml(sampleReport);

    expect(html.trim().startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<html lang=\"en\">");
    expect(html).toContain("</html>");

    // Tag balance checks
    const countOpenTags = (str: string, tag: string) =>
      (str.match(new RegExp(`<${tag}[ >]`, "g")) || []).length;
    const countClosingTags = (str: string, tag: string) =>
      (str.match(new RegExp(`</${tag}>`, "g")) || []).length;

    for (const tag of ["table", "tbody", "thead", "tr", "th", "td", "div", "span", "html", "head", "body"]) {
      expect(countOpenTags(html, tag)).toBe(countClosingTags(html, tag));
    }
  });

  it("escapes special characters to prevent HTML injection", () => {
    const reportWithMaliciousData: Report = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      domain: "<script>alert('xss')</script>",
      network: "testnet",
      timestamp: "2026-09-01T12:00:00.000Z",
      results: [
        {
          id: "sep1.xss",
          description: "Check with <img src=x onerror=alert(1)>",
          status: "fail",
          severity: "error",
          message: 'Error with "quotes" & <tags>',
        },
      ],
    };

    const html = renderHtml(reportWithMaliciousData);

    expect(html).not.toContain("<script>alert('xss')</script>");
    expect(html).toContain("&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&amp; &lt;tags&gt;");
  });

  it("printHtml prints rendered HTML to console.log", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    printHtml(sampleReport);

    expect(logSpy).toHaveBeenCalledOnce();
    const loggedOutput = logSpy.mock.calls[0][0];
    expect(loggedOutput).toContain("anchor.example.com");
    expect(loggedOutput).toContain("<!DOCTYPE html>");

    logSpy.mockRestore();
  });
});
