import { describe, expect, it } from "vitest";
import {
  LEGS,
  buildInvocations,
  buildLegArgs,
  entryIsMainnet,
  legById,
  legTargetsSep12,
} from "../scripts/crawl/build-cli-args.mjs";
import {
  mergeLegs,
  ownedPrefixes,
  ownsResult,
  unavailableMarkers,
  validateLegSchema,
} from "../scripts/crawl/merge-legs.mjs";
import {
  buildEntry,
  buildSummary,
  completenessOf,
  countResults,
  rollUpStatus,
} from "../scripts/crawl/aggregate-summary.mjs";
import { classifyDetailFiles, DETAIL_RETENTION_DAYS } from "../scripts/crawl/prune-retention.mjs";
import { isCrawlUnavailable, isNotVerified } from "../scripts/crawl/inconclusive-ids.mjs";
import { fileStamp, latestPath, parseFileStamp, reportPath } from "../scripts/crawl/storage-paths.mjs";
import { looksTransient } from "../scripts/crawl/run-anchor.mjs";

const core = legById("core");
const kyc = legById("kyc");

const testnetEntry = { domain: "anchor.example.com", network: "testnet", enabled: true };
const mainnetEntry = { ...testnetEntry, network: "mainnet" };

const check = (id, status = "pass", message = "ok") => ({
  id,
  description: id,
  status,
  severity: status === "fail" ? "error" : status === "warn" ? "warning" : "error",
  message,
});

describe("build-cli-args: the two flag conditions", () => {
  // The four combinations of (network, targets SEP-12). Each flag must be decided by its
  // own input only, so that deleting one conditional cannot silently change the other.
  it("testnet + non-SEP-12 leg: neither flag", () => {
    const args = buildLegArgs(testnetEntry, core);
    expect(args).not.toContain("--no-write");
    expect(args).not.toContain("--i-understand-this-touches-production");
  });

  it("testnet + SEP-12 leg: --no-write only", () => {
    const args = buildLegArgs(testnetEntry, kyc);
    expect(args).toContain("--no-write");
    expect(args).not.toContain("--i-understand-this-touches-production");
  });

  it("mainnet + non-SEP-12 leg: production flag only", () => {
    const args = buildLegArgs(mainnetEntry, core);
    expect(args).not.toContain("--no-write");
    expect(args).toContain("--i-understand-this-touches-production");
  });

  it("mainnet + SEP-12 leg: both flags", () => {
    const args = buildLegArgs(mainnetEntry, kyc);
    expect(args).toContain("--no-write");
    expect(args).toContain("--i-understand-this-touches-production");
  });

  it("passes --no-write on testnet too: the network must not gate it", () => {
    // The crawler must never create KYC records on any anchor, testnet included.
    expect(buildLegArgs(testnetEntry, kyc)).toContain("--no-write");
  });

  it("passes the production flag for a non-SEP-12 leg: the SEP must not gate it", () => {
    expect(buildLegArgs(mainnetEntry, core)).toContain("--i-understand-this-touches-production");
  });

  it("targets the leg's SEPs via --only and the entry's network", () => {
    const args = buildLegArgs(testnetEntry, core, { outputPath: "/tmp/x.json", timeoutMs: 20000 });
    expect(args.slice(0, 2)).toEqual(["check", "anchor.example.com"]);
    expect(args[args.indexOf("--only") + 1]).toBe("sep1,sep10,sep24,sep38");
    expect(args[args.indexOf("--network") + 1]).toBe("testnet");
    expect(args[args.indexOf("--format") + 1]).toBe("json");
    expect(args[args.indexOf("--output") + 1]).toBe("/tmp/x.json");
    expect(args[args.indexOf("--timeout") + 1]).toBe("20000");
  });

  it("puts SEP-12's dependencies in --only, because --only is a gate and not a filter", () => {
    // cli.ts:190 gates the SEP-10 block on --only, and SEP-12 is only reached with the JWT
    // SEP-10 produces (cli.ts:231). `--only sep12` therefore yields one `sep12.skipped`
    // and no SEP-12 check ids at all - the leg would exist and measure nothing.
    const args = buildLegArgs(testnetEntry, kyc);
    const only = args[args.indexOf("--only") + 1].split(",");
    expect(only).toContain("sep1");
    expect(only).toContain("sep10");
    expect(only).toContain("sep12");
  });

  it("keeps --only and --owns distinct: the kyc leg runs its dependencies but publishes only SEP-12", () => {
    expect(kyc.only).toEqual(["sep1", "sep10", "sep12"]);
    expect(kyc.owns).toEqual(["sep12"]);
    // The core leg has no dependency it does not also own.
    expect(core.only).toEqual(core.owns);
  });

  it("decides --no-write from what the leg executes, not from what it publishes", () => {
    // --no-write stops the CLI *issuing* SEP-12's mutating requests, so it has to follow
    // --only. A leg that ran SEP-12 without owning it would still need the flag.
    const runsButDoesNotOwn = { id: "x", only: ["sep1", "sep10", "sep12"], owns: ["sep10"] };
    expect(legTargetsSep12(runsButDoesNotOwn)).toBe(true);
    expect(buildLegArgs(testnetEntry, runsButDoesNotOwn)).toContain("--no-write");
  });

  it("rejects an entry with no domain or an unknown network", () => {
    expect(() => buildLegArgs({ network: "testnet" }, core)).toThrow(/domain/);
    expect(() => buildLegArgs({ domain: "a.example.com", network: "futurenet" }, core)).toThrow(/testnet or mainnet/);
  });

  it("splits into exactly the two legs, kyc owning sep12 alone", () => {
    expect(LEGS.map((l) => l.id)).toEqual(["core", "kyc"]);
    expect(legTargetsSep12(core)).toBe(false);
    expect(legTargetsSep12(kyc)).toBe(true);
    expect(entryIsMainnet(testnetEntry)).toBe(false);
    expect(entryIsMainnet(mainnetEntry)).toBe(true);
  });

  it("builds one invocation per leg with distinct output files", () => {
    const invocations = buildInvocations(testnetEntry, { outDir: "/tmp" });
    expect(invocations).toHaveLength(2);
    expect(new Set(invocations.map((i) => i.outputPath)).size).toBe(2);
  });
});

