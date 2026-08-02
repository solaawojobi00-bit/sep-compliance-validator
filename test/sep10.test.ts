import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, Networks, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import { runSep10Checks } from "../src/checks/sep10.js";
import type { StellarToml } from "../src/checks/sep1.js";

const domain = "example.com";
const webAuthEndpoint = "https://example.com/auth";
const webAuthDomain = new URL(webAuthEndpoint).host;

function fakeJwt(sub: string, expiresInSeconds = 3600): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + expiresInSeconds }),
  ).toString("base64url");
  return `${header}.${payload}.`;
}

describe("runSep10Checks", () => {
  const serverKeypair = Keypair.random();
  const toml: StellarToml = {
    raw: {},
    webAuthEndpoint,
    signingKey: serverKeypair.publicKey(),
    networkPassphrase: Networks.TESTNET,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the full flow for a well-formed anchor", async () => {
    let capturedAccount = "";

    global.fetch = vi.fn(async (_input, init) => {
      if (!init || init.method === undefined) {
        const url = new URL(_input as string);
        capturedAccount = url.searchParams.get("account")!;
        const challengeXdr = WebAuth.buildChallengeTx(
          serverKeypair,
          capturedAccount,
          domain,
          300,
          Networks.TESTNET,
          webAuthDomain,
        );
        return {
          ok: true,
          status: 200,
          json: async () => ({
            transaction: challengeXdr,
            network_passphrase: Networks.TESTNET,
          }),
        } as Response;
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ token: fakeJwt(capturedAccount) }),
      } as Response;
    }) as unknown as typeof fetch;

    const results = await runSep10Checks({ domain, toml, network: "testnet" });
    const failures = results.filter((r) => r.status === "fail");
    expect(failures).toEqual([]);
    expect(results.find((r) => r.id === "sep10.submit_challenge")?.status).toBe("pass");
  });

  it("fails when the challenge is signed by the wrong server key", async () => {
    const wrongKeypair = Keypair.random();

    global.fetch = vi.fn(async (_input, init) => {
      if (!init || init.method === undefined) {
        const url = new URL(_input as string);
        const account = url.searchParams.get("account")!;
        const challengeXdr = WebAuth.buildChallengeTx(
          wrongKeypair,
          account,
          domain,
          300,
          Networks.TESTNET,
          webAuthDomain,
        );
        return {
          ok: true,
          status: 200,
          json: async () => ({
            transaction: challengeXdr,
            network_passphrase: Networks.TESTNET,
          }),
        } as Response;
      }
      throw new Error("should not reach POST step");
    }) as unknown as typeof fetch;

    const results = await runSep10Checks({ domain, toml, network: "testnet" });
    const structureCheck = results.find((r) => r.id === "sep10.challenge_structure");
    expect(structureCheck?.status).toBe("fail");
  });

  it("fails when the challenge home domain does not match", async () => {
    global.fetch = vi.fn(async (_input, init) => {
      if (!init || init.method === undefined) {
        const url = new URL(_input as string);
        const account = url.searchParams.get("account")!;
        const challengeXdr = WebAuth.buildChallengeTx(
          serverKeypair,
          account,
          "wrong-domain.com",
          300,
          Networks.TESTNET,
          webAuthDomain,
        );
        return {
          ok: true,
          status: 200,
          json: async () => ({
            transaction: challengeXdr,
            network_passphrase: Networks.TESTNET,
          }),
        } as Response;
      }
      throw new Error("should not reach POST step");
    }) as unknown as typeof fetch;

    const results = await runSep10Checks({ domain, toml, network: "testnet" });
    const structureCheck = results.find((r) => r.id === "sep10.challenge_structure");
    expect(structureCheck?.status).toBe("fail");
  });

  it("skips when WEB_AUTH_ENDPOINT is missing from stellar.toml", async () => {
    const incompleteToml: StellarToml = { raw: {} };
    const results = await runSep10Checks({
      domain,
      toml: incompleteToml,
      network: "testnet",
    });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("warn");
  });

  it("fails when the JWT is missing an exp claim", async () => {
    let capturedAccount = "";
    global.fetch = vi.fn(async (_input, init) => {
      if (!init || init.method === undefined) {
        const url = new URL(_input as string);
        capturedAccount = url.searchParams.get("account")!;
        const challengeXdr = WebAuth.buildChallengeTx(
          serverKeypair,
          capturedAccount,
          domain,
          300,
          Networks.TESTNET,
          webAuthDomain,
        );
        return {
          ok: true,
          status: 200,
          json: async () => ({
            transaction: challengeXdr,
            network_passphrase: Networks.TESTNET,
          }),
        } as Response;
      }

      const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
        "base64url",
      );
      const payload = Buffer.from(JSON.stringify({ sub: capturedAccount })).toString(
        "base64url",
      );
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: `${header}.${payload}.` }),
      } as Response;
    }) as unknown as typeof fetch;

    const results = await runSep10Checks({ domain, toml, network: "testnet" });
    const expiry = results.find((r) => r.id === "sep10.jwt_expiry");
    expect(expiry?.status).toBe("fail");
  });
});
