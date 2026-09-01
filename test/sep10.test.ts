import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, Networks, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import * as jose from "jose";
import { runSep10Checks } from "../src/checks/sep10.js";
import type { StellarToml } from "../src/checks/sep1.js";

const domain = "example.com";
const webAuthEndpoint = "https://example.com/auth";
const webAuthDomain = new URL(webAuthEndpoint).host;

function fakeJwt(
  sub: string,
  expiresInSeconds = 3600,
  extraClaims: Record<string, unknown> = {},
  alg = "EdDSA",
): string {
  const header = Buffer.from(JSON.stringify({ alg, typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      sub,
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
      ...extraClaims,
    }),
  ).toString("base64url");
  return `${header}.${payload}.fakesig`;
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

  it("fails when the challenge transaction server signature has been tampered with", async () => {
    global.fetch = vi.fn(async (_input, init) => {
      if (!init || init.method === undefined) {
        const url = new URL(_input as string);
        const account = url.searchParams.get("account")!;
        const challengeXdr = WebAuth.buildChallengeTx(
          serverKeypair,
          account,
          domain,
          300,
          Networks.TESTNET,
          webAuthDomain,
        );

        // Corrupt one byte of the resulting XDR's signature section
        const tx = TransactionBuilder.fromXDR(challengeXdr, Networks.TESTNET);
        const sigBytes = tx.signatures[0].signature();
        sigBytes[0] ^= 0xff;
        const tamperedXdr = tx.toXDR();

        return {
          ok: true,
          status: 200,
          json: async () => ({
            transaction: tamperedXdr,
            network_passphrase: Networks.TESTNET,
          }),
        } as Response;
      }
      throw new Error("should not reach POST step");
    }) as unknown as typeof fetch;

    const results = await runSep10Checks({ domain, toml, network: "testnet" });
    const structureCheck = results.find((r) => r.id === "sep10.challenge_structure");
    expect(structureCheck?.status).toBe("fail");
    expect(structureCheck?.message).toContain("Transaction not signed by server");
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

      const header = Buffer.from(JSON.stringify({ alg: "EdDSA" })).toString(
        "base64url",
      );
      const payload = Buffer.from(JSON.stringify({ sub: capturedAccount })).toString(
        "base64url",
      );
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: `${header}.${payload}.fakesig` }),
      } as Response;
    }) as unknown as typeof fetch;

    const results = await runSep10Checks({ domain, toml, network: "testnet" });
    const expiry = results.find((r) => r.id === "sep10.jwt_expiry");
    expect(expiry?.status).toBe("fail");
  });

  it("passes full client_domain verification flow with signed extra operation", async () => {
    const clientDomain = "wallet.example.com";
    const clientDomainKeypair = Keypair.random();
    let capturedAccount = "";
    let capturedClientDomain = "";

    global.fetch = vi.fn(async (_input, init) => {
      const urlStr = _input.toString();
      if (urlStr.includes(".well-known/jwks.json")) {
        return { ok: false, status: 404 } as Response;
      }

      if (!init || init.method === undefined) {
        const url = new URL(urlStr);
        capturedAccount = url.searchParams.get("account")!;
        capturedClientDomain = url.searchParams.get("client_domain")!;

        const challengeXdr = WebAuth.buildChallengeTx(
          serverKeypair,
          capturedAccount,
          domain,
          300,
          Networks.TESTNET,
          webAuthDomain,
          null,
          capturedClientDomain,
          clientDomainKeypair.publicKey(),
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

      // Check submitted transaction
      const body = JSON.parse(init.body as string);
      const submittedTx = TransactionBuilder.fromXDR(body.transaction, Networks.TESTNET);
      expect(submittedTx.signatures.length).toBe(3); // server, client, clientDomain

      return {
        ok: true,
        status: 200,
        json: async () => ({
          token: fakeJwt(capturedAccount, 3600, { client_domain: clientDomain }),
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const results = await runSep10Checks({
      domain,
      toml,
      network: "testnet",
      clientDomain,
      clientDomainKeypair,
    });

    expect(capturedClientDomain).toBe(clientDomain);
    const opCheck = results.find((r) => r.id === "sep10.client_domain_operation");
    const sigCheck = results.find((r) => r.id === "sep10.client_domain_signature");
    const jwtCheck = results.find((r) => r.id === "sep10.jwt_client_domain");

    expect(opCheck?.status).toBe("pass");
    expect(sigCheck?.status).toBe("pass");
    expect(jwtCheck?.status).toBe("pass");
    expect(results.filter((r) => r.status === "fail")).toEqual([]);
  });

  it("fails when client_domain is requested but missing from challenge transaction", async () => {
    const clientDomain = "wallet.example.com";
    const clientDomainKeypair = Keypair.random();

    global.fetch = vi.fn(async (_input, init) => {
      if (!init || init.method === undefined) {
        const url = new URL(_input as string);
        const account = url.searchParams.get("account")!;

        // Standard challenge WITHOUT client_domain
        const challengeXdr = WebAuth.buildChallengeTx(
          serverKeypair,
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

      return {
        ok: true,
        status: 200,
        json: async () => ({ token: fakeJwt("GABC") }),
      } as Response;
    }) as unknown as typeof fetch;

    const results = await runSep10Checks({
      domain,
      toml,
      network: "testnet",
      clientDomain,
      clientDomainKeypair,
    });

    const opCheck = results.find((r) => r.id === "sep10.client_domain_operation");
    expect(opCheck?.status).toBe("fail");
  });

  it("passes timebounds check when challenge validity window is within 15 minutes", async () => {
    let capturedAccount = "";
    global.fetch = vi.fn(async (_input, init) => {
      if (!init || init.method === undefined) {
        const url = new URL(_input as string);
        capturedAccount = url.searchParams.get("account")!;
        const challengeXdr = WebAuth.buildChallengeTx(
          serverKeypair,
          capturedAccount,
          domain,
          300, // 5 minutes <= 15 minutes
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
    const tbCheck = results.find((r) => r.id === "sep10.challenge_timebounds_reasonable");
    expect(tbCheck?.status).toBe("pass");
  });

  it("fails timebounds check when challenge validity window exceeds 15 minutes", async () => {
    let capturedAccount = "";
    global.fetch = vi.fn(async (_input, init) => {
      if (!init || init.method === undefined) {
        const url = new URL(_input as string);
        capturedAccount = url.searchParams.get("account")!;
        const challengeXdr = WebAuth.buildChallengeTx(
          serverKeypair,
          capturedAccount,
          domain,
          1800, // 30 minutes > 15 minutes
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
    const tbCheck = results.find((r) => r.id === "sep10.challenge_timebounds_reasonable");
    expect(tbCheck?.status).toBe("fail");
    expect(tbCheck?.message).toContain("exceeds maximum recommended 900s");
  });

  it("verifies JWT signature when anchor provides a valid JWKS endpoint", async () => {
    const { publicKey, privateKey } = await jose.generateKeyPair("ES256");
    const jwk = await jose.exportJWK(publicKey);
    jwk.kid = "test-kid-1";
    jwk.alg = "ES256";
    const jwks = { keys: [jwk] };

    let capturedAccount = "";
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = input.toString();

      if (urlStr === "https://example.com/jwks.json") {
        return {
          ok: true,
          status: 200,
          json: async () => jwks,
        } as Response;
      }

      if (!init || init.method === undefined) {
        const url = new URL(urlStr);
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

      const signedJwt = await new jose.SignJWT({ sub: capturedAccount })
        .setProtectedHeader({ alg: "ES256", kid: "test-kid-1" })
        .setExpirationTime("1h")
        .sign(privateKey);

      return {
        ok: true,
        status: 200,
        json: async () => ({ token: signedJwt }),
      } as Response;
    }) as unknown as typeof fetch;

    const tomlWithJwks: StellarToml = {
      ...toml,
      jwksUri: "https://example.com/jwks.json",
    };

    const results = await runSep10Checks({
      domain,
      toml: tomlWithJwks,
      network: "testnet",
    });

    const sigCheck = results.find((r) => r.id === "sep10.jwt_signature");
    expect(sigCheck?.status).toBe("pass");
    expect(sigCheck?.message).toContain("verified successfully");
  });

  it("fails JWT signature verification when token payload is tampered", async () => {
    const { publicKey, privateKey } = await jose.generateKeyPair("ES256");
    const jwk = await jose.exportJWK(publicKey);
    jwk.kid = "test-kid-1";
    jwk.alg = "ES256";
    const jwks = { keys: [jwk] };

    let capturedAccount = "";
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = input.toString();

      if (urlStr === "https://example.com/jwks.json") {
        return {
          ok: true,
          status: 200,
          json: async () => jwks,
        } as Response;
      }

      if (!init || init.method === undefined) {
        const url = new URL(urlStr);
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

      const validJwt = await new jose.SignJWT({ sub: capturedAccount })
        .setProtectedHeader({ alg: "ES256", kid: "test-kid-1" })
        .setExpirationTime("1h")
        .sign(privateKey);

      // Tamper with the payload while keeping the original signature
      const parts = validJwt.split(".");
      const tamperedPayload = Buffer.from(
        JSON.stringify({ sub: "GTAMPEREDACCOUNT", exp: Math.floor(Date.now() / 1000) + 3600 }),
      ).toString("base64url");
      const tamperedJwt = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

      return {
        ok: true,
        status: 200,
        json: async () => ({ token: tamperedJwt }),
      } as Response;
    }) as unknown as typeof fetch;

    const tomlWithJwks: StellarToml = {
      ...toml,
      jwksUri: "https://example.com/jwks.json",
    };

    const results = await runSep10Checks({
      domain,
      toml: tomlWithJwks,
      network: "testnet",
    });

    const sigCheck = results.find((r) => r.id === "sep10.jwt_signature");
    expect(sigCheck?.status).toBe("fail");
    expect(sigCheck?.message).toContain("verification failed");
  });

  it("fails when JWT algorithm is 'none'", async () => {
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
        json: async () => ({ token: fakeJwt(capturedAccount, 3600, {}, "none") }),
      } as Response;
    }) as unknown as typeof fetch;

    const results = await runSep10Checks({ domain, toml, network: "testnet" });
    const algCheck = results.find((r) => r.id === "sep10.jwt_algorithm");
    const sigCheck = results.find((r) => r.id === "sep10.jwt_signature");

    expect(algCheck?.status).toBe("fail");
    expect(algCheck?.message).toContain('unsigned tokens are rejected');
    expect(sigCheck?.status).toBe("fail");
  });

  it("warns when no JWKS endpoint is discoverable", async () => {
    let capturedAccount = "";
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = input.toString();

      if (urlStr.includes(".well-known/jwks.json")) {
        return {
          ok: false,
          status: 404,
        } as Response;
      }

      if (!init || init.method === undefined) {
        const url = new URL(urlStr);
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
    const sigCheck = results.find((r) => r.id === "sep10.jwt_signature");

    expect(sigCheck?.status).toBe("warn");
    expect(sigCheck?.message).toContain("no JWKS endpoint declared");
  });

  it("fails fast when challenge request exceeds configured timeoutMs", async () => {
    global.fetch = vi.fn(async (_url, init) => {
      return new Promise<Response>((resolve, reject) => {
        const signal = (init as RequestInit)?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    }) as unknown as typeof fetch;

    const results = await runSep10Checks({
      domain,
      toml,
      network: "testnet",
      timeoutMs: 25,
    });
    const reqCheck = results.find((r) => r.id === "sep10.challenge_request");
    expect(reqCheck?.status).toBe("fail");
    expect(reqCheck?.message).toContain("timed out after 25ms");
  });

  it("exercises mainnet network branch using Networks.PUBLIC", async () => {
    let capturedAccount = "";
    global.fetch = vi.fn(async (_input, init) => {
      const urlStr = _input as string;
      if (urlStr.includes(".well-known/jwks.json")) {
        return { ok: false, status: 404 } as Response;
      }
      if (!init || init.method === undefined) {
        const url = new URL(urlStr);
        capturedAccount = url.searchParams.get("account")!;
        const challengeXdr = WebAuth.buildChallengeTx(
          serverKeypair,
          capturedAccount,
          domain,
          300,
          Networks.PUBLIC,
          webAuthDomain,
        );
        return {
          ok: true,
          status: 200,
          json: async () => ({
            transaction: challengeXdr,
            network_passphrase: Networks.PUBLIC,
          }),
        } as Response;
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ token: fakeJwt(capturedAccount) }),
      } as Response;
    }) as unknown as typeof fetch;

    const results = await runSep10Checks({ domain, toml, network: "mainnet" });
    const structureCheck = results.find((r) => r.id === "sep10.challenge_structure");
    const networkCheck = results.find((r) => r.id === "sep10.network_passphrase_match");
    const submitCheck = results.find((r) => r.id === "sep10.submit_challenge");

    expect(structureCheck?.status).toBe("pass");
    expect(networkCheck?.status).toBe("pass");
    expect(submitCheck?.status).toBe("pass");
  });
});