describe("merge-legs: ownership and union", () => {
  it("does not let sep1 claim sep10 ids", () => {
    // "sep10.negative.expired" starts with the characters "sep1", so the trailing dot in
    // the prefix is what keeps ownership correct.
    expect(ownedPrefixes(core)).toContain("sep1.");
    expect(ownsResult(core, "sep10.negative.expired")).toBe(true);
    expect(ownsResult({ owns: ["sep1"] }, "sep10.negative.expired")).toBe(false);
    expect(ownsResult({ owns: ["sep1"] }, "sep1.fetch")).toBe(true);
  });

  it("reads ownership from owns, not from the wider --only set", () => {
    // The kyc leg executes SEP-1 and SEP-10 as dependencies; it must not thereby claim
    // their results away from the core leg, whose call actually measures them properly.
    expect(kyc.only).toContain("sep10");
    expect(ownsResult(kyc, "sep10.challenge")).toBe(false);
    expect(ownsResult(kyc, "sep12.get_customer")).toBe(true);
    expect(unavailableMarkers(kyc, "why").map((m) => m.id)).toEqual(["sep12.crawl_unavailable"]);
  });

  it("drops a leg's results for SEPs it does not own, so legs cannot collide", () => {
    // Both legs run SEP-1 on every ordinary run (the kyc leg needs the toml to reach a
    // JWT). Without ownership filtering that would duplicate the core leg's sep1.* ids.
    const merged = mergeLegs({
      domain: "a.example.com",
      network: "testnet",
      timestamp: "2026-09-05T00:00:00Z",
      supportedVersion: 1,
      legs: [
        { leg: core, report: { schemaVersion: 1, domain: "a.example.com", network: "testnet", timestamp: "x", results: [check("sep1.fetch")] } },
        { leg: kyc, report: { schemaVersion: 1, domain: "a.example.com", network: "testnet", timestamp: "y", results: [check("sep1.fetch", "fail"), check("sep12.put_customer", "warn")] } },
      ],
    });

    const ids = merged.report.results.map((r) => r.id);
    expect(ids).toEqual(["sep1.fetch", "sep12.put_customer"]);
    expect(merged.report.results.find((r) => r.id === "sep1.fetch").status).toBe("pass");
  });

  it("keeps an id no leg owns rather than dropping it", () => {
    const merged = mergeLegs({
      domain: "a.example.com",
      network: "testnet",
      timestamp: "2026-09-05T00:00:00Z",
      supportedVersion: 1,
      legs: [
        { leg: core, report: { schemaVersion: 1, domain: "a.example.com", network: "testnet", timestamp: "x", results: [check("sep6.future_check")] } },
        { leg: kyc, report: { schemaVersion: 1, domain: "a.example.com", network: "testnet", timestamp: "y", results: [] } },
      ],
    });
    expect(merged.report.results.map((r) => r.id)).toEqual(["sep6.future_check"]);
  });

  it("uses the supplied crawl timestamp, not either leg's", () => {
    const merged = mergeLegs({
      domain: "a.example.com",
      network: "testnet",
      timestamp: "2026-09-05T00:00:00Z",
      supportedVersion: 1,
      legs: [
        { leg: core, report: { schemaVersion: 1, domain: "a.example.com", network: "testnet", timestamp: "2026-09-05T00:03:11Z", results: [] } },
        { leg: kyc, report: { schemaVersion: 1, domain: "a.example.com", network: "testnet", timestamp: "2026-09-05T00:07:42Z", results: [] } },
      ],
    });
    expect(merged.report.timestamp).toBe("2026-09-05T00:00:00Z");
  });

  it("throws when a leg's report is for a different anchor", () => {
    expect(() =>
      mergeLegs({
        domain: "a.example.com",
        network: "testnet",
        timestamp: "2026-09-05T00:00:00Z",
        supportedVersion: 1,
        legs: [{ leg: core, report: { schemaVersion: 1, domain: "other.example.com", network: "testnet", timestamp: "x", results: [] } }],
      }),
    ).toThrow(/expected a.example.com/);
  });
});

