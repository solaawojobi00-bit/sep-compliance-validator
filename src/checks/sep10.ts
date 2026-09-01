import { Buffer } from "node:buffer";
import { Account, Keypair, MuxedAccount, Networks, StrKey, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
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
  memo?: string;
  useMuxedAccount?: boolean;
}

export { runSep10NegativeChecks, type Sep10NegativeOptions } from "./sep10-negative.js";

export interface Sep10Result extends Array<CheckResult> {
  jwt?: string;
  challengeXdr?: string;
  clientKeypair?: Keypair;
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

  if (toml.networkPassphrase && toml.networkPassphrase !== networkPassphrase) {
    results.push({
      id: "sep10.skipped",
      description: "Run SEP-10 challenge/response flow",
      status: "warn",
      severity: "error",
      message: `Skipped: stellar.toml NETWORK_PASSPHRASE ("${toml.networkPassphrase}") does not match target network passphrase ("${networkPassphrase}")`,
    });
    return results;
  }

  const webAuthEndpoint = toml.webAuthEndpoint;
  const signingKey = toml.signingKey;

  if (!StrKey.isValidEd25519PublicKey(signingKey)) {
    results.push({
      id: "sep10.skipped",
      description: "Run SEP-10 challenge/response flow",
      status: "warn",
      severity: "error",
      message: `Skipped: SIGNING_KEY "${signingKey}" is not a valid Stellar ed25519 public key`,
    });
    return results;
  }
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
  const clientAccountId = opts.useMuxedAccount
    ? new MuxedAccount(new Account(clientKeypair.publicKey(), "0"), "123456").accountId()
    : clientKeypair.publicKey();

