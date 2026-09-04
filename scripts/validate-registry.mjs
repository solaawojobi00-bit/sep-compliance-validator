#!/usr/bin/env node
/**
 * Validates registry/anchors.json against registry/schema.json and rejects duplicate
 * entries. Offline and hermetic: no network, so this gate never fails because a third
 * party's server is down. The live stellar.toml check is a separate script.
 *
 * Usage: node scripts/validate-registry.mjs [registry.json] [schema.json]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { validateAgainstSchema, findDuplicates, enabledEntries } from "./registry-lib.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = resolve(process.argv[2] ?? join(repoRoot, "registry", "anchors.json"));
const schemaPath = resolve(process.argv[3] ?? join(repoRoot, "registry", "schema.json"));

function readJson(path, label) {
  let text;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    console.error(`::error::Cannot read ${label} at ${path}: ${err.message}`);
    process.exit(1);
  }
  try {
    // A BOM is invisible in an editor but fatal to JSON.parse, and this file is
    // hand-edited by contributors on every platform. Strip it rather than reject it.
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch (err) {
    // A trailing comma is the single most likely way a hand-edited registry breaks.
    console.error(`::error::${label} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
}

const registry = readJson(registryPath, "registry");
const schema = readJson(schemaPath, "schema");

const problems = [];

if (!Array.isArray(registry)) {
  problems.push("registry root: must be a JSON array of entries");
} else {
  problems.push(...validateAgainstSchema(registry, schema));

  for (const duplicate of findDuplicates(registry)) {
    problems.push(
      `duplicate entry for ${duplicate}: one domain may appear once per network, since ` +
        `stored results are keyed by network and domain`,
    );
  }
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`::error::${problem}`);
  }
  console.error(`\n${problems.length} problem(s) in ${registryPath}`);
  process.exit(1);
}

const enabled = enabledEntries(registry);
console.log(
  `registry OK: ${registry.length} entr${registry.length === 1 ? "y" : "ies"}, ` +
    `${enabled.length} enabled, ${registry.length - enabled.length} opted out`,
);
