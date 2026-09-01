import { parse } from "smol-toml";
import { fetchWithTimeout } from "../core/http.js";
import type { CheckResult } from "../core/report.js";

export interface StellarToml {
  raw: Record<string, unknown>;
  webAuthEndpoint?: string;
  signingKey?: string;
  networkPassphrase?: string;
  anchorQuoteServer?: string;
  kycServer?: string;
  transferServer?: string;
  transferServerSep24?: string;
  directPaymentServer?: string;
  jwksUri?: string;
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
): Promise<{ toml: StellarToml; results: CheckResult[] }> {
  const results: CheckResult[] = [];
  const url = `https://${domain}/.well-known/stellar.toml`;

  let text: string;
  try {
    const res = await fetchWithTimeout(url, {}, timeoutMs);
    if (!res.ok) {
      results.push({
        id: "sep1.fetch",
        description: "Fetch stellar.toml from /.well-known/stellar.toml",
        status: "fail",
        severity: "error",
        message: `Received HTTP ${res.status} fetching ${url}`,
      });
      return { toml: { raw: {} }, results };
    }
    text = await res.text();
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

  results.push({
    id: "sep1.fetch",
    description: "Fetch stellar.toml from /.well-known/stellar.toml",
    status: "pass",
    severity: "error",
    message: `Fetched ${url}`,
  });

  const parsed = parseStellarToml(text);
  results.push(...parsed.results);
  return { toml: parsed.toml, results };
}

export function parseStellarToml(text: string): {
  toml: StellarToml;
  results: CheckResult[];
} {
  const results: CheckResult[] = [];
  let raw: Record<string, unknown>;
  try {
    raw = parse(text) as Record<string, unknown>;
  } catch (err) {
    results.push({
      id: "sep1.parse",
      description: "Parse stellar.toml as valid TOML",
      status: "fail",
      severity: "error",
      message: `TOML parse error: ${(err as Error).message}`,
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

  return {
    toml: {
      raw,
      webAuthEndpoint,
      signingKey,
      networkPassphrase,
      anchorQuoteServer,
      kycServer,
      transferServer,
      transferServerSep24,
      directPaymentServer,
      jwksUri,
    },
    results,
  };
}
