import { Buffer } from "node:buffer";
import { Networks, StrKey } from "@stellar/stellar-sdk";
import { parse } from "smol-toml";
import { fetchWithTimeout } from "../core/http.js";
import type { CheckResult } from "../core/report.js";
import { validateCurrencies, type Currency } from "./sep1-currencies.js";

export type { Currency };
export { validateCurrencies };

export interface Documentation {
  orgName?: string;
  orgDBA?: string;
  orgUrl?: string;
  orgLogo?: string;
  orgDescription?: string;
  orgPhysicalAddress?: string;
  orgPhysicalAddressAttestation?: string;
  orgPhoneNumber?: string;
  orgPhoneNumberAttestation?: string;
  orgKeybase?: string;
  orgTwitter?: string;
  orgGithub?: string;
  orgOfficialEmail?: string;
  orgSupportEmail?: string;
  orgLicensingAuthority?: string;
  orgLicenseType?: string;
  orgLicenseNumber?: string;
  [key: string]: unknown;
}

export interface StellarToml {
  raw: Record<string, unknown>;
  version?: string;
  webAuthEndpoint?: string;
  signingKey?: string;
  networkPassphrase?: string;
  anchorQuoteServer?: string;
  kycServer?: string;
  transferServer?: string;
  transferServerSep24?: string;
  directPaymentServer?: string;
  jwksUri?: string;
  accounts?: string[];
  currencies?: Currency[];
  documentation?: Documentation;
}

export function validateHttpsUrl(
  fieldName: string,
  value: unknown,
  results: CheckResult[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const checkId = `sep1.url.${fieldName.toLowerCase()}`;
  const description = `${fieldName} must be a valid absolute HTTPS URL`;

  if (typeof value !== "string" || value.trim() === "") {
    results.push({
      id: checkId,
      description,
      status: "fail",
      severity: "error",
      message: `${fieldName} must be a non-empty string URL, got ${typeof value}`,
    });
    return undefined;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") {
      results.push({
        id: checkId,
        description,
        status: "fail",
        severity: "error",
        message: `${fieldName} URL "${value}" must use the https: scheme (got ${parsed.protocol})`,
      });
      return undefined;
    }

    results.push({
      id: checkId,
      description,
      status: "pass",
      severity: "error",
      message: `${fieldName} is a valid HTTPS URL: ${value}`,
    });
    return value;
  } catch {
    results.push({
      id: checkId,
      description,
      status: "fail",
      severity: "error",
      message: `${fieldName} "${value}" is not a valid absolute URL`,
    });
    return undefined;
  }
}