  // 1. Request a challenge transaction.
  let challengeXdr: string;
  let responseNetworkPassphrase: string | undefined;
  try {
    const url = new URL(webAuthEndpoint);
    url.searchParams.set("account", clientAccountId);
    url.searchParams.set("home_domain", domain);
    if (opts.memo) {
      url.searchParams.set("memo", opts.memo);
    }
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
    results.challengeXdr = challengeXdr;
    results.clientKeypair = clientKeypair;
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

  // 3. Inspect challenge transaction operations directly to validate nonce format, entropy, and uniqueness
  // independently of SDK readChallengeTx internals.
  let rawChallengeTx: any;
  let op0: { value?: Buffer | string } | undefined;
  try {
    rawChallengeTx = TransactionBuilder.fromXDR(challengeXdr, networkPassphrase);
    op0 = rawChallengeTx.operations[0] as { value?: Buffer | string } | undefined;
  } catch {}

  const nonceBuf = Buffer.isBuffer(op0?.value)
    ? op0!.value
    : Buffer.from(String(op0?.value ?? ""), "utf-8");
  const nonceStr = nonceBuf.toString("utf-8");
  let decodedBytes: Buffer | undefined;
  try {
    if (/^[A-Za-z0-9+/=]+$/.test(nonceStr)) {
      decodedBytes = Buffer.from(nonceStr, "base64");
    }
  } catch {}

  if (nonceStr.length !== 64 || !decodedBytes || decodedBytes.length !== 48) {
    results.push({
      id: "sep10.challenge_nonce_format",
      description:
        "Challenge nonce is 64-character base64 string decoding to 48 bytes",
      status: "fail",
      severity: "error",
      message: `Expected 64-character base64 nonce decoding to 48 bytes, got ${nonceStr.length} chars (${decodedBytes?.length ?? 0} bytes)`,
    });
  } else {
    const uniqueBytes = new Set(decodedBytes).size;
    const isAllPrintableAscii = Array.from(decodedBytes).every(
      (b) => b >= 0x20 && b <= 0x7e,
    );
    if (uniqueBytes <= 4 || isAllPrintableAscii) {
      results.push({
        id: "sep10.challenge_nonce_format",
        description:
          "Challenge nonce is 64-character base64 string decoding to 48 bytes",
        status: "warn",
        severity: "warning",
        message: `Challenge nonce decodes to low-entropy data (${uniqueBytes} unique bytes, all-ASCII: ${isAllPrintableAscii})`,
      });
    } else {
      results.push({
        id: "sep10.challenge_nonce_format",
        description:
          "Challenge nonce is 64-character base64 string decoding to 48 bytes",
        status: "pass",
        severity: "error",
        message: `Nonce is 64-character base64 string decoding to 48 random bytes (${uniqueBytes} unique bytes)`,
      });
    }
  }

  // Verify challenge nonce uniqueness across distinct client accounts
  const secondClientKeypair = Keypair.random();
  const secondClientAccountId = opts.useMuxedAccount
    ? new MuxedAccount(new Account(secondClientKeypair.publicKey(), "0"), "654321").accountId()
    : secondClientKeypair.publicKey();
  try {
    const secondUrl = new URL(webAuthEndpoint);
    secondUrl.searchParams.set("account", secondClientAccountId);
    secondUrl.searchParams.set("home_domain", domain);
    if (opts.memo) {
      secondUrl.searchParams.set("memo", opts.memo);
    }
    if (opts.clientDomain) {
      secondUrl.searchParams.set("client_domain", opts.clientDomain);
    }
    const secondRes = await fetchWithTimeout(
      secondUrl.toString(),
      {},
      opts.timeoutMs,
    );
    if (!secondRes.ok) {
      results.push({
        id: "sep10.challenge_nonce_unique",
        description: "Challenge nonce is unique across separate requests",
        status: "warn",
        severity: "warning",
        message: `Could not verify nonce uniqueness: second challenge request returned HTTP ${secondRes.status}`,
      });
    } else {
      const secondBody = (await secondRes.json()) as { transaction?: string };
      if (!secondBody.transaction) {
        results.push({
          id: "sep10.challenge_nonce_unique",
          description: "Challenge nonce is unique across separate requests",
          status: "warn",
          severity: "warning",
          message:
            "Could not verify nonce uniqueness: second challenge response missing transaction field",
        });
      } else {
        const secondTx = TransactionBuilder.fromXDR(
          secondBody.transaction,
          networkPassphrase,
        );
        const secondOp0 = secondTx.operations[0] as
          | { value?: Buffer | string }
          | undefined;
        const secondNonceBuf = Buffer.isBuffer(secondOp0?.value)
          ? secondOp0!.value
          : Buffer.from(String(secondOp0?.value ?? ""), "utf-8");
        const secondNonceStr = secondNonceBuf.toString("utf-8");

        if (secondNonceStr === nonceStr) {
          results.push({
            id: "sep10.challenge_nonce_unique",
            description: "Challenge nonce is unique across separate requests",
            status: "fail",
            severity: "error",
            message: `REPLAY RISK: Server returned identical challenge nonce across two requests for distinct client accounts ("${nonceStr}")`,
          });
        } else {
          results.push({
            id: "sep10.challenge_nonce_unique",
            description: "Challenge nonce is unique across separate requests",
            status: "pass",
            severity: "error",
            message: "Challenge nonces are unique across distinct requests",
          });
        }
      }
    }
  } catch (err) {
    results.push({
      id: "sep10.challenge_nonce_unique",
      description: "Challenge nonce is unique across separate requests",
      status: "warn",
      severity: "warning",
      message: `Could not verify nonce uniqueness: second challenge request failed (${(err as Error).message})`,
    });
  }

  // Validate memo if requested, and run memo + muxed rejection negative check
  if (opts.memo) {
    const challengeMemo = rawChallengeTx?.memo;
    if (
      !challengeMemo ||
      challengeMemo.type !== "id" ||
      String(challengeMemo.value) !== opts.memo
    ) {
      results.push({
        id: "sep10.challenge_memo",
        description: 'Challenge transaction carries requested ID memo',
        status: "fail",
        severity: "error",
        message: `Expected memo of type "id" with value "${opts.memo}", got type "${challengeMemo?.type ?? "none"}" with value "${challengeMemo?.value ?? "none"}"`,
      });
    } else {
      results.push({
        id: "sep10.challenge_memo",
        description: 'Challenge transaction carries requested ID memo',
        status: "pass",
        severity: "error",
        message: `Challenge carries valid ID memo: ${challengeMemo.value}`,
      });
    }

    // Negative case: Server must reject memo combined with an M... muxed account
    try {
      const dummyKeypair = Keypair.random();
      const dummyMuxed = new MuxedAccount(
        new Account(dummyKeypair.publicKey(), "0"),
        "999",
      ).accountId();
      const conflictUrl = new URL(webAuthEndpoint);
      conflictUrl.searchParams.set("account", dummyMuxed);
      conflictUrl.searchParams.set("memo", opts.memo);
      conflictUrl.searchParams.set("home_domain", domain);
      const conflictRes = await fetchWithTimeout(
        conflictUrl.toString(),
        {},
        opts.timeoutMs,
      );
      if (conflictRes.status >= 400 && conflictRes.status < 500) {
        results.push({
          id: "sep10.memo_muxed_conflict_rejected",
          description:
            "Server rejects challenge request combining memo with muxed (M...) account",
          status: "pass",
          severity: "error",
          message: `Server correctly rejected memo with muxed account (HTTP ${conflictRes.status})`,
        });
      } else {
        results.push({
          id: "sep10.memo_muxed_conflict_rejected",
          description:
            "Server rejects challenge request combining memo with muxed (M...) account",
          status: "fail",
          severity: "error",
          message: `Server failed to reject memo with muxed account (HTTP ${conflictRes.status})`,
        });
      }
    } catch (err) {
      results.push({
        id: "sep10.memo_muxed_conflict_rejected",
        description:
          "Server rejects challenge request combining memo with muxed (M...) account",
        status: "warn",
        severity: "warning",
        message: `Could not verify memo/muxed conflict rejection: ${(err as Error).message}`,
      });
    }
  }

  // 4. Validate the challenge transaction's structure via the SDK (sequence
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
    parsedClientAccountId === clientAccountId
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
          message: `Expected ${clientAccountId}, got ${parsedClientAccountId}`,
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
    const iss = typeof payload.iss === "string" ? payload.iss : undefined;
    const sub = typeof payload.sub === "string" ? payload.sub : undefined;
    const iat = typeof payload.iat === "number" ? payload.iat : undefined;
    const exp = typeof payload.exp === "number" ? payload.exp : undefined;
    const now = Math.floor(Date.now() / 1000);

    // Validate iss
    let issValid = false;
    let issMessage = "";
    if (!iss) {
      issMessage = 'JWT "iss" claim is missing or not a string';
    } else {
      try {
        const parsedIss = new URL(iss);
        const issHost = parsedIss.host.toLowerCase();
        const expectedHosts = [
          domain.toLowerCase(),
          webAuthDomain.toLowerCase(),
        ];
        const matches = expectedHosts.some(
          (h) => issHost === h || issHost.endsWith("." + h),
        );
        if (matches) {
          issValid = true;
          issMessage = `iss = ${iss}`;
        } else {
          issMessage = `JWT iss host "${issHost}" does not match domain "${domain}" or web_auth_domain "${webAuthDomain}"`;
        }
      } catch {
        issMessage = `JWT "iss" claim "${iss}" is not a valid URI`;
      }
    }

    results.push({
      id: "sep10.jwt_issuer",
      description: 'JWT "iss" claim matches anchor domain or WEB_AUTH_ENDPOINT host',
      status: issValid ? "pass" : "fail",
      severity: "error",
      message: issMessage,
    });

    // Validate iat
    const iatTolerance = 60; // 60s clock-skew tolerance
    let iatValid = false;
    let iatMessage = "";
    if (iat === undefined || Number.isNaN(iat)) {
      iatMessage = 'JWT "iat" claim is missing or not a number';
    } else if (iat > now + iatTolerance) {
      iatMessage = `JWT "iat" claim (${iat}) is in the future (now=${now}, tolerance=${iatTolerance}s)`;
    } else {
      iatValid = true;
      iatMessage = `iat = ${iat}`;
    }

    results.push({
      id: "sep10.jwt_issued_at",
      description: 'JWT "iat" claim is present, numeric, and not in the future',
      status: iatValid ? "pass" : "fail",
      severity: "error",
      message: iatMessage,
    });

    // Validate sub (exact G..., exact G...:<digits>, or exact M... muxed account)
    let subValid = false;
    let subMessage = "";

    if (opts.memo) {
      const expectedSub = `${clientKeypair.publicKey()}:${opts.memo}`;
      if (sub === expectedSub) {
        subValid = true;
        subMessage = `sub = ${sub}`;
      } else {
        subMessage = `Expected sub to be exactly "${expectedSub}", got "${sub}"`;
      }
    } else if (opts.useMuxedAccount) {
      if (sub === clientAccountId) {
        subValid = true;
        subMessage = `sub = ${sub} (muxed account unchanged)`;
      } else {
        subMessage = `Expected sub to return muxed account unchanged "${clientAccountId}", got "${sub}"`;
      }
    } else {
      if (!sub) {
        subMessage = `Expected sub to be ${parsedClientAccountId}, got ${sub ?? "missing"}`;
      } else if (sub === parsedClientAccountId) {
        subValid = true;
        subMessage = `sub = ${sub}`;
      } else if (sub.startsWith(`${parsedClientAccountId}:`)) {
        const memo = sub.slice(parsedClientAccountId.length + 1);
        if (/^\d+$/.test(memo)) {
          subValid = true;
          subMessage = `sub = ${sub}`;
        } else {
          subMessage = `Invalid sub "${sub}": memo suffix must be digits, expected ${parsedClientAccountId}:<digits>`;
        }
      } else if (StrKey.isValidMed25519PublicKey(sub)) {
        try {
          const base = MuxedAccount.fromAddress(sub, "0").baseAccount().accountId();
          if (base === parsedClientAccountId) {
            subValid = true;
            subMessage = `sub = ${sub} (muxed account for ${parsedClientAccountId})`;
          } else {
            subMessage = `Invalid muxed sub "${sub}": base account ${base} does not match ${parsedClientAccountId}`;
          }
        } catch {
          subMessage = `Invalid muxed sub "${sub}"`;
        }
      } else {
        subMessage = `Invalid sub "${sub}": expected exact ${parsedClientAccountId}, ${parsedClientAccountId}:<digits>, or valid M... muxed account`;
      }
    }

    results.push({
      id: "sep10.jwt_subject",
      description: 'JWT "sub" claim matches the client account',
      status: subValid ? "pass" : "fail",
      severity: "error",
      message: subMessage,
    });
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