describe("merge-legs: schemaVersion is validated per leg before merge", () => {
  it("accepts an equal version", () => {
    expect(validateLegSchema({ schemaVersion: 1 }, 1).ok).toBe(true);
  });

  it("refuses a newer version rather than parsing optimistically", () => {
    const outcome = validateLegSchema({ schemaVersion: 2 }, 1);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("unsupported schemaVersion 2");
  });

  it("refuses a missing or non-integer version", () => {
    expect(validateLegSchema({}, 1).ok).toBe(false);
    expect(validateLegSchema({ schemaVersion: "1" }, 1).ok).toBe(false);
    expect(validateLegSchema({ schemaVersion: 1.5 }, 1).ok).toBe(false);
  });

  it("surfaces a version mismatch as an unavailable leg, publishing the other one", () => {
    const merged = mergeLegs({
      domain: "a.example.com",
      network: "testnet",
      timestamp: "2026-09-05T00:00:00Z",
      supportedVersion: 1,
      legs: [
        { leg: core, report: { schemaVersion: 1, domain: "a.example.com", network: "testnet", timestamp: "x", results: [check("sep1.fetch")] } },
        { leg: kyc, report: { schemaVersion: 99, domain: "a.example.com", network: "testnet", timestamp: "y", results: [check("sep12.put_customer")] } },
      ],
    });

    expect(merged.unavailable).toEqual([{ leg: "kyc", reason: expect.stringContaining("unsupported schemaVersion 99") }]);
    expect(merged.report.results.map((r) => r.id)).toEqual(["sep1.fetch", "sep12.crawl_unavailable"]);
    // The merged artifact is stamped with the version this crawler emits.
    expect(merged.report.schemaVersion).toBe(1);
  });
});

