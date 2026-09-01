import { Buffer } from "node:buffer";
import { Keypair, Networks, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import { createLocalJWKSet, jwtVerify } from "jose";
import { fetchWithTimeout } from "../core/http.js";
import type { CheckResult } from "../core/report.js";
import type { StellarToml } from "./sep1.js";

export const MAX_CHALLENGE_TIMEOUT_SECONDS = 900; // 15 minutes

export interface Sep10Options {
  domain: string;
  toml: StellarToml;
  network: "testnet" | "mainnet";
  clientDomain?: string;
  clientSigningKey?: string;
  clientDomainKeypair?: Keypair;
  jwksUri?: string;
  timeoutMs?: number;
  onJwt?: (jwt: string) => void;
}

export interface Sep10Result extends Array<CheckResult> {
  jwt?: string;
}

function decodeJwtHeader(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    throw new Error(`JWT does not have 3 parts (got ${parts.length})`);
  }
  const headerJson = Buffer.from(parts[0], "base64url").toString("utf-8");
  return JSON.parse(headerJson) as Record<string, unknown>;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    throw new Error(`JWT does not have 3 parts (got ${parts.length})`);
  }
  const payloadJson = Buffer.from(parts[1], "base64url").toString("utf-8");
  return JSON.parse(payloadJson) as Record<string, unknown>;
}

