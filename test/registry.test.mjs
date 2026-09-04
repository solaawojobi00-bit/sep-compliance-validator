import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  changedEntries,
  enabledEntries,
  findDuplicates,
  normalizeDomain,
  validateAgainstSchema,
} from "../scripts/registry-lib.mjs";

const schema = JSON.parse(readFileSync(new URL("../registry/schema.json", import.meta.url), "utf-8"));
const registry = JSON.parse(readFileSync(new URL("../registry/anchors.json", import.meta.url), "utf-8"));

/** A conformant entry; individual tests override one field at a time. */
const validEntry = {
  domain: "anchor.example.com",
  name: "Example Anchor",
  network: "testnet",
  enabled: true,
  contact: "ops@example.com",
  addedAt: "2026-09-04T00:00:00Z",
};

const withField = (overrides) => [{ ...validEntry, ...overrides }];

describe("registry/anchors.json as committed", () => {
  it("conforms to its own schema", () => {
    expect(validateAgainstSchema(registry, schema)).toEqual([]);
  });

  it("has no duplicate entries", () => {
    expect(findDuplicates(registry)).toEqual([]);
  });
});

describe("validateAgainstSchema", () => {
  it("accepts a conformant entry", () => {
    expect(validateAgainstSchema(withField({}), schema)).toEqual([]);
  });

  it("rejects an unknown network", () => {
    const errors = validateAgainstSchema(withField({ network: "futurenet" }), schema);
    expect(errors.join(" ")).toContain("testnet, mainnet");
  });

  it.each([
    ["a scheme", "https://anchor.example.com"],
    ["a path", "anchor.example.com/kyc"],
    ["a port", "anchor.example.com:8000"],
    ["a trailing dot", "anchor.example.com."],
    ["uppercase", "Anchor.Example.COM"],
    ["a single label", "localhost"],
    ["an empty string", ""],
  ])("rejects a domain with %s", (_label, domain) => {
    expect(validateAgainstSchema(withField({ domain }), schema).length).toBeGreaterThan(0);
  });

  it("accepts a domain with hyphens and several labels", () => {
    expect(validateAgainstSchema(withField({ domain: "kyc-1.eu.anchor-co.example" }), schema)).toEqual([]);
  });

  it.each([
    ["a date with no time", "2026-09-04"],
    ["a local time with no zone", "2026-09-04T00:00:00"],
    ["a non-UTC offset", "2026-09-04T00:00:00+01:00"],
    ["free text", "September 2026"],
  ])("rejects addedAt as %s", (_label, addedAt) => {
    expect(validateAgainstSchema(withField({ addedAt }), schema).length).toBeGreaterThan(0);
  });

  it("accepts addedAt with fractional seconds", () => {
    expect(validateAgainstSchema(withField({ addedAt: "2026-09-04T12:30:00.123Z" }), schema)).toEqual([]);
  });

  it("rejects a contact that is not an email address", () => {
    expect(validateAgainstSchema(withField({ contact: "https://example.com/support" }), schema).length)
      .toBeGreaterThan(0);
  });

  it("rejects enabled given as a string rather than a boolean", () => {
    // "false" is truthy, so a string here would silently opt an anchor *in*.
    expect(validateAgainstSchema(withField({ enabled: "false" }), schema).length).toBeGreaterThan(0);
  });

  it.each(["domain", "name", "network", "enabled", "contact", "addedAt"])(
    "rejects an entry missing %s",
    (field) => {
      const entry = { ...validEntry };
      delete entry[field];
      const errors = validateAgainstSchema([entry], schema);
      expect(errors.join(" ")).toContain("required");
    },
  );

  it("rejects unknown properties, so a typo cannot be silently ignored", () => {
    const errors = validateAgainstSchema(withField({ enable: true }), schema);
    expect(errors.join(" ")).toContain("additional properties");
  });

  it("rejects an entry that is not an object", () => {
    expect(validateAgainstSchema(["anchor.example.com"], schema).length).toBeGreaterThan(0);
  });

  it("accepts an empty registry", () => {
    expect(validateAgainstSchema([], schema)).toEqual([]);
  });

  it("reports every problem at once rather than one per push", () => {
    const errors = validateAgainstSchema(
      withField({ network: "futurenet", contact: "nope", addedAt: "yesterday" }),
      schema,
    );
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("findDuplicates", () => {
  it("reports a domain listed twice on the same network", () => {
    expect(findDuplicates([validEntry, { ...validEntry, name: "Copy" }])).toEqual([
      "anchor.example.com (testnet)",
    ]);
  });

  it("compares case-insensitively", () => {
    expect(
      findDuplicates([validEntry, { ...validEntry, domain: "ANCHOR.EXAMPLE.COM" }]),
    ).toEqual(["anchor.example.com (testnet)"]);
  });

  it("allows the same domain on both networks", () => {
    // Results are stored per network, so these two cannot collide.
    expect(findDuplicates([validEntry, { ...validEntry, network: "mainnet" }])).toEqual([]);
  });

  it("reports a domain listed three times only once", () => {
    expect(
      findDuplicates([validEntry, { ...validEntry }, { ...validEntry }]),
    ).toEqual(["anchor.example.com (testnet)"]);
  });
});

describe("changedEntries", () => {
  it("treats every entry as new when the base registry did not exist", () => {
    expect(changedEntries(undefined, [validEntry])).toHaveLength(1);
  });

  it("returns a newly added domain", () => {
    const added = { ...validEntry, domain: "new.example.com" };
    expect(changedEntries([validEntry], [validEntry, added])).toEqual([added]);
  });

  it("ignores an unchanged entry, so an unrelated edit is not blocked by an outage", () => {
    expect(changedEntries([validEntry], [validEntry])).toEqual([]);
  });

  it("ignores a cosmetic edit to an existing entry", () => {
    expect(
      changedEntries([validEntry], [{ ...validEntry, name: "Renamed", contact: "new@example.com" }]),
    ).toEqual([]);
  });

  it("re-verifies an entry being re-enabled after an opt-out", () => {
    const optedOut = { ...validEntry, enabled: false };
    expect(changedEntries([optedOut], [validEntry])).toEqual([validEntry]);
  });

  it("does not verify an entry being opted out", () => {
    // Opting out must never be blocked, least of all by the anchor being unreachable.
    expect(changedEntries([validEntry], [{ ...validEntry, enabled: false }])).toEqual([]);
  });

  it("treats the same domain on a different network as a new registration", () => {
    const mainnet = { ...validEntry, network: "mainnet" };
    expect(changedEntries([validEntry], [validEntry, mainnet])).toEqual([mainnet]);
  });
});

describe("enabledEntries", () => {
  it("excludes opted-out entries", () => {
    const optedOut = { ...validEntry, domain: "gone.example.com", enabled: false };
    expect(enabledEntries([validEntry, optedOut])).toEqual([validEntry]);
  });

  it("excludes an entry whose enabled flag is missing or not literally true", () => {
    expect(enabledEntries([{ ...validEntry, enabled: undefined }])).toEqual([]);
    expect(enabledEntries([{ ...validEntry, enabled: "true" }])).toEqual([]);
  });

  it("returns an empty list for a non-array", () => {
    expect(enabledEntries(null)).toEqual([]);
  });
});

describe("normalizeDomain", () => {
  it("lowercases and trims", () => {
    expect(normalizeDomain("  Anchor.Example.COM  ")).toBe("anchor.example.com");
  });

  it("returns an empty string for a non-string", () => {
    expect(normalizeDomain(undefined)).toBe("");
    expect(normalizeDomain(42)).toBe("");
  });
});