describe("merge-legs: partial failure markers", () => {
  it("emits one warn marker per SEP in the failed leg", () => {
    const markers = unavailableMarkers(core, "timeout after 15000ms");
    expect(markers.map((m) => m.id)).toEqual([
      "sep1.crawl_unavailable",
      "sep10.crawl_unavailable",
      "sep24.crawl_unavailable",
      "sep38.crawl_unavailable",
    ]);
    for (const marker of markers) {
      expect(marker.status).toBe("warn");
      expect(marker.severity).toBe("warning");
      expect(marker.message).toContain("timeout after 15000ms");
      expect(marker.message).toContain("not a finding about this anchor");
    }
  });

  it("publishes leg 1's results when leg 2 fails", () => {
    const merged = mergeLegs({
      domain: "a.example.com",
      network: "testnet",
      timestamp: "2026-09-05T00:00:00Z",
      supportedVersion: 1,
      legs: [
        { leg: core, report: { schemaVersion: 1, domain: "a.example.com", network: "testnet", timestamp: "x", results: [check("sep1.fetch")] } },
        { leg: kyc, report: undefined, reason: "timed out after one retry" },
      ],
    });
    expect(merged.report.results.map((r) => r.id)).toEqual(["sep1.fetch", "sep12.crawl_unavailable"]);
    expect(merged.unavailable).toEqual([{ leg: "kyc", reason: "timed out after one retry" }]);
  });

  it("publishes leg 2's results when leg 1 fails", () => {
    const merged = mergeLegs({
      domain: "a.example.com",
      network: "testnet",
      timestamp: "2026-09-05T00:00:00Z",
      supportedVersion: 1,
      legs: [
        { leg: core, report: undefined, reason: "exit 137" },
        { leg: kyc, report: { schemaVersion: 1, domain: "a.example.com", network: "testnet", timestamp: "y", results: [check("sep12.put_customer", "warn", "Skipped: --no-write mode enabled")] } },
      ],
    });
    const ids = merged.report.results.map((r) => r.id);
    expect(ids).toContain("sep12.put_customer");
    expect(ids).toContain("sep1.crawl_unavailable");
    expect(ids).toContain("sep38.crawl_unavailable");
  });

  it("keeps the dependency measurements of a surviving leg when their owner failed", () => {
    // The kyc leg runs SEP-1 and SEP-10 to reach SEP-12. If the core leg - their owner -
    // never produced a report, that dependency run is the only measurement of them this
    // crawl has, and discarding it in favour of a bare "did not run" marker would throw
    // away real data about the anchor.
    const merged = mergeLegs({
      domain: "a.example.com",
      network: "testnet",
      timestamp: "2026-09-05T00:00:00Z",
      supportedVersion: 1,
      legs: [
        { leg: core, report: undefined, reason: "exit 137" },
        {
          leg: kyc,
          report: {
            schemaVersion: 1,
            domain: "a.example.com",
            network: "testnet",
            timestamp: "y",
            results: [check("sep1.fetch"), check("sep10.challenge", "fail", "Expected 200, got 404"), check("sep12.skipped", "warn", "Skipped: SEP-12 requires SEP-10 for a JWT")],
          },
        },
      ],
    });

    const ids = merged.report.results.map((r) => r.id);
    expect(ids).toContain("sep1.fetch");
    expect(ids).toContain("sep10.challenge");
    expect(ids).toContain("sep12.skipped");
    // No contradiction: a SEP with a real verdict must not also carry a "did not run"
    // marker. The SEPs nothing measured still do, so the run reads as partial.
    expect(ids).not.toContain("sep1.crawl_unavailable");
    expect(ids).not.toContain("sep10.crawl_unavailable");
    expect(ids).toContain("sep24.crawl_unavailable");
    expect(ids).toContain("sep38.crawl_unavailable");
    expect(completenessOf(merged.report.results)).toBe("partial");
    // The leg still failed, and is still reported as such.
    expect(merged.unavailable).toEqual([{ leg: "core", reason: "exit 137" }]);
  });

  it("does not let a failed leg's marker override the owner's own results", () => {
    // The mirror case: the owner ran, so its verdicts win and the other leg's copies are
    // dropped - order within `legs` must not change the outcome.
    const legs = [
      { leg: core, report: { schemaVersion: 1, domain: "a.example.com", network: "testnet", timestamp: "x", results: [check("sep1.fetch", "fail", "Expected 200, got 404")] } },
      { leg: kyc, report: { schemaVersion: 1, domain: "a.example.com", network: "testnet", timestamp: "y", results: [check("sep1.fetch", "pass"), check("sep12.skipped", "warn", "Skipped: --no-write mode enabled")] } },
    ];
    const merged = mergeLegs({ domain: "a.example.com", network: "testnet", timestamp: "2026-09-05T00:00:00Z", supportedVersion: 1, legs });

    expect(merged.report.results.filter((r) => r.id === "sep1.fetch")).toHaveLength(1);
    expect(merged.report.results.find((r) => r.id === "sep1.fetch").status).toBe("fail");
  });

  it("still produces a report when both legs fail, marking every SEP", () => {
    const merged = mergeLegs({
      domain: "a.example.com",
      network: "testnet",
      timestamp: "2026-09-05T00:00:00Z",
      supportedVersion: 1,
      legs: [
        { leg: core, report: undefined, reason: "unreachable" },
        { leg: kyc, report: undefined, reason: "unreachable" },
      ],
    });
    expect(merged.unavailable).toHaveLength(2);
    expect(merged.report.results).toHaveLength(5);
    expect(merged.report.results.every((r) => r.status === "warn")).toBe(true);
  });
});