export async function runSep10Checks(opts: Sep10Options): Promise<Sep10Result> {
  const results: Sep10Result = [];
  const { domain, toml } = opts;
  const networkPassphrase =
    opts.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

  if (!toml.webAuthEndpoint || !toml.signingKey) {
    results.push({
      id: "sep10.skipped",
      description: "Run SEP-10 challenge/response flow",
      status: "warn",
      severity: "error",
      message: "Skipped: WEB_AUTH_ENDPOINT or SIGNING_KEY missing from stellar.toml",
    });
    return results;
  }

  const webAuthEndpoint = toml.webAuthEndpoint;
  const signingKey = toml.signingKey;
  let webAuthDomain: string;
  try {
    webAuthDomain = new URL(webAuthEndpoint).host;
  } catch (err) {
    results.push({
      id: "sep10.web_auth_endpoint",
      description: "WEB_AUTH_ENDPOINT is a valid URL",
      status: "fail",
      severity: "error",
      message: `Invalid WEB_AUTH_ENDPOINT "${webAuthEndpoint}": ${(err as Error).message}`,
    });
    return results;
  }
  const clientKeypair = Keypair.random();

  // 1. Request a challenge transaction.
  let challengeXdr: string;
  let responseNetworkPassphrase: string | undefined;
  try {
    const url = new URL(webAuthEndpoint);
    url.searchParams.set("account", clientKeypair.publicKey());
    url.searchParams.set("home_domain", domain);
    if (opts.clientDomain) {
      url.searchParams.set("client_domain", opts.clientDomain);
    }
    const res = await fetchWithTimeout(url.toString(), {}, opts.timeoutMs);
    if (!res.ok) {
      results.push({
        id: "sep10.challenge_request",
        description: "Request SEP-10 challenge transaction",
        status: "fail",
        severity: "error",
        message: `GET ${url.toString()} returned HTTP ${res.status}`,
      });
      return results;
    }
    const body = (await res.json()) as {
      transaction?: string;
      network_passphrase?: string;
    };
    if (!body.transaction) {
      results.push({
        id: "sep10.challenge_request",
        description: "Request SEP-10 challenge transaction",
        status: "fail",
        severity: "error",
        message: 'Response JSON is missing the "transaction" field',
      });
      return results;
    }
    challengeXdr = body.transaction;
    responseNetworkPassphrase = body.network_passphrase;
    results.push({
      id: "sep10.challenge_request",
      description: "Request SEP-10 challenge transaction",
      status: "pass",
      severity: "error",
      message: `Received challenge transaction from ${webAuthEndpoint}`,
    });
  } catch (err) {
    results.push({
      id: "sep10.challenge_request",
      description: "Request SEP-10 challenge transaction",
      status: "fail",
      severity: "error",
      message: (err as Error).message,
    });
    return results;
  }

  // 2. The response's declared network_passphrase must match the network we're testing.
  if (responseNetworkPassphrase && responseNetworkPassphrase !== networkPassphrase) {
    results.push({
      id: "sep10.network_passphrase_match",
      description: "Challenge response network_passphrase matches expected network",
      status: "fail",
      severity: "error",
      message: `Expected "${networkPassphrase}", got "${responseNetworkPassphrase}"`,
    });
  } else {
    results.push({
      id: "sep10.network_passphrase_match",
      description: "Challenge response network_passphrase matches expected network",
      status: "pass",
      severity: "error",
      message: `network_passphrase = ${responseNetworkPassphrase ?? networkPassphrase}`,
    });
  }

  // 3. Validate the challenge transaction's structure via the SDK (sequence
  // number zero, correct source account, Manage Data operations, timebounds,
  // home domain, and that it's signed by the anchor's SIGNING_KEY).
  let parsedClientAccountId: string;
  let parsedChallengeTx: any;
  try {
    const { tx: readTx, clientAccountID } = WebAuth.readChallengeTx(
      challengeXdr,
      signingKey,
      networkPassphrase,
      [domain],
      webAuthDomain,
    );
    parsedClientAccountId = clientAccountID;
    parsedChallengeTx = readTx;
    results.push({
      id: "sep10.challenge_structure",
      description:
        "Challenge transaction has valid SEP-10 structure (sequence 0, source account, operations, timebounds, home domain, signed by SIGNING_KEY)",
      status: "pass",
      severity: "error",
      message: `Valid challenge for client account ${clientAccountID}`,
    });
  } catch (err) {
    results.push({
      id: "sep10.challenge_structure",
      description: "Challenge transaction has valid SEP-10 structure",
      status: "fail",
      severity: "error",
      message: (err as Error).message,
    });
    return results;
  }

  results.push(
    parsedClientAccountId === clientKeypair.publicKey()
      ? {
          id: "sep10.challenge_client_account",
          description: "Challenge transaction source account matches requested client account",
          status: "pass",
          severity: "error",
          message: "Client account matches",
        }
      : {
          id: "sep10.challenge_client_account",
          description: "Challenge transaction source account matches requested client account",
          status: "fail",
          severity: "error",
          message: `Expected ${clientKeypair.publicKey()}, got ${parsedClientAccountId}`,
        },
  );

  const timeBounds = parsedChallengeTx?.timeBounds;
  if (!timeBounds || !timeBounds.minTime || !timeBounds.maxTime) {
    results.push({
      id: "sep10.challenge_timebounds_reasonable",
      description: "Challenge transaction validity window is within recommended limit",
      status: "fail",
      severity: "error",
      message: "Challenge transaction is missing timebounds",
    });
  } else {
    const minTime = Number(timeBounds.minTime);
    const maxTime = Number(timeBounds.maxTime);
    const windowSeconds = maxTime - minTime;

    if (maxTime === 0 || windowSeconds > MAX_CHALLENGE_TIMEOUT_SECONDS || windowSeconds <= 0) {
      results.push({
        id: "sep10.challenge_timebounds_reasonable",
        description: "Challenge transaction validity window is within recommended limit",
        status: "fail",
        severity: "error",
        message: `Challenge validity window of ${windowSeconds}s exceeds maximum recommended ${MAX_CHALLENGE_TIMEOUT_SECONDS}s (15 minutes)`,
      });
    } else {
      results.push({
        id: "sep10.challenge_timebounds_reasonable",
        description: "Challenge transaction validity window is within recommended limit",
        status: "pass",
        severity: "error",
        message: `Challenge validity window is ${windowSeconds}s (within ${MAX_CHALLENGE_TIMEOUT_SECONDS}s limit)`,
      });
    }
  }

  if (opts.clientDomain) {
    const clientDomainOp = (
      parsedChallengeTx?.operations as Array<{
        type: string;
        name?: string;
        value?: Buffer | string;
        source?: string;
      }>
    )?.find((op) => op.type === "manageData" && op.name === "client_domain");

    if (!clientDomainOp) {
      results.push({
        id: "sep10.client_domain_operation",
        description:
          "Challenge transaction includes client_domain Manage Data operation",
        status: "fail",
        severity: "error",
        message: 'Challenge transaction missing "client_domain" Manage Data operation',
      });
    } else {
      const valStr = Buffer.isBuffer(clientDomainOp.value)
        ? clientDomainOp.value.toString("utf-8")
        : String(clientDomainOp.value ?? "");
      const expectedKey =
        opts.clientSigningKey ?? opts.clientDomainKeypair?.publicKey();
      const valueMatches = valStr === opts.clientDomain;
      const sourceMatches =
        !expectedKey || clientDomainOp.source === expectedKey;

      if (valueMatches && sourceMatches) {
        results.push({
          id: "sep10.client_domain_operation",
          description:
            "Challenge transaction includes client_domain Manage Data operation",
          status: "pass",
          severity: "error",
          message: `client_domain Manage Data operation present with value "${valStr}" and source ${clientDomainOp.source}`,
        });
      } else {
        results.push({
          id: "sep10.client_domain_operation",
          description:
            "Challenge transaction includes client_domain Manage Data operation",
          status: "fail",
          severity: "error",
          message: `client_domain operation mismatch: value="${valStr}" (expected "${opts.clientDomain}"), source=${clientDomainOp.source} (expected ${expectedKey ?? "any"})`,
        });
      }
    }
  }

  // 4. Sign the challenge as the client and submit it for a JWT.
  let jwt: string;
  try {
    const tx = TransactionBuilder.fromXDR(challengeXdr, networkPassphrase);
    tx.sign(clientKeypair);
    if (opts.clientDomainKeypair) {
      tx.sign(opts.clientDomainKeypair);
      const isSigned = tx.signatures.some((s) => {
        try {
          return opts.clientDomainKeypair!.verify(tx.hash(), s.signature());
        } catch {
          return false;
        }
      });
      results.push(
        isSigned
          ? {
              id: "sep10.client_domain_signature",
              description:
                "Challenge transaction is signed by client_domain keypair",
              status: "pass",
              severity: "error",
              message: `Signed by client_domain keypair ${opts.clientDomainKeypair.publicKey()}`,
            }
          : {
              id: "sep10.client_domain_signature",
              description:
                "Challenge transaction is signed by client_domain keypair",
              status: "fail",
              severity: "error",
              message: "Failed to sign with client_domain keypair",
            },
      );
    }
    const res = await fetchWithTimeout(
      webAuthEndpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transaction: tx.toXDR() }),
      },
      opts.timeoutMs,
    );
    const body = (await res.json().catch(() => ({}))) as {
      token?: string;
      error?: string;
    };
    if (!res.ok || !body.token) {
      results.push({
        id: "sep10.submit_challenge",
        description: "Submit signed challenge and receive a JWT",
        status: "fail",
        severity: "error",
        message: body.error ?? `HTTP ${res.status} with no token in response`,
      });
      return results;
    }
    jwt = body.token;
    results.jwt = jwt;
    opts.onJwt?.(jwt);
    results.push({
      id: "sep10.submit_challenge",
      description: "Submit signed challenge and receive a JWT",
      status: "pass",
      severity: "error",
      message: "Received a JWT from the anchor",
    });
  } catch (err) {
    results.push({
      id: "sep10.submit_challenge",
      description: "Submit signed challenge and receive a JWT",
      status: "fail",
      severity: "error",
      message: (err as Error).message,
    });
    return results;
  }

  // 5. Sanity-check the JWT header and payload.
  let isAlgNone = false;
  try {
    const header = decodeJwtHeader(jwt);
    const alg = typeof header.alg === "string" ? header.alg : undefined;

    if (!alg || alg.toLowerCase() === "none") {
      isAlgNone = true;
      results.push({
        id: "sep10.jwt_algorithm",
        description: 'JWT "alg" header indicates a signed token (not "none")',
        status: "fail",
        severity: "error",
        message: `JWT algorithm is "${alg ?? "missing"}", unsigned tokens are rejected`,
      });
    } else {
      results.push({
        id: "sep10.jwt_algorithm",
        description: 'JWT "alg" header indicates a signed token (not "none")',
        status: "pass",
        severity: "error",
        message: `JWT algorithm is "${alg}"`,
      });
    }

    const payload = decodeJwtPayload(jwt);
    const sub = typeof payload.sub === "string" ? payload.sub : undefined;
    const exp = typeof payload.exp === "number" ? payload.exp : undefined;

    results.push(
      sub?.startsWith(parsedClientAccountId)
        ? {
            id: "sep10.jwt_subject",
            description: 'JWT "sub" claim matches the client account',
            status: "pass",
            severity: "error",
            message: `sub = ${sub}`,
          }
        : {
            id: "sep10.jwt_subject",
            description: 'JWT "sub" claim matches the client account',
            status: "fail",
            severity: "error",
            message: `Expected sub to start with ${parsedClientAccountId}, got ${sub}`,
          },
    );

    const now = Math.floor(Date.now() / 1000);
    results.push(
      exp !== undefined && exp > now
        ? {
            id: "sep10.jwt_expiry",
            description: 'JWT "exp" claim is in the future',
            status: "pass",
            severity: "error",
            message: `exp = ${exp}`,
          }
        : {
            id: "sep10.jwt_expiry",
            description: 'JWT "exp" claim is in the future',
            status: "fail",
            severity: "error",
            message: `exp claim missing or not in the future (exp=${exp}, now=${now})`,
          },
    );

    if (opts.clientDomain) {
      const jwtClientDomain =
        typeof payload.client_domain === "string"
          ? payload.client_domain
          : undefined;
      results.push(
        jwtClientDomain === opts.clientDomain
          ? {
              id: "sep10.jwt_client_domain",
              description:
                'JWT "client_domain" claim matches requested client domain',
              status: "pass",
              severity: "error",
              message: `client_domain = ${jwtClientDomain}`,
            }
          : {
              id: "sep10.jwt_client_domain",
              description:
                'JWT "client_domain" claim matches requested client domain',
              status: "fail",
              severity: "error",
              message: `Expected client_domain to be "${opts.clientDomain}", got "${jwtClientDomain}"`,
            },
      );
    }
  } catch (err) {
    results.push({
      id: "sep10.jwt_decode",
      description: "Decode JWT payload",
      status: "fail",
      severity: "error",
      message: (err as Error).message,
    });
  }

  // 6. Cryptographic signature verification via anchor JWKS (if discoverable).
  if (isAlgNone) {
    results.push({
      id: "sep10.jwt_signature",
      description: "Verify JWT cryptographic signature via anchor JWKS",
      status: "fail",
      severity: "error",
      message: 'JWT signature verification failed: token uses "none" algorithm',
    });
  } else {
    const jwksEndpoint =
      opts.jwksUri ??
      toml.jwksUri ??
      (typeof toml.raw.JWKS_URI === "string"
        ? toml.raw.JWKS_URI
        : typeof toml.raw.JWKS_ENDPOINT === "string"
          ? toml.raw.JWKS_ENDPOINT
          : typeof toml.raw.JWKS === "string"
            ? toml.raw.JWKS
            : undefined);

    let resolvedJwksUri = jwksEndpoint;
    if (!resolvedJwksUri) {
      const probeUrl = `https://${webAuthDomain}/.well-known/jwks.json`;
      try {
        const probeRes = await fetchWithTimeout(probeUrl, {}, opts.timeoutMs);
        if (probeRes.ok) {
          const probeData = (await probeRes.json().catch(() => null)) as {
            keys?: unknown[];
          } | null;
          if (Array.isArray(probeData?.keys) && probeData.keys.length > 0) {
            resolvedJwksUri = probeUrl;
          }
        }
      } catch {
        // Probe failed, no discoverable JWKS
      }
    }

    if (!resolvedJwksUri) {
      results.push({
        id: "sep10.jwt_signature",
        description: "Verify JWT cryptographic signature via anchor JWKS",
        status: "warn",
        severity: "warning",
        message:
          "Skipped: no JWKS endpoint declared in stellar.toml or discovered at /.well-known/jwks.json",
      });
    } else {
      try {
        const jwksRes = await fetchWithTimeout(resolvedJwksUri, {}, opts.timeoutMs);
        if (!jwksRes.ok) {
          results.push({
            id: "sep10.jwt_signature",
            description: "Verify JWT cryptographic signature via anchor JWKS",
            status: "fail",
            severity: "error",
            message: `JWKS endpoint ${resolvedJwksUri} returned HTTP ${jwksRes.status}`,
          });
        } else {
          const jwksData = (await jwksRes.json()) as Parameters<
            typeof createLocalJWKSet
          >[0];
          const localJWKS = createLocalJWKSet(jwksData);
          await jwtVerify(jwt, localJWKS);
          results.push({
            id: "sep10.jwt_signature",
            description: "Verify JWT cryptographic signature via anchor JWKS",
            status: "pass",
            severity: "error",
            message: `JWT signature verified successfully via ${resolvedJwksUri}`,
          });
        }
      } catch (err) {
        results.push({
          id: "sep10.jwt_signature",
          description: "Verify JWT cryptographic signature via anchor JWKS",
          status: "fail",
          severity: "error",
          message: `JWT signature verification failed: ${(err as Error).message}`,
        });
      }
    }
  }

  return results;
}
