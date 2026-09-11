import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  changedEntries,
  createProofMessage,
  enabledEntries,
  evaluateOwnershipProof,
  findDuplicates,
  normalizeDomain,
  validateAgainstSchema,
  verifyProofSignature,
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

describe("createProofMessage", () => {
  it("formats canonical proof message with normalized domain", () => {
    const msg = createProofMessage({
      domain: "  Anchor.Example.COM  ",
      network: "testnet",
      addedAt: "2026-09-04T00:00:00Z",
    });
    expect(msg).toBe("stellar-anchor-registry:anchor.example.com:testnet:2026-09-04T00:00:00Z");
  });
});

describe("verifyProofSignature", () => {
  const keypair = Keypair.random();
  const signingKey = keypair.publicKey();
  const message = "stellar-anchor-registry:anchor.example.com:testnet:2026-09-04T00:00:00Z";
  const signature = Buffer.from(keypair.sign(Buffer.from(message, "utf-8"))).toString("base64");

  it("returns true for a valid signature", () => {
    expect(verifyProofSignature({ message, signingKey, signature })).toBe(true);
  });

  it("returns false for a signature from a different keypair", () => {
    const otherKeypair = Keypair.random();
    expect(verifyProofSignature({ message, signingKey: otherKeypair.publicKey(), signature })).toBe(false);
  });

  it("returns false for tampered message content", () => {
    expect(
      verifyProofSignature({
        message: "stellar-anchor-registry:different.example.com:testnet:2026-09-04T00:00:00Z",
        signingKey,
        signature,
      }),
    ).toBe(false);
  });

  it("returns false for malformed base64 or invalid signature buffer length", () => {
    expect(
      verifyProofSignature({
        message,
        signingKey,
        signature: Buffer.from("short").toString("base64"),
      }),
    ).toBe(false);
  });

  it("returns false for invalid public key", () => {
    expect(
      verifyProofSignature({
        message,
        signingKey: "NOT_A_VALID_STELLAR_KEY",
        signature,
      }),
    ).toBe(false);
  });

  it("returns false when inputs are missing", () => {
    expect(verifyProofSignature({ message: "", signingKey, signature })).toBe(false);
    expect(verifyProofSignature({ message, signingKey: "", signature })).toBe(false);
    expect(verifyProofSignature({ message, signingKey, signature: "" })).toBe(false);
  });
});

describe("evaluateOwnershipProof", () => {
  const keypair = Keypair.random();
  const signingKey = keypair.publicKey();
  const entry = { ...validEntry };
  const message = createProofMessage(entry);
  const signature = Buffer.from(keypair.sign(Buffer.from(message, "utf-8"))).toString("base64");

  const validProof = {
    domain: entry.domain,
    network: entry.network,
    addedAt: entry.addedAt,
    signingKey,
    signature,
  };

  it("verifies a valid proof matching stellar.toml SIGNING_KEY", () => {
    const res = evaluateOwnershipProof({
      entry,
      tomlSigningKey: signingKey,
      proof: validProof,
    });
    expect(res.status).toBe("verified");
    expect(res.signingKey).toBe(signingKey);
    expect(res.message).toContain("verified");
  });

  it("falls back to manual review if stellar.toml has no SIGNING_KEY", () => {
    const res = evaluateOwnershipProof({
      entry,
      tomlSigningKey: undefined,
      proof: validProof,
    });
    expect(res.status).toBe("manual_review");
    expect(res.message).toContain("maintainer review");
  });

  it("returns missing_proof if stellar.toml declares SIGNING_KEY but proof is missing", () => {
    const res = evaluateOwnershipProof({
      entry,
      tomlSigningKey: signingKey,
      proof: null,
    });
    expect(res.status).toBe("missing_proof");
    expect(res.message).toContain("no proof file was found");
  });

  it("detects replayed proof with mismatched domain", () => {
    const res = evaluateOwnershipProof({
      entry: { ...entry, domain: "other.example.com" },
      tomlSigningKey: signingKey,
      proof: validProof,
    });
    expect(res.status).toBe("mismatched_payload");
    expect(res.message).toContain("payload mismatch");
  });

  it("detects replayed proof with mismatched network or addedAt", () => {
    const resNet = evaluateOwnershipProof({
      entry: { ...entry, network: "mainnet" },
      tomlSigningKey: signingKey,
      proof: validProof,
    });
    expect(resNet.status).toBe("mismatched_payload");

    const resDate = evaluateOwnershipProof({
      entry: { ...entry, addedAt: "2026-09-10T00:00:00Z" },
      tomlSigningKey: signingKey,
      proof: validProof,
    });
    expect(resDate.status).toBe("mismatched_payload");
  });

  it("rejects proof with key_mismatch when proof signingKey != toml SIGNING_KEY", () => {
    const otherKey = Keypair.random().publicKey();
    const res = evaluateOwnershipProof({
      entry,
      tomlSigningKey: otherKey,
      proof: validProof,
    });
    expect(res.status).toBe("key_mismatch");
    expect(res.message).toContain("does not match SIGNING_KEY");
  });

  it("rejects invalid signature for the published SIGNING_KEY", () => {
    const otherKp = Keypair.random();
    const invalidSig = Buffer.from(otherKp.sign(Buffer.from(message, "utf-8"))).toString("base64");
    const res = evaluateOwnershipProof({
      entry,
      tomlSigningKey: signingKey,
      proof: { ...validProof, signature: invalidSig },
    });
    expect(res.status).toBe("invalid_signature");
    expect(res.message).toContain("signature is invalid");
  });
});