describe("aggregate-summary: warn and fail stay distinct", () => {
  it("never rolls a warn up to a fail", () => {
    expect(rollUpStatus([check("a"), check("b", "warn")])).toBe("warn");
    expect(rollUpStatus([check("a"), check("b", "warn"), check("c", "fail")])).toBe("fail");
    expect(rollUpStatus([check("a")])).toBe("pass");
  });

  it("rolls an empty result set up to warn, never pass", () => {
    expect(rollUpStatus([])).toBe("warn");
  });

  it("counts the two SEP-10 negative cases as not verified, not as problems", () => {
    const results = [
      check("sep10.negative.expired", "warn", 'Anchor rejected expired challenge with HTTP 400, but ... expiry was NOT verified by this run.'),
      check("sep10.negative.wrong_network", "warn", "Anchor rejected wrong-network challenge ... NOT verified by this run."),
      check("sep12.fields.unknown_name", "warn", '"photo_proof_of_income" is not a standard SEP-9 field'),
    ];
    const counts = countResults(results);
    expect(counts.warn).toBe(3);
    expect(counts.notVerified).toBe(2);
    expect(counts.fail).toBe(0);
    // The advisory one is the remainder, and must not be counted as unverified.
    expect(counts.warn - counts.notVerified).toBe(1);
  });

  it("recognises every not-exercised phrasing the checkers use", () => {
    for (const message of [
      "Skipped: --no-write mode enabled; mutating PUT /customer request omitted",
      "Not exercised: the anchor did not flag any provided_field as VERIFICATION_REQUIRED",
      "Inconclusive: none of the 2 record(s) carry asset_code",
      "... so challenge expiry was NOT verified by this run",
    ]) {
      expect(isNotVerified(check("x.y", "warn", message)), message).toBe(true);
    }
  });

  it("never treats a pass or a fail as not verified", () => {
    expect(isNotVerified(check("sep10.negative.expired", "fail", "AUTHENTICATION BYPASS"))).toBe(false);
    expect(isNotVerified(check("sep10.jwt_signature", "pass", "verified"))).toBe(false);
  });

  it("treats crawl_unavailable markers as not verified", () => {
    const marker = unavailableMarkers(kyc, "timeout")[0];
    expect(isCrawlUnavailable(marker)).toBe(true);
    expect(isNotVerified(marker)).toBe(true);
  });
});