export async function fetchStellarToml(
  domain: string,
  timeoutMs?: number,
  network: "testnet" | "mainnet" = "testnet",
): Promise<{ toml: StellarToml; results: CheckResult[] }> {
  const results: CheckResult[] = [];
  const url = `https://${domain}/.well-known/stellar.toml`;

  let text: string;
  try {
    const res = await fetchWithTimeout(url, {}, timeoutMs);
    const requestedHost = new URL(url).host;
    let redirectedHost: string | undefined;
    try {
      if (res.url && new URL(res.url).host !== requestedHost) {
        redirectedHost = new URL(res.url).host;
      }
    } catch {}

    const redirectInfo = redirectedHost ? ` (redirected to ${res.url})` : "";

    if (!res.ok) {
      results.push({
        id: "sep1.fetch",
        description: "Fetch stellar.toml from /.well-known/stellar.toml",
        status: "fail",
        severity: "error",
        message: `Received HTTP ${res.status} fetching ${url}${redirectInfo}`,
      });
      return { toml: { raw: {} }, results };
    }

    results.push({
      id: "sep1.fetch",
      description: "Fetch stellar.toml from /.well-known/stellar.toml",
      status: "pass",
      severity: "error",
      message: `Fetched ${url}${redirectInfo}`,
    });

    // CORS check: Access-Control-Allow-Origin: * (required by SEP-1)
    const cors = res.headers?.get?.("access-control-allow-origin");
    if (cors === "*") {
      results.push({
        id: "sep1.cors_header",
        description: "stellar.toml is served with Access-Control-Allow-Origin: *",
        status: "pass",
        severity: "error",
        message: "Access-Control-Allow-Origin is set to *",
      });
    } else {
      results.push({
        id: "sep1.cors_header",
        description: "stellar.toml is served with Access-Control-Allow-Origin: *",
        status: "fail",
        severity: "error",
        message: cors
          ? `Access-Control-Allow-Origin is "${cors}", expected "*"`
          : "Access-Control-Allow-Origin header is missing (required by SEP-1 for browser access)",
      });
    }

    // Content-Type check: text/plain (recommended by SEP-1)
    const contentType = res.headers?.get?.("content-type");
    const mime = contentType ? contentType.toLowerCase().split(";")[0].trim() : "";
    if (mime === "text/plain") {
      results.push({
        id: "sep1.content_type",
        description: "stellar.toml is served with Content-Type: text/plain",
        status: "pass",
        severity: "warning",
        message: `Content-Type is "${contentType}"`,
      });
    } else {
      results.push({
        id: "sep1.content_type",
        description: "stellar.toml is served with Content-Type: text/plain",
        status: "warn",
        severity: "warning",
        message: contentType
          ? `Content-Type is "${contentType}", recommended is "text/plain"`
          : 'Content-Type header is missing, recommended is "text/plain"',
      });
    }

    text = await res.text();

    // File size check: max 100KB (102400 bytes)
    const byteLength = Buffer.byteLength(text, "utf-8");
    const MAX_BYTES = 100 * 1024;
    if (byteLength <= MAX_BYTES) {
      results.push({
        id: "sep1.file_size",
        description: "stellar.toml size is within 100KB limit",
        status: "pass",
        severity: "error",
        message: `stellar.toml size is ${byteLength} bytes (within 100KB limit)`,
      });
    } else {
      results.push({
        id: "sep1.file_size",
        description: "stellar.toml size is within 100KB limit",
        status: "fail",
        severity: "error",
        message: `stellar.toml size of ${byteLength} bytes exceeds the 100KB limit (${MAX_BYTES} bytes)`,
      });
    }
  } catch (err) {
    results.push({
      id: "sep1.fetch",
      description: "Fetch stellar.toml from /.well-known/stellar.toml",
      status: "fail",
      severity: "error",
      message: (err as Error).message,
    });
    return { toml: { raw: {} }, results };
  }

  const parsed = parseStellarToml(text, network, domain);
  results.push(...parsed.results);
  return { toml: parsed.toml, results };
}

