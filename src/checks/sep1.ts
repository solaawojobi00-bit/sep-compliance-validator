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
  jwksUri?: string;
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

  let validWebAuthUrl: string | undefined;
  if (typeof raw.WEB_AUTH_ENDPOINT === "string") {
    try {
      const parsed = new URL(raw.WEB_AUTH_ENDPOINT);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        validWebAuthUrl = raw.WEB_AUTH_ENDPOINT;
      }
    } catch {
      // Invalid URL
    }
  }

  if (validWebAuthUrl) {
    results.push({
      id: "sep1.web_auth_endpoint",
      description: "stellar.toml declares WEB_AUTH_ENDPOINT",
      status: "pass",
      severity: "error",
      message: `WEB_AUTH_ENDPOINT = ${validWebAuthUrl}`,
    });
  } else if (raw.WEB_AUTH_ENDPOINT !== undefined) {
    results.push({
      id: "sep1.web_auth_endpoint",
      description: "stellar.toml declares WEB_AUTH_ENDPOINT",
      status: "fail",
      severity: "error",
      message: `WEB_AUTH_ENDPOINT "${raw.WEB_AUTH_ENDPOINT}" is not a valid absolute URL`,
    });
  } else {
    results.push({
      id: "sep1.web_auth_endpoint",
      description: "stellar.toml declares WEB_AUTH_ENDPOINT",
      status: "fail",
      severity: "error",
      message:
        "WEB_AUTH_ENDPOINT is missing or not a string; SEP-10 checks cannot run",
    });
  }

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

  const anchorQuoteServer =
    typeof raw.ANCHOR_QUOTE_SERVER === "string" ? raw.ANCHOR_QUOTE_SERVER : undefined;

  const kycServer =
    typeof raw.KYC_SERVER === "string" ? raw.KYC_SERVER : undefined;

  const transferServer =
    typeof raw.TRANSFER_SERVER === "string" ? raw.TRANSFER_SERVER : undefined;

  const transferServerSep24 =
    typeof raw.TRANSFER_SERVER_SEP0024 === "string"
      ? raw.TRANSFER_SERVER_SEP0024
      : undefined;

  const jwksUri =
    typeof raw.JWKS_URI === "string"
      ? raw.JWKS_URI
      : typeof raw.JWKS_ENDPOINT === "string"
        ? raw.JWKS_ENDPOINT
        : typeof raw.JWKS === "string"
          ? raw.JWKS
          : undefined;

  return {
    toml: {
      raw,
      webAuthEndpoint: validWebAuthUrl,
      signingKey,
      networkPassphrase,
      anchorQuoteServer,
      kycServer,
      transferServer,
      transferServerSep24,
      jwksUri,
    },
    results,
  };
}
