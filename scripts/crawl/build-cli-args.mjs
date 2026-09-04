/**
 * Builds the CLI invocations for one registry entry.
 *
 * Each anchor is crawled in two legs rather than one call, because the two flag
 * conditions below are orthogonal and a single call cannot satisfy both without
 * sacrificing coverage:
 *
 *   core - sep1, sep10, sep24, sep38. No --no-write, so SEP-38's POST /quote checks
 *          actually run.
 *   kyc  - sep12, always --no-write.
 *
 * A single combined call would have to carry --no-write (because it includes SEP-12),
 * which would also skip SEP-38's quote checks as collateral. Splitting keeps them.
 *
 * Each leg declares two lists, and they are deliberately not the same list:
 *
 *   only - what goes into --only. This must include every SEP the leg's own SEPs depend
 *          on, because --only is a hard gate in cli.ts, not a filter over a full run.
 *          SEP-12 needs a JWT, the JWT comes from SEP-10, and SEP-10 needs the toml from
 *          SEP-1 - so `--only sep12` alone never reaches SEP-12 at all: cli.ts:190 skips
 *          the SEP-10 block, `jwt` stays undefined, and the leg emits a single
 *          `sep12.skipped` instead of SEP-12's own check ids.
 *   owns - what the leg's results are published under. The dependencies run but belong to
 *          the core leg, whose call is the one configured to measure them (no --no-write,
 *          and the client-domain and negative-case paths). mergeLegs drops the kyc leg's
 *          duplicate SEP-1 and SEP-10 results on this basis.
 *
 * Note what the kyc leg can and cannot prove. Under --no-write, runSep12Checks returns
 * six skip warnings and performs no requests, so the leg produces no SEP-12 verdicts by
 * design — "the crawler must never create KYC records on any anchor" and "validate
 * SEP-12's write endpoints" are mutually exclusive. The leg exists so the published
 * report says SEP-12 was *not exercised*, under SEP-12's own check ids, rather than
 * omitting SEP-12 and letting the dashboard imply it was fine.
 */

/**
 * Leg definitions. `only` is the --only value (SEPs to execute, dependencies included);
 * `owns` is the set whose results this leg publishes.
 */
export const LEGS = [
  { id: "core", only: ["sep1", "sep10", "sep24", "sep38"], owns: ["sep1", "sep10", "sep24", "sep38"] },
  { id: "kyc", only: ["sep1", "sep10", "sep12"], owns: ["sep12"] },
];

export function legById(id) {
  const leg = LEGS.find((l) => l.id === id);
  if (!leg) {
    throw new Error(`unknown leg id: ${JSON.stringify(id)}`);
  }
  return leg;
}

/**
 * Whether this leg's --only selection includes SEP-12.
 *
 * Read from `only`, not `owns`: --no-write exists to stop the CLI *executing* SEP-12's
 * mutating requests, and it is --only that decides whether it executes them.
 */
export function legTargetsSep12(leg) {
  return leg.only.includes("sep12");
}

/** Whether this registry entry names a production network. */
export function entryIsMainnet(entry) {
  return entry?.network === "mainnet";
}

/**
 * argv for one leg, after the `node dist/cli.js` prefix.
 *
 * The two flag conditions are deliberately written as two flat, independent `if`s. They
 * are not combined, nested, or derived from one another: dropping either one must be a
 * visible deletion in review, and must not silently change the other.
 */
export function buildLegArgs(entry, leg, { outputPath, timeoutMs } = {}) {
  if (!entry?.domain) {
    throw new Error("registry entry must have a domain");
  }
  if (entry.network !== "testnet" && entry.network !== "mainnet") {
    throw new Error(`registry entry network must be testnet or mainnet, got ${JSON.stringify(entry.network)}`);
  }

  const args = [
    "check",
    entry.domain,
    "--network",
    entry.network,
    "--only",
    leg.only.join(","),
    "--format",
    "json",
  ];

  if (outputPath) {
    args.push("--output", outputPath);
  }
  if (timeoutMs !== undefined) {
    args.push("--timeout", String(timeoutMs));
  }

  // Condition 1 - this leg targets SEP-12. Independent of network: it applies on
  // testnet exactly as it does on mainnet, because the crawler must never create KYC
  // records on any anchor, ever.
  if (legTargetsSep12(leg)) {
    args.push("--no-write");
  }

  // Condition 2 - the entry's network is mainnet. Independent of which SEPs this leg
  // covers: the CLI refuses to touch production without it regardless of the checks run.
  if (entryIsMainnet(entry)) {
    args.push("--i-understand-this-touches-production");
  }

  return args;
}

/** Both legs for one entry, in run order, each with the file its report is written to. */
export function buildInvocations(entry, { outDir, timeoutMs } = {}) {
  return LEGS.map((leg) => {
    const outputPath = outDir ? `${outDir}/${entry.domain}.${entry.network}.${leg.id}.json` : undefined;
    return { leg, outputPath, args: buildLegArgs(entry, leg, { outputPath, timeoutMs }) };
  });
}