describe("aggregate-summary: completeness", () => {
  const full = { schemaVersion: 1, domain: "a.example.com", network: "testnet", timestamp: "2026-09-04T00:00:00Z", results: [check("sep1.fetch")] };
  const partial = {
    schemaVersion: 1,
    domain: "a.example.com",
    network: "testnet",
    timestamp: "2026-09-05T00:00:00Z",
    results: [check("sep1.fetch"), unavailableMarkers(kyc, "timeout")[0]],
  };

  it("flags a run containing a crawl_unavailable marker as partial", () => {
    expect(completenessOf(full.results)).toBe("full");
    expect(completenessOf(partial.results)).toBe("partial");
  });

  it("carries completeness on the entry and on every history point", () => {
    const entry = buildEntry({
      domain: "a.example.com",
      network: "testnet",
      reports: [partial, full],
      now: "2026-09-05T01:00:00Z",
    });

    expect(entry.lastChecked).toBe("2026-09-05T00:00:00Z");
    expect(entry.completeness).toBe("partial");
    expect(entry.history.map((h) => h.completeness)).toEqual(["full", "partial"]);
    // History is ascending regardless of input order.
    expect(entry.history.map((h) => h.timestamp)).toEqual([full.timestamp, partial.timestamp]);
  });

  it("does not let a partial run out-score a complete one", () => {
    // The reason partials are flagged: a run where a leg never executed reports fewer
    // checks, so a naive pass ratio would rank it above a complete run with one failure.
    const partialEntry = buildEntry({ domain: "a.example.com", network: "testnet", reports: [partial], now: "2026-09-05T01:00:00Z" });
    expect(partialEntry.status).toBe("warn");
    expect(partialEntry.completeness).toBe("partial");
  });

  it("drops history points older than the retention window", () => {
    const ancient = { ...full, timestamp: "2024-01-01T00:00:00Z" };
    const entry = buildEntry({
      domain: "a.example.com",
      network: "testnet",
      reports: [ancient, full],
      now: "2026-09-05T00:00:00Z",
    });
    expect(entry.history.map((h) => h.timestamp)).toEqual([full.timestamp]);
  });

  it("orders the index by domain then network", () => {
    const mk = (domain, network) => ({
      domain,
      network,
      reports: [{ ...full, domain, network }],
    });
    const summary = buildSummary([mk("b.example.com", "testnet"), mk("a.example.com", "testnet"), mk("a.example.com", "mainnet")], {
      now: "2026-09-05T00:00:00Z",
    });
    expect(summary.map((e) => `${e.domain}/${e.network}`)).toEqual([
      "a.example.com/mainnet",
      "a.example.com/testnet",
      "b.example.com/testnet",
    ]);
  });
});