export function parseStellarToml(
  text: string,
  network: "testnet" | "mainnet" = "testnet",
  domain?: string,
): {
  toml: StellarToml;
  results: CheckResult[];
} {
  const results: CheckResult[] = [];
  const isHtml =
    /^\s*<!DOCTYPE\s+html/i.test(text) ||
    /^\s*<html/i.test(text) ||
    /<html[\s>]/i.test(text) ||
    /<\/html>/i.test(text);

  let raw: Record<string, unknown>;
  try {
    raw = parse(text) as Record<string, unknown>;
  } catch (err) {
    results.push({
      id: "sep1.parse",
      description: "Parse stellar.toml as valid TOML",
      status: "fail",
      severity: "error",
      message: isHtml
        ? "Endpoint served HTML instead of a valid stellar.toml file"
        : `TOML parse error: ${(err as Error).message}`,
    });
    return { toml: { raw: {} }, results };
  }

  results.push({
    id: "sep1.parse",
    description: "Parse stellar.toml as valid TOML",
    status: "pass",
    severity: "error",
    message: "stellar.toml parsed successfully",
  });

  // Validate VERSION
  const version = typeof raw.VERSION === "string" ? raw.VERSION : undefined;
  results.push(
    version
      ? {
          id: "sep1.version",
          description: "stellar.toml declares VERSION",
          status: "pass",
          severity: "error",
          message: `VERSION = ${version}`,
        }
      : {
          id: "sep1.version",
          description: "stellar.toml declares VERSION",
          status: "fail",
          severity: "error",
          message:
            raw.VERSION !== undefined
              ? `VERSION "${String(raw.VERSION)}" is not a string`
              : "VERSION is missing from stellar.toml (required by SEP-1)",
        },
  );

  // Validate WEB_AUTH_ENDPOINT
  const webAuthEndpoint = validateHttpsUrl(
    "WEB_AUTH_ENDPOINT",
    raw.WEB_AUTH_ENDPOINT,
    results,
  );

  results.push(
    webAuthEndpoint
      ? {
          id: "sep1.web_auth_endpoint",
          description: "stellar.toml declares WEB_AUTH_ENDPOINT",
          status: "pass",
          severity: "error",
          message: `WEB_AUTH_ENDPOINT = ${webAuthEndpoint}`,
        }
      : {
          id: "sep1.web_auth_endpoint",
          description: "stellar.toml declares WEB_AUTH_ENDPOINT",
          status: "fail",
          severity: "error",
          message:
            raw.WEB_AUTH_ENDPOINT !== undefined
              ? `WEB_AUTH_ENDPOINT "${raw.WEB_AUTH_ENDPOINT}" is not a valid absolute URL`
              : "WEB_AUTH_ENDPOINT is missing or not a string; SEP-10 checks cannot run",
        },
  );

  const signingKey =
    typeof raw.SIGNING_KEY === "string" ? raw.SIGNING_KEY : undefined;
  results.push(
    signingKey
      ? {
          id: "sep1.signing_key",
          description: "stellar.toml declares SIGNING_KEY",
          status: "pass",
          severity: "error",
          message: `SIGNING_KEY = ${signingKey}`,
        }
      : {
          id: "sep1.signing_key",
          description: "stellar.toml declares SIGNING_KEY",
          status: "fail",
          severity: "error",
          message: "SIGNING_KEY is missing or not a string; SEP-10 checks cannot run",
        },
  );

  if (signingKey) {
    if (StrKey.isValidEd25519PublicKey(signingKey)) {
      results.push({
        id: "sep1.signing_key_format",
        description: "SIGNING_KEY is a well-formed Stellar ed25519 public key",
        status: "pass",
        severity: "error",
        message: `SIGNING_KEY is a valid Stellar ed25519 public key: ${signingKey}`,
      });
    } else {
      results.push({
        id: "sep1.signing_key_format",
        description: "SIGNING_KEY is a well-formed Stellar ed25519 public key",
        status: "fail",
        severity: "error",
        message: `SIGNING_KEY "${signingKey}" is not a valid Stellar ed25519 public key (must be a 56-character string starting with 'G')`,
      });
    }
  }

  const networkPassphrase =
    typeof raw.NETWORK_PASSPHRASE === "string" ? raw.NETWORK_PASSPHRASE : undefined;
  results.push(
    networkPassphrase
      ? {
          id: "sep1.network_passphrase",
          description: "stellar.toml declares NETWORK_PASSPHRASE",
          status: "pass",
          severity: "warning",
          message: `NETWORK_PASSPHRASE = ${networkPassphrase}`,
        }
      : {
          id: "sep1.network_passphrase",
          description: "stellar.toml declares NETWORK_PASSPHRASE",
          status: "warn",
          severity: "warning",
          message:
            "NETWORK_PASSPHRASE not declared; assuming the target network's passphrase",
        },
  );

  const expectedPassphrase =
    network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
  const recommendedNetwork = network === "mainnet" ? "testnet" : "mainnet";

  if (networkPassphrase) {
    if (networkPassphrase === expectedPassphrase) {
      results.push({
        id: "sep1.network_passphrase_value",
        description: "NETWORK_PASSPHRASE matches target network",
        status: "pass",
        severity: "error",
        message: `NETWORK_PASSPHRASE matches ${network} (${expectedPassphrase})`,
      });
    } else {
      results.push({
        id: "sep1.network_passphrase_value",
        description: "NETWORK_PASSPHRASE matches target network",
        status: "fail",
        severity: "error",
        message: `NETWORK_PASSPHRASE "${networkPassphrase}" does not match target network ${network} (expected "${expectedPassphrase}"). Try running with --network ${recommendedNetwork}`,
      });
    }
  }

  // Validate optional service endpoints (silent when absent)
  const anchorQuoteServer = validateHttpsUrl(
    "ANCHOR_QUOTE_SERVER",
    raw.ANCHOR_QUOTE_SERVER,
    results,
  );

  const kycServer = validateHttpsUrl(
    "KYC_SERVER",
    raw.KYC_SERVER,
    results,
  );

  const transferServer = validateHttpsUrl(
    "TRANSFER_SERVER",
    raw.TRANSFER_SERVER,
    results,
  );

  const transferServerSep24 = validateHttpsUrl(
    "TRANSFER_SERVER_SEP0024",
    raw.TRANSFER_SERVER_SEP0024,
    results,
  );

  const directPaymentServer = validateHttpsUrl(
    "DIRECT_PAYMENT_SERVER",
    raw.DIRECT_PAYMENT_SERVER,
    results,
  );

  let jwksUri: string | undefined;
  if (raw.JWKS_URI !== undefined) {
    jwksUri = validateHttpsUrl("JWKS_URI", raw.JWKS_URI, results);
  } else if (raw.JWKS_ENDPOINT !== undefined) {
    jwksUri = validateHttpsUrl("JWKS_ENDPOINT", raw.JWKS_ENDPOINT, results);
  } else if (raw.JWKS !== undefined) {
    jwksUri = validateHttpsUrl("JWKS", raw.JWKS, results);
  }

  // Extract and validate ACCOUNTS if declared
  let accounts: string[] | undefined;
  if (raw.ACCOUNTS !== undefined) {
    if (Array.isArray(raw.ACCOUNTS)) {
      accounts = [];
      const invalidEntries: { index: number; value: unknown }[] = [];
      raw.ACCOUNTS.forEach((entry, idx) => {
        if (typeof entry === "string" && StrKey.isValidEd25519PublicKey(entry)) {
          accounts!.push(entry);
        } else {
          invalidEntries.push({ index: idx, value: entry });
        }
      });

      if (invalidEntries.length === 0) {
        results.push({
          id: "sep1.accounts",
          description: "ACCOUNTS entries are valid Stellar ed25519 public keys",
          status: "pass",
          severity: "error",
          message: `All ${raw.ACCOUNTS.length} ACCOUNTS are valid Stellar ed25519 public keys`,
        });
      } else {
        const errorDetails = invalidEntries
          .map((i) => `index ${i.index}: "${String(i.value)}"`)
          .join(", ");
        results.push({
          id: "sep1.accounts",
          description: "ACCOUNTS entries are valid Stellar ed25519 public keys",
          status: "fail",
          severity: "error",
          message: `ACCOUNTS contains invalid Stellar ed25519 public key(s) at ${errorDetails}`,
        });
      }
    } else {
      results.push({
        id: "sep1.accounts",
        description: "ACCOUNTS entries are valid Stellar ed25519 public keys",
        status: "fail",
        severity: "error",
        message: `ACCOUNTS must be an array of public key strings, got ${typeof raw.ACCOUNTS}`,
      });
    }
  }

  // Extract and validate [[CURRENCIES]] if declared
  const currencies = validateCurrencies(raw.CURRENCIES, results);

  // Extract and validate [DOCUMENTATION] if declared
  const documentation = validateDocumentation(raw.DOCUMENTATION, domain, results);

  return {
    toml: {
      raw,
      version,
      webAuthEndpoint,
      signingKey,
      networkPassphrase,
      anchorQuoteServer,
      kycServer,
      transferServer,
      transferServerSep24,
      directPaymentServer,
      jwksUri,
      accounts,
      currencies,
      documentation,
    },
    results,
  };
}

