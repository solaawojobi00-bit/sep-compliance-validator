/**
 * Pure registry validation logic, kept out of the workflow YAML and out of the CLI
 * wrappers so it can be unit tested. See test/registry.test.mjs.
 *
 * Nothing here performs I/O: callers read the files and hand the parsed values in. That
 * is what makes the duplicate and diff rules testable without a network or a git repo.
 */
// The 2020 build, not ajv's default export: the default only knows draft-07, and
// registry/schema.json declares draft 2020-12 (which is what $defs belongs to).
import Ajv from "ajv/dist/2020.js";

/** Domains are case-insensitive, so the registry's key is the lowercased domain. */
export function normalizeDomain(domain) {
  return typeof domain === "string" ? domain.trim().toLowerCase() : "";
}

/**
 * Validates the registry against its JSON Schema, returning human-readable messages
 * rather than ajv's error objects — these are read by an anchor operator in a CI log,
 * not by a program.
 */
export function validateAgainstSchema(registry, schema) {
  // allErrors: an operator fixing their entry should see every problem at once, not one
  // per push. strict stays on so a typo in the schema itself is an error, not a silently
  // ignored keyword.
  const ajv = new Ajv({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);

  if (validate(registry)) {
    return [];
  }

  return (validate.errors ?? []).map((err) => {
    const where = err.instancePath === "" ? "registry root" : err.instancePath;
    const detail = err.params?.allowedValues
      ? `${err.message} (${err.params.allowedValues.join(", ")})`
      : err.message;
    return `${where}: ${detail}`;
  });
}

/**
 * Domains listed more than once, compared case-insensitively.
 *
 * A duplicate is not merely untidy: the crawler writes results under
 * data/reports/<network>/<domain>/, so two entries for one domain on one network would
 * race to overwrite each other's history. Two entries for the *same* domain on
 * *different* networks are legitimate and are not duplicates.
 */
export function findDuplicates(registry) {
  const seen = new Map();
  const duplicates = [];

  for (const entry of registry) {
    const key = `${normalizeDomain(entry?.domain)}|${entry?.network}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count === 2) {
      duplicates.push(`${normalizeDomain(entry?.domain)} (${entry?.network})`);
    }
  }

  return duplicates;
}

/**
 * Entries whose domain is not already in the registry as it stands on the base branch,
 * or whose domain is being re-enabled after an opt-out.
 *
 * Only these need their stellar.toml checked: re-verifying every registered domain on
 * every pull request would make an unrelated PR fail because a third party's server is
 * down, which is the mistake the live-anchor workflow exists to avoid.
 */
export function changedEntries(before, after) {
  const baseline = new Map();
  for (const entry of Array.isArray(before) ? before : []) {
    baseline.set(`${normalizeDomain(entry?.domain)}|${entry?.network}`, entry);
  }

  return (Array.isArray(after) ? after : []).filter((entry) => {
    const previous = baseline.get(`${normalizeDomain(entry?.domain)}|${entry?.network}`);
    if (!previous) {
      return true;
    }
    // An entry going from opted-out to opted-in is effectively a new registration, so it
    // is re-verified. Any other edit (name, contact) is not worth a live request.
    return previous.enabled === false && entry?.enabled === true;
  });
}

/** The entries a crawler should actually visit: opted in, and nothing else. */
export function enabledEntries(registry) {
  return (Array.isArray(registry) ? registry : []).filter((entry) => entry?.enabled === true);
}
