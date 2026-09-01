import { Buffer } from "node:buffer";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  WebAuth,
} from "@stellar/stellar-sdk";
import { fetchWithTimeout } from "../core/http.js";
import type { CheckResult } from "../core/report.js";

export interface Sep10NegativeOptions {
  webAuthEndpoint: string;
  domain: string;
  network: "testnet" | "mainnet";
  serverSigningKey: string;
  challengeXdr?: string;
  clientKeypair?: Keypair;
  timeoutMs?: number;
}

async function submitAndAssertRejected(
  checkId: string,
  description: string,
  caseName: string,
  txXdr: string,
  webAuthEndpoint: string,
  timeoutMs?: number,
): Promise<CheckResult> {
  try {
    const res = await fetchWithTimeout(
      webAuthEndpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transaction: txXdr }),
      },
      timeoutMs,
    );

    const body = (await res.json().catch(() => ({}))) as {
      token?: string;
      error?: string;
    };

    if (res.ok || body.token) {
      return {
        id: checkId,
        description,
        status: "fail",
        severity: "error",
        message: `AUTHENTICATION BYPASS: Anchor accepted ${caseName} and issued a JWT (HTTP ${res.status})`,
      };
    }

    if (res.status >= 400 && res.status < 500) {
      return {
        id: checkId,
        description,
        status: "pass",
        severity: "error",
        message: `Anchor correctly rejected ${caseName} with HTTP ${res.status}${body.error ? `: "${body.error}"` : ""}`,
      };
    }

    return {
      id: checkId,
      description,
      status: "fail",
      severity: "error",
      message: `Anchor returned HTTP ${res.status} (expected HTTP 4xx rejection for ${caseName})`,
    };
  } catch (err) {
    return {
      id: checkId,
      description,
      status: "fail",
      severity: "error",
      message: `Endpoint unreachable or network error testing ${caseName}: ${(err as Error).message}`,
    };
  }
}

export async function runSep10NegativeChecks(
  opts: Sep10NegativeOptions,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const { webAuthEndpoint, domain, network, timeoutMs } = opts;
  const networkPassphrase =
    network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
  const oppositePassphrase =
    network === "mainnet" ? Networks.TESTNET : Networks.PUBLIC;

  let webAuthDomain: string;
  try {
    webAuthDomain = new URL(webAuthEndpoint).host;
  } catch {
    webAuthDomain = domain;
  }

  const clientKeypair = opts.clientKeypair ?? Keypair.random();

  // (a) Expired challenge: timebounds entirely in the past
  try {
    const now = Math.floor(Date.now() / 1000);
    const serverKeypair = Keypair.random();
    const account = new Account(serverKeypair.publicKey(), "-1");
    const expiredTx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase,
      timebounds: {
        minTime: now - 600,
        maxTime: now - 300,
      },
    })
      .addOperation(
        Operation.manageData({
          name: `${domain} auth`,
          value: Buffer.from("expired-challenge-nonce-012345678901234567890123456789"),
          source: clientKeypair.publicKey(),
        }),
      )
      .addOperation(
        Operation.manageData({
          name: "web_auth_domain",
          value: webAuthDomain,
          source: serverKeypair.publicKey(),
        }),
      )
      .build();

    expiredTx.sign(serverKeypair);
    expiredTx.sign(clientKeypair);

    const expiredResult = await submitAndAssertRejected(
      "sep10.negative.expired",
      "Reject expired challenge transaction (timebounds in past)",
      "expired challenge",
      expiredTx.toXDR(),
      webAuthEndpoint,
      timeoutMs,
    );
    results.push(expiredResult);
  } catch (err) {
    results.push({
      id: "sep10.negative.expired",
      description: "Reject expired challenge transaction (timebounds in past)",
      status: "fail",
      severity: "error",
      message: `Failed to construct expired challenge: ${(err as Error).message}`,
    });
  }

  // (b) Wrong network: challenge built and signed against opposite network passphrase
  try {
    const serverKeypair = Keypair.random();
    const wrongNetXdr = WebAuth.buildChallengeTx(
      serverKeypair,
      clientKeypair.publicKey(),
      domain,
      300,
      oppositePassphrase,
      webAuthDomain,
    );
    const wrongNetTx = TransactionBuilder.fromXDR(wrongNetXdr, oppositePassphrase);
    wrongNetTx.sign(clientKeypair);

    const wrongNetResult = await submitAndAssertRejected(
      "sep10.negative.wrong_network",
      "Reject challenge transaction signed for wrong network passphrase",
      "wrong-network challenge",
      wrongNetTx.toXDR(),
      webAuthEndpoint,
      timeoutMs,
    );
    results.push(wrongNetResult);
  } catch (err) {
    results.push({
      id: "sep10.negative.wrong_network",
      description: "Reject challenge transaction signed for wrong network passphrase",
      status: "fail",
      severity: "error",
      message: `Failed to construct wrong-network challenge: ${(err as Error).message}`,
    });
  }

  // Helper to obtain a real server-signed challenge if not passed in
  let baseChallengeXdr = opts.challengeXdr;
  if (!baseChallengeXdr) {
    try {
      const url = new URL(webAuthEndpoint);
      url.searchParams.set("account", clientKeypair.publicKey());
      url.searchParams.set("home_domain", domain);
      const res = await fetchWithTimeout(url.toString(), {}, timeoutMs);
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          transaction?: string;
        };
        baseChallengeXdr = body.transaction;
      }
    } catch {
      // Ignore fallback failure; will report in checks below
    }
  }

  // (c) Tampered payload: first manage_data op value modified after server signed it
  try {
    if (!baseChallengeXdr) {
      throw new Error("No server challenge available to tamper");
    }
    const tx = TransactionBuilder.fromXDR(baseChallengeXdr, networkPassphrase);
    const envelope = tx.toEnvelope();
    envelope
      .v1()
      .tx()
      .operations()[0]
      .body()
      .manageDataOp()
      .dataValue(Buffer.from("tampered-nonce-tampered-nonce-tampered-nonce!"));

    const tamperedTx = TransactionBuilder.fromXDR(
      envelope.toXDR("base64"),
      networkPassphrase,
    );
    tamperedTx.sign(clientKeypair);

    const tamperedResult = await submitAndAssertRejected(
      "sep10.negative.tampered_payload",
      "Reject challenge with tampered payload / invalidated server signature",
      "tampered challenge payload",
      tamperedTx.toXDR(),
      webAuthEndpoint,
      timeoutMs,
    );
    results.push(tamperedResult);
  } catch (err) {
    results.push({
      id: "sep10.negative.tampered_payload",
      description: "Reject challenge with tampered payload / invalidated server signature",
      status: "fail",
      severity: "error",
      message: `Failed to construct tampered challenge: ${(err as Error).message}`,
    });
  }

  // (d) Missing client signature: server-signed challenge submitted with NO client signature
  try {
    if (!baseChallengeXdr) {
      throw new Error("No server challenge available for unsigned submission");
    }
    const missingSigResult = await submitAndAssertRejected(
      "sep10.negative.missing_client_sig",
      "Reject challenge submitted without required client signature",
      "challenge without client signature",
      baseChallengeXdr,
      webAuthEndpoint,
      timeoutMs,
    );
    results.push(missingSigResult);
  } catch (err) {
    results.push({
      id: "sep10.negative.missing_client_sig",
      description: "Reject challenge submitted without required client signature",
      status: "fail",
      severity: "error",
      message: `Failed to test missing client signature: ${(err as Error).message}`,
    });
  }

  return results;
}