export function validateDocumentation(
  rawDoc: unknown,
  domain: string | undefined,
  results: CheckResult[],
): Documentation | undefined {
  if (rawDoc === undefined || rawDoc === null) {
    return undefined;
  }

  if (typeof rawDoc !== "object" || Array.isArray(rawDoc)) {
    results.push({
      id: "sep1.doc",
      description: "[DOCUMENTATION] section format",
      status: "warn",
      severity: "warning",
      message: `DOCUMENTATION must be a table, got ${typeof rawDoc}`,
    });
    return undefined;
  }

  const doc = rawDoc as Record<string, unknown>;
  const documentation: Documentation = {
    orgName: typeof doc.ORG_NAME === "string" ? doc.ORG_NAME : undefined,
    orgDBA: typeof doc.ORG_DBA === "string" ? doc.ORG_DBA : undefined,
    orgUrl: typeof doc.ORG_URL === "string" ? doc.ORG_URL : undefined,
    orgLogo: typeof doc.ORG_LOGO === "string" ? doc.ORG_LOGO : undefined,
    orgDescription:
      typeof doc.ORG_DESCRIPTION === "string" ? doc.ORG_DESCRIPTION : undefined,
    orgPhysicalAddress:
      typeof doc.ORG_PHYSICAL_ADDRESS === "string" ? doc.ORG_PHYSICAL_ADDRESS : undefined,
    orgPhysicalAddressAttestation:
      typeof doc.ORG_PHYSICAL_ADDRESS_ATTESTATION === "string"
        ? doc.ORG_PHYSICAL_ADDRESS_ATTESTATION
        : undefined,
    orgPhoneNumber:
      typeof doc.ORG_PHONE_NUMBER === "string" ? doc.ORG_PHONE_NUMBER : undefined,
    orgPhoneNumberAttestation:
      typeof doc.ORG_PHONE_NUMBER_ATTESTATION === "string"
        ? doc.ORG_PHONE_NUMBER_ATTESTATION
        : undefined,
    orgKeybase: typeof doc.ORG_KEYBASE === "string" ? doc.ORG_KEYBASE : undefined,
    orgTwitter: typeof doc.ORG_TWITTER === "string" ? doc.ORG_TWITTER : undefined,
    orgGithub: typeof doc.ORG_GITHUB === "string" ? doc.ORG_GITHUB : undefined,
    orgOfficialEmail:
      typeof doc.ORG_OFFICIAL_EMAIL === "string" ? doc.ORG_OFFICIAL_EMAIL : undefined,
    orgSupportEmail:
      typeof doc.ORG_SUPPORT_EMAIL === "string" ? doc.ORG_SUPPORT_EMAIL : undefined,
    orgLicensingAuthority:
      typeof doc.ORG_LICENSING_AUTHORITY === "string"
        ? doc.ORG_LICENSING_AUTHORITY
        : undefined,
    orgLicenseType:
      typeof doc.ORG_LICENSE_TYPE === "string" ? doc.ORG_LICENSE_TYPE : undefined,
    orgLicenseNumber:
      typeof doc.ORG_LICENSE_NUMBER === "string" ? doc.ORG_LICENSE_NUMBER : undefined,
    ...doc,
  };

  let orgHost: string | undefined;

  // 1. ORG_URL: HTTPS URL; must be the domain hosting this stellar.toml
  if (doc.ORG_URL !== undefined) {
    if (typeof doc.ORG_URL !== "string") {
      results.push({
        id: "sep1.doc.org_url",
        description: "ORG_URL must be a valid HTTPS URL",
        status: "warn",
        severity: "warning",
        message: `ORG_URL must be a string URL, got ${typeof doc.ORG_URL}`,
      });
    } else {
      try {
        const u = new URL(doc.ORG_URL);
        if (u.protocol !== "https:") {
          results.push({
            id: "sep1.doc.org_url",
            description: "ORG_URL must use the https: scheme",
            status: "warn",
            severity: "warning",
            message: `ORG_URL "${doc.ORG_URL}" must use the https: scheme`,
          });
        } else {
          orgHost = u.host.toLowerCase();
          if (
            domain &&
            orgHost !== domain.toLowerCase() &&
            !orgHost.endsWith("." + domain.toLowerCase()) &&
            !domain.toLowerCase().endsWith("." + orgHost)
          ) {
            results.push({
              id: "sep1.doc.org_url",
              description: "ORG_URL matches hosting domain",
              status: "warn",
              severity: "warning",
              message: `ORG_URL host "${orgHost}" does not match hosting domain "${domain}"`,
            });
          } else {
            results.push({
              id: "sep1.doc.org_url",
              description: "ORG_URL is valid HTTPS URL matching domain",
              status: "pass",
              severity: "warning",
              message: `ORG_URL is a valid HTTPS URL: ${doc.ORG_URL}`,
            });
          }
        }
      } catch {
        results.push({
          id: "sep1.doc.org_url",
          description: "ORG_URL must be a valid absolute HTTPS URL",
          status: "warn",
          severity: "warning",
          message: `ORG_URL "${doc.ORG_URL}" is not a valid absolute URL`,
        });
      }
    }
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // 2. ORG_OFFICIAL_EMAIL: must use the ORG_URL domain
  if (doc.ORG_OFFICIAL_EMAIL !== undefined) {
    if (
      typeof doc.ORG_OFFICIAL_EMAIL !== "string" ||
      !emailRegex.test(doc.ORG_OFFICIAL_EMAIL)
    ) {
      results.push({
        id: "sep1.doc.org_official_email",
        description: "ORG_OFFICIAL_EMAIL format and domain",
        status: "warn",
        severity: "warning",
        message: `ORG_OFFICIAL_EMAIL "${String(doc.ORG_OFFICIAL_EMAIL)}" is not a well-formed email address`,
      });
    } else {
      const emailDomain = doc.ORG_OFFICIAL_EMAIL.split("@")[1].toLowerCase();
      const targetDomain = orgHost ?? (domain ? domain.toLowerCase() : undefined);
      if (
        targetDomain &&
        emailDomain !== targetDomain &&
        !emailDomain.endsWith("." + targetDomain) &&
        !targetDomain.endsWith("." + emailDomain)
      ) {
        results.push({
          id: "sep1.doc.org_official_email",
          description: "ORG_OFFICIAL_EMAIL format and domain",
          status: "warn",
          severity: "warning",
          message: `ORG_OFFICIAL_EMAIL domain "${emailDomain}" does not match ORG_URL domain "${targetDomain}"`,
        });
      } else {
        results.push({
          id: "sep1.doc.org_official_email",
          description: "ORG_OFFICIAL_EMAIL format and domain",
          status: "pass",
          severity: "warning",
          message: `ORG_OFFICIAL_EMAIL is valid: ${doc.ORG_OFFICIAL_EMAIL}`,
        });
      }
    }
  }

  // 3. ORG_PHYSICAL_ADDRESS_ATTESTATION & ORG_PHONE_NUMBER_ATTESTATION: HTTPS on ORG_URL domain
  const attestationFields = [
    {
      key: "ORG_PHYSICAL_ADDRESS_ATTESTATION",
      id: "sep1.doc.org_physical_address_attestation",
    },
    {
      key: "ORG_PHONE_NUMBER_ATTESTATION",
      id: "sep1.doc.org_phone_number_attestation",
    },
  ] as const;

  for (const { key, id } of attestationFields) {
    const val = doc[key];
    if (val !== undefined) {
      if (typeof val !== "string") {
        results.push({
          id,
          description: `${key} HTTPS URL on ORG_URL domain`,
          status: "warn",
          severity: "warning",
          message: `${key} must be a string URL, got ${typeof val}`,
        });
      } else {
        try {
          const u = new URL(val);
          if (u.protocol !== "https:") {
            results.push({
              id,
              description: `${key} HTTPS URL on ORG_URL domain`,
              status: "warn",
              severity: "warning",
              message: `${key} "${val}" must use the https: scheme`,
            });
          } else {
            const host = u.host.toLowerCase();
            const targetDomain = orgHost ?? (domain ? domain.toLowerCase() : undefined);
            if (
              targetDomain &&
              host !== targetDomain &&
              !host.endsWith("." + targetDomain)
            ) {
              results.push({
                id,
                description: `${key} HTTPS URL on ORG_URL domain`,
                status: "warn",
                severity: "warning",
                message: `${key} host "${host}" is not on the ORG_URL domain "${targetDomain}"`,
              });
            } else {
              results.push({
                id,
                description: `${key} HTTPS URL on ORG_URL domain`,
                status: "pass",
                severity: "warning",
                message: `${key} is valid on domain: ${val}`,
              });
            }
          }
        } catch {
          results.push({
            id,
            description: `${key} HTTPS URL on ORG_URL domain`,
            status: "warn",
            severity: "warning",
            message: `${key} "${val}" is not a valid absolute URL`,
          });
        }
      }
    }
  }

  // 4. ORG_PHONE_NUMBER: E.164 format (^\+[1-9]\d{1,14}$)
  if (doc.ORG_PHONE_NUMBER !== undefined) {
    const e164Regex = /^\+[1-9]\d{1,14}$/;
    if (
      typeof doc.ORG_PHONE_NUMBER !== "string" ||
      !e164Regex.test(doc.ORG_PHONE_NUMBER)
    ) {
      results.push({
        id: "sep1.doc.org_phone_number",
        description: "ORG_PHONE_NUMBER E.164 format",
        status: "warn",
        severity: "warning",
        message: `ORG_PHONE_NUMBER "${String(doc.ORG_PHONE_NUMBER)}" must be in E.164 format (e.g. +14155552671)`,
      });
    } else {
      results.push({
        id: "sep1.doc.org_phone_number",
        description: "ORG_PHONE_NUMBER E.164 format",
        status: "pass",
        severity: "warning",
        message: `ORG_PHONE_NUMBER is valid E.164: ${doc.ORG_PHONE_NUMBER}`,
      });
    }
  }

  // 5. ORG_LOGO: parseable HTTPS URL (offline)
  if (doc.ORG_LOGO !== undefined) {
    if (typeof doc.ORG_LOGO !== "string") {
      results.push({
        id: "sep1.doc.org_logo",
        description: "ORG_LOGO HTTPS URL",
        status: "warn",
        severity: "warning",
        message: `ORG_LOGO must be a string URL, got ${typeof doc.ORG_LOGO}`,
      });
    } else {
      try {
        const u = new URL(doc.ORG_LOGO);
        if (u.protocol !== "https:") {
          results.push({
            id: "sep1.doc.org_logo",
            description: "ORG_LOGO HTTPS URL",
            status: "warn",
            severity: "warning",
            message: `ORG_LOGO "${doc.ORG_LOGO}" must use the https: scheme`,
          });
        } else {
          results.push({
            id: "sep1.doc.org_logo",
            description: "ORG_LOGO HTTPS URL",
            status: "pass",
            severity: "warning",
            message: `ORG_LOGO is a valid HTTPS URL: ${doc.ORG_LOGO}`,
          });
        }
      } catch {
        results.push({
          id: "sep1.doc.org_logo",
          description: "ORG_LOGO HTTPS URL",
          status: "warn",
          severity: "warning",
          message: `ORG_LOGO "${doc.ORG_LOGO}" is not a valid absolute URL`,
        });
      }
    }
  }

  // 6. ORG_SUPPORT_EMAIL: well-formed email
  if (doc.ORG_SUPPORT_EMAIL !== undefined) {
    if (
      typeof doc.ORG_SUPPORT_EMAIL !== "string" ||
      !emailRegex.test(doc.ORG_SUPPORT_EMAIL)
    ) {
      results.push({
        id: "sep1.doc.org_support_email",
        description: "ORG_SUPPORT_EMAIL format",
        status: "warn",
        severity: "warning",
        message: `ORG_SUPPORT_EMAIL "${String(doc.ORG_SUPPORT_EMAIL)}" is not a valid email address`,
      });
    } else {
      results.push({
        id: "sep1.doc.org_support_email",
        description: "ORG_SUPPORT_EMAIL format",
        status: "pass",
        severity: "warning",
        message: `ORG_SUPPORT_EMAIL is valid: ${doc.ORG_SUPPORT_EMAIL}`,
      });
    }
  }

  return documentation;
}