describe("prune-retention", () => {
  const now = "2026-09-05T00:00:00Z";

  it("prunes snapshots past 90 days and keeps the rest", () => {
    // 90 days before 2026-09-05 is 2026-06-07, so 2026-06-01 is outside the window and
    // 2026-07-15 is inside it.
    const { keep, prune } = classifyDetailFiles(
      ["2026-09-04T000000Z.json", "2026-07-15T000000Z.json", "2026-06-01T000000Z.json", "2025-01-01T000000Z.json"],
      now,
    );
    expect(prune).toEqual(["2026-06-01T000000Z.json", "2025-01-01T000000Z.json"]);
    expect(keep).toContain("2026-09-04T000000Z.json");
    expect(keep).toContain("2026-07-15T000000Z.json");
    expect(DETAIL_RETENTION_DAYS).toBe(90);
  });

  it("never prunes latest.json", () => {
    const { keep, prune } = classifyDetailFiles(["latest.json"], now);
    expect(keep).toEqual(["latest.json"]);
    expect(prune).toEqual([]);
  });

  it("keeps and reports a file it does not recognise rather than deleting it", () => {
    const { keep, prune, unrecognised } = classifyDetailFiles(["notes.txt", "2020-01-01.json"], now);
    expect(prune).toEqual([]);
    expect(keep).toEqual(["notes.txt", "2020-01-01.json"]);
    expect(unrecognised).toEqual(["notes.txt", "2020-01-01.json"]);
  });

  it("ages a partial run exactly like a complete one", () => {
    // Retention is by age only; `completeness` is what stops a partial being *scored*
    // like a complete run, so there is no second clock here.
    const { prune } = classifyDetailFiles(["2025-01-01T000000Z.json"], now);
    expect(prune).toHaveLength(1);
  });
});

describe("storage-paths", () => {
  it("lays out reports domain-first, per §4.2", () => {
    expect(reportPath("a.example.com", "testnet", "2026-09-05T00:00:00Z")).toBe(
      "data/reports/a.example.com/testnet/2026-09-05T000000Z.json",
    );
    expect(latestPath("a.example.com", "mainnet")).toBe("data/reports/a.example.com/mainnet/latest.json");
  });

  it("round-trips a timestamp through the filename", () => {
    const iso = "2026-09-05T00:03:11Z";
    expect(parseFileStamp(`${fileStamp(iso)}.json`)).toBe(iso);
  });

  it("rejects a domain that could escape the reports root", () => {
    expect(() => reportPath("../../etc", "testnet", "2026-09-05T00:00:00Z")).toThrow(/safe path segment/);
    expect(() => reportPath("a/b", "testnet", "2026-09-05T00:00:00Z")).toThrow(/safe path segment/);
    expect(() => reportPath("", "testnet", "2026-09-05T00:00:00Z")).toThrow(/non-empty/);
  });

  it("rejects a timestamp that is not an ISO instant", () => {
    expect(() => fileStamp("2026-09-05")).toThrow(/ISO 8601/);
    expect(() => fileStamp("2026-09-05T00:00:00+01:00")).toThrow(/ISO 8601/);
  });

  it("does not mistake an arbitrary name for a stamp", () => {
    expect(parseFileStamp("latest.json")).toBeUndefined();
    expect(parseFileStamp("summary.json")).toBeUndefined();
  });
});

describe("run-anchor: transient detection drives the one retry", () => {
  const report = (results) => ({ schemaVersion: 1, domain: "a.example.com", network: "testnet", timestamp: "x", results });

  it("treats an unreachable toml as transient", () => {
    expect(looksTransient(report([check("sep1.fetch", "fail", "Request to https://a/.well-known/stellar.toml failed: DNS lookup failed")]))).toBe(true);
    expect(looksTransient(report([check("sep1.fetch", "fail", "Request timed out after 10000ms")]))).toBe(true);
  });

  it("does not retry a real verdict", () => {
    expect(looksTransient(report([check("sep1.fetch"), check("sep10.challenge", "fail", "Expected 200, got 404")]))).toBe(false);
    expect(looksTransient(report([check("sep1.fetch")]))).toBe(false);
  });

  it("does not retry when only some endpoints are flaky", () => {
    // One bad endpoint is a finding about the anchor; the whole anchor being unreachable
    // is what deserves a second attempt.
    expect(
      looksTransient(
        report([check("sep1.fetch"), check("sep38.info", "fail", "HTTP 503"), check("sep24.info", "fail", "Expected deposit object")]),
      ),
    ).toBe(false);
  });
});
