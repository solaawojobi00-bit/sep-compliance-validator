#!/usr/bin/env node
/**
 * Generates an anchor domain ownership proof for registering in registry/anchors.json.
 * Signs the canonical registration challenge payload with the secret key of the anchor's
 * published SIGNING_KEY.
 *
 * Usage:
 *   node scripts/sign-registry-proof.mjs <domain> <network> <addedAt> <SECRET_KEY> [--out <filepath>]
 *
 * Or via environment variable:
 *   STELLAR_SECRET_KEY=S... node scripts/sign-registry-proof.mjs <domain> <network> <addedAt>
 */
import { writeFileSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import { createProofMessage, normalizeDomain } from "./registry-lib.mjs";

const args = process.argv.slice(2);

let domain = "";
let network = "";
let addedAt = "";
let secretKey = process.env.STELLAR_SECRET_KEY ?? "";
let outPath = "";

const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out" && i + 1 < args.length) {
    outPath = args[++i];
  } else {
    positional.push(args[i]);
  }
}

if (positional.length >= 3) {
  domain = positional[0];
  network = positional[1];
  addedAt = positional[2];
  if (positional.length >= 4) {
    secretKey = positional[3];
  }
}

if (!domain || !network || !addedAt || !secretKey) {
  console.error(
    "Usage: node scripts/sign-registry-proof.mjs <domain> <network> <addedAt> [SECRET_KEY] [--out <filepath>]\n" +
      "Example: node scripts/sign-registry-proof.mjs anchor.example.com testnet 2026-09-04T00:00:00Z SXXX...",
  );
  process.exit(1);
}

if (!["testnet", "mainnet"].includes(network)) {
  console.error(`Invalid network "${network}". Must be "testnet" or "mainnet".`);
  process.exit(1);
}

let keypair;
try {
  keypair = Keypair.fromSecret(secretKey);
} catch (err) {
  console.error(`Invalid Stellar secret key: ${err.message}`);
  process.exit(1);
}

const normalized = normalizeDomain(domain);
const signingKey = keypair.publicKey();
const message = createProofMessage({ domain: normalized, network, addedAt });
const signatureBuf = keypair.sign(Buffer.from(message, "utf-8"));
const signature = Buffer.from(signatureBuf).toString("base64");

const proof = {
  domain: normalized,
  network,
  addedAt,
  signingKey,
  signature,
};

const proofJson = JSON.stringify(proof, null, 2);

if (outPath) {
  writeFileSync(outPath, proofJson + "\n", "utf-8");
  console.log(`Proof written to ${outPath}`);
} else {
  console.log(proofJson);
}
