import { StrKey } from "@stellar/stellar-sdk";
import type { CheckResult } from "../core/report.js";

export interface Currency {
  code?: string;
  code_template?: string;
  issuer?: string;
  contract?: string;
  status?: string;
  display_decimals?: number;
  name?: string;
  desc?: string;
  conditions?: string;
  image?: string;
  fixed_number?: number;
  max_number?: number;
  is_unlimited?: boolean;
  is_asset_anchored?: boolean;
  anchor_asset_type?: string;
  anchor_asset?: string;
  attestation_of_reserve?: string;
  redemption_instructions?: string;
  collateral_addresses?: string[];
  collateral_address_messages?: string[];
  collateral_address_signatures?: string[];
  regulated?: boolean;
  approval_server?: string;
  approval_criteria?: string;
  toml?: string;
  [key: string]: unknown;
}

const VALID_STATUSES = new Set(["live", "dead", "test", "private"]);
const VALID_ANCHOR_ASSET_TYPES = new Set([
  "fiat",
  "crypto",
  "nft",
  "stock",
  "bond",
  "commodity",
  "realestate",
  "other",
]);

export function validateCurrencies(
  rawCurrencies: unknown,
  results: CheckResult[],
): Currency[] | undefined {
  if (rawCurrencies === undefined || rawCurrencies === null) {
    return undefined;
  }

  if (!Array.isArray(rawCurrencies)) {
    results.push({
      id: "sep1.currencies",
      description: "CURRENCIES must be an array of currency tables",
      status: "fail",
      severity: "error",
      message: `CURRENCIES must be an array, got ${typeof rawCurrencies}`,
    });
    return undefined;
  }

  const currencies: Currency[] = [];

  rawCurrencies.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      results.push({
        id: "sep1.currencies",
        description: "CURRENCIES entry must be a table",
        status: "fail",
        severity: "error",
        message: `CURRENCIES[${index}] must be a table, got ${typeof item}`,
      });
      return;
    }

    const c = item as Currency;
    currencies.push(c);

    const assetIdentifier =
      typeof c.code === "string" && c.code.length > 0
        ? c.code
        : typeof c.code_template === "string" && c.code_template.length > 0
          ? c.code_template
          : undefined;

    const label = assetIdentifier
      ? `CURRENCIES[${index}] (${assetIdentifier})`
      : `CURRENCIES[${index}]`;

    let entryFailed = false;

    // 1. code / code_template
    if (c.code === undefined && c.code_template === undefined) {
      results.push({
        id: "sep1.currencies.code",
        description: "Currency code or code_template required",
        status: "fail",
        severity: "error",
        message: `${label}: must declare either 'code' or 'code_template'`,
      });
      entryFailed = true;
    } else {
      if (c.code !== undefined) {
        if (typeof c.code !== "string" || c.code.length === 0 || c.code.length > 12) {
          results.push({
            id: "sep1.currencies.code",
            description: "Currency code format",
            status: "fail",
            severity: "error",
            message: `${label}: code must be a string up to 12 characters (got ${typeof c.code === "string" ? `${c.code.length} chars` : typeof c.code})`,
          });
          entryFailed = true;
        }
      }
      if (c.code_template !== undefined) {
        if (
          typeof c.code_template !== "string" ||
          c.code_template.length === 0 ||
          c.code_template.length > 12
        ) {
          results.push({
            id: "sep1.currencies.code_template",
            description: "Currency code_template format",
            status: "fail",
            severity: "error",
            message: `${label}: code_template must be a string up to 12 characters`,
          });
          entryFailed = true;
        } else if (!c.code_template.includes("?")) {
          results.push({
            id: "sep1.currencies.code_template",
            description: "Currency code_template format",
            status: "fail",
            severity: "error",
            message: `${label}: code_template must include '?' pattern`,
          });
          entryFailed = true;
        }
      }
    }

    const isNative = c.code === "native";

    // 2. issuer / contract
    if (isNative && c.issuer !== undefined) {
      results.push({
        id: "sep1.currencies.native_issuer",
        description: "Native asset should not declare issuer",
        status: "warn",
        severity: "warning",
        message: `${label}: native asset (XLM) has no issuer; declaring 'issuer' is redundant`,
      });
    }

    if (c.issuer !== undefined) {
      if (typeof c.issuer !== "string" || !StrKey.isValidEd25519PublicKey(c.issuer)) {
        results.push({
          id: "sep1.currencies.issuer",
          description: "Currency issuer format",
          status: "fail",
          severity: "error",
          message: `${label}: issuer "${String(c.issuer)}" is not a valid Stellar ed25519 public key`,
        });
        entryFailed = true;
      }
    }

    if (c.contract !== undefined) {
      if (typeof c.contract !== "string" || !StrKey.isValidContract(c.contract)) {
        results.push({
          id: "sep1.currencies.contract",
          description: "Currency contract format",
          status: "fail",
          severity: "error",
          message: `${label}: contract "${String(c.contract)}" is not a valid Stellar contract ID (must start with 'C')`,
        });
        entryFailed = true;
      }
    }

    if (c.code !== undefined && !isNative && !c.contract && !c.issuer) {
      results.push({
        id: "sep1.currencies.issuer_or_contract",
        description: "Currency issuer or contract required for Stellar assets",
        status: "fail",
        severity: "error",
        message: `${label}: must declare 'issuer' for Stellar assets (or 'contract' for Soroban/non-Stellar assets)`,
      });
      entryFailed = true;
    }

    // 3. status enum
    if (c.status !== undefined) {
      if (typeof c.status !== "string" || !VALID_STATUSES.has(c.status)) {
        results.push({
          id: "sep1.currencies.status",
          description: "Currency status enum",
          status: "fail",
          severity: "error",
          message: `${label}: status must be one of live, dead, test, private (got "${String(c.status)}")`,
        });
        entryFailed = true;
      }
    }

    // 4. display_decimals
    if (c.display_decimals !== undefined) {
      if (
        typeof c.display_decimals !== "number" ||
        !Number.isInteger(c.display_decimals) ||
        c.display_decimals < 0 ||
        c.display_decimals > 7
      ) {
        results.push({
          id: "sep1.currencies.display_decimals",
          description: "Currency display_decimals range",
          status: "fail",
          severity: "error",
          message: `${label}: display_decimals must be an integer between 0 and 7 (got ${String(c.display_decimals)})`,
        });
        entryFailed = true;
      }
    }

    // 5. name length (advisory -> warn)
    if (c.name !== undefined) {
      if (typeof c.name !== "string" || c.name.length > 20) {
        results.push({
          id: "sep1.currencies.name",
          description: "Currency name recommended length",
          status: "warn",
          severity: "warning",
          message: `${label}: name exceeds recommended maximum of 20 characters (got ${typeof c.name === "string" ? `${c.name.length} chars` : typeof c.name})`,
        });
      }
    }

    // 6. anchor_asset_type enum
    if (c.anchor_asset_type !== undefined) {
      if (
        typeof c.anchor_asset_type !== "string" ||
        !VALID_ANCHOR_ASSET_TYPES.has(c.anchor_asset_type)
      ) {
        results.push({
          id: "sep1.currencies.anchor_asset_type",
          description: "Currency anchor_asset_type enum",
          status: "fail",
          severity: "error",
          message: `${label}: anchor_asset_type must be one of fiat, crypto, nft, stock, bond, commodity, realestate, other (got "${String(c.anchor_asset_type)}")`,
        });
        entryFailed = true;
      }
    }

    // 7. fixed_number / max_number / is_unlimited mutual exclusivity
    const supplyFieldsCount = [
      c.fixed_number,
      c.max_number,
      c.is_unlimited,
    ].filter((val) => val !== undefined).length;

    if (supplyFieldsCount > 1) {
      results.push({
        id: "sep1.currencies.supply_mutual_exclusivity",
        description: "Supply fields mutual exclusivity",
        status: "fail",
        severity: "error",
        message: `${label}: fixed_number, max_number, and is_unlimited are mutually exclusive`,
      });
      entryFailed = true;
    }

    // 8. is_asset_anchored and regulated booleans
    if (c.is_asset_anchored !== undefined && typeof c.is_asset_anchored !== "boolean") {
      results.push({
        id: "sep1.currencies.is_asset_anchored",
        description: "Currency is_asset_anchored boolean",
        status: "fail",
        severity: "error",
        message: `${label}: is_asset_anchored must be a boolean (got ${typeof c.is_asset_anchored})`,
      });
      entryFailed = true;
    }

    if (c.regulated !== undefined && typeof c.regulated !== "boolean") {
      results.push({
        id: "sep1.currencies.regulated",
        description: "Currency regulated boolean",
        status: "fail",
        severity: "error",
        message: `${label}: regulated must be a boolean (got ${typeof c.regulated})`,
      });
      entryFailed = true;
    }

    // 9. approval_server (required if regulated = true, must be HTTPS)
    if (c.regulated === true && !c.approval_server) {
      results.push({
        id: "sep1.currencies.approval_server",
        description: "Regulated currency approval_server",
        status: "fail",
        severity: "error",
        message: `${label}: approval_server is required when regulated is true (per SEP-8)`,
      });
      entryFailed = true;
    } else if (c.approval_server !== undefined) {
      try {
        const u = new URL(String(c.approval_server));
        if (u.protocol !== "https:") {
          results.push({
            id: "sep1.currencies.approval_server",
            description: "Regulated currency approval_server",
            status: "fail",
            severity: "error",
            message: `${label}: approval_server "${String(c.approval_server)}" must use the https: scheme`,
          });
          entryFailed = true;
        }
      } catch {
        results.push({
          id: "sep1.currencies.approval_server",
          description: "Regulated currency approval_server",
          status: "fail",
          severity: "error",
          message: `${label}: approval_server "${String(c.approval_server)}" is not a valid absolute URL`,
        });
        entryFailed = true;
      }
    }

    // 10. URL fields: attestation_of_reserve, image, toml
    const urlFields = [
      { key: "attestation_of_reserve", val: c.attestation_of_reserve },
      { key: "image", val: c.image },
      { key: "toml", val: c.toml },
    ] as const;

    urlFields.forEach(({ key, val }) => {
      if (val !== undefined) {
        try {
          const u = new URL(String(val));
          if (u.protocol !== "https:" && u.protocol !== "http:") {
            results.push({
              id: `sep1.currencies.${key}`,
              description: `Currency ${key} URL format`,
              status: "fail",
              severity: "error",
              message: `${label}: ${key} "${String(val)}" must use http: or https: scheme`,
            });
            entryFailed = true;
          }
        } catch {
          results.push({
            id: `sep1.currencies.${key}`,
            description: `Currency ${key} URL format`,
            status: "fail",
            severity: "error",
            message: `${label}: ${key} "${String(val)}" is not a valid absolute URL`,
          });
          entryFailed = true;
        }
      }
    });

    // 11. collateral_address_signatures matching collateral_addresses
    if (
      c.collateral_address_signatures !== undefined &&
      c.collateral_addresses !== undefined
    ) {
      const sigsLen = Array.isArray(c.collateral_address_signatures)
        ? c.collateral_address_signatures.length
        : -1;
      const addrsLen = Array.isArray(c.collateral_addresses)
        ? c.collateral_addresses.length
        : -1;

      if (sigsLen !== addrsLen || sigsLen === -1) {
        results.push({
          id: "sep1.currencies.collateral_signatures",
          description: "Collateral address signatures count",
          status: "fail",
          severity: "error",
          message: `${label}: collateral_address_signatures length (${sigsLen}) must match collateral_addresses length (${addrsLen})`,
        });
        entryFailed = true;
      }
    }

    if (!entryFailed) {
      results.push({
        id: "sep1.currencies.valid",
        description: "Currency definition is valid",
        status: "pass",
        severity: "error",
        message: `${label} passed currency validations`,
      });
    }
  });

  return currencies;
}
