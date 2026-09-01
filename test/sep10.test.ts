import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Account, Keypair, MuxedAccount, Networks, Operation, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
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
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg, typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: `https://${domain}/auth`,
      iat: now,
      sub,
      exp: now + expiresInSeconds,
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
        if (!capturedAccount) {
          capturedAccount = url.searchParams.get("account")!;
        }
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
        if (!capturedAccount) {
          capturedAccount = url.searchParams.get("account")!;
        }
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

    const mainnetToml = { ...toml, networkPassphrase: Networks.PUBLIC };
    const results = await runSep10Checks({ domain, toml: mainnetToml, network: "mainnet" });
    const structureCheck = results.find((r) => r.id === "sep10.challenge_structure");
    const networkCheck = results.find((r) => r.id === "sep10.network_passphrase_match");
    const submitCheck = results.find((r) => r.id === "sep10.submit_challenge");

    expect(structureCheck?.status).toBe("pass");
    expect(networkCheck?.status).toBe("pass");
    expect(submitCheck?.status).toBe("pass");
  });

  it("skips SEP-10 checks when toml.networkPassphrase does not match target network", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;

    const mismatchToml: StellarToml = {
      raw: {},
      webAuthEndpoint: `https://${domain}/auth`,
      signingKey: serverKeypair.publicKey(),
      networkPassphrase: Networks.PUBLIC,
    };

    const results = await runSep10Checks({
      domain,
      toml: mismatchToml,
      network: "testnet",
    });

    expect(results.length).toBe(1);
    expect(results[0].id).toBe("sep10.skipped");
    expect(results[0].status).toBe("warn");
    expect(results[0].message).toContain("does not match target network passphrase");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips SEP-10 checks when toml.signingKey is malformed", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;

    const malformedToml: StellarToml = {
      raw: {},
      webAuthEndpoint: `https://${domain}/auth`,
      signingKey: "GNOTVALIDED25519KEY",
      networkPassphrase: Networks.TESTNET,
    };

    const results = await runSep10Checks({
      domain,
      toml: malformedToml,
      network: "testnet",
    });

    expect(results.length).toBe(1);
    expect(results[0].id).toBe("sep10.skipped");
    expect(results[0].status).toBe("warn");
    expect(results[0].message).toContain('SIGNING_KEY "GNOTVALIDED25519KEY" is not a valid Stellar ed25519 public key');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("SEP-10 JWT claims validation (iss, iat, sub)", () => {
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

  function setupAuthMock(createToken: (account: string) => string) {
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
        return {
          ok: true,
          status: 200,
          json: async () => ({
            transaction: challengeXdr,
            network_passphrase: Networks.TESTNET,
          }),
        } as Response;
      }
      const postBody = JSON.parse((init as any).body) as { transaction: string };
      const { clientAccountID } = WebAuth.readChallengeTx(
        postBody.transaction,
        serverKeypair.publicKey(),
        Networks.TESTNET,
        [domain],
        webAuthDomain,
      );
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: createToken(clientAccountID) }),
      } as Response;
    }) as unknown as typeof fetch;
  }

  it("passes when iss, iat, and exact G... sub are valid", async () => {
    setupAuthMock((account) => fakeJwt(account));
    const results = await runSep10Checks({ domain, toml, network: "testnet" });

    const issCheck = results.find((r) => r.id === "sep10.jwt_issuer");
    const iatCheck = results.find((r) => r.id === "sep10.jwt_issued_at");
    const subCheck = results.find((r) => r.id === "sep10.jwt_subject");

    expect(issCheck?.status).toBe("pass");
    expect(iatCheck?.status).toBe("pass");
    expect(subCheck?.status).toBe("pass");
  });

  it("fails when iss is missing", async () => {
    setupAuthMock((account) => {
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          sub: account,
          iat: now,
          exp: now + 3600,
        }),
      ).toString("base64url");
      return `${header}.${payload}.fakesig`;
    });

    const results = await runSep10Checks({ domain, toml, network: "testnet" });
    const issCheck = results.find((r) => r.id === "sep10.jwt_issuer");
    expect(issCheck?.status).toBe("fail");
    expect(issCheck?.message).toContain('JWT "iss" claim is missing');
  });

  it("fails when iss host does not match anchor domain or web_auth_domain", async () => {
    setupAuthMock((account) => fakeJwt(account, 3600, { iss: "https://malicious-anchor.com/auth" }));
    const results = await runSep10Checks({ domain, toml, network: "testnet" });
    const issCheck = results.find((r) => r.id === "sep10.jwt_issuer");
    expect(issCheck?.status).toBe("fail");
    expect(issCheck?.message).toContain('JWT iss host "malicious-anchor.com" does not match');
  });

  it("fails when iat is missing or non-numeric", async () => {
    setupAuthMock((account) => fakeJwt(account, 3600, { iat: "not-a-number" }));
    const results = await runSep10Checks({ domain, toml, network: "testnet" });
    const iatCheck = results.find((r) => r.id === "sep10.jwt_issued_at");
    expect(iatCheck?.status).toBe("fail");
    expect(iatCheck?.message).toContain('JWT "iat" claim is missing or not a number');
  });

  it("fails when iat is in the future beyond clock skew tolerance", async () => {
    const futureIat = Math.floor(Date.now() / 1000) + 300;
    setupAuthMock((account) => fakeJwt(account, 3600, { iat: futureIat }));
    const results = await runSep10Checks({ domain, toml, network: "testnet" });
    const iatCheck = results.find((r) => r.id === "sep10.jwt_issued_at");
    expect(iatCheck?.status).toBe("fail");
    expect(iatCheck?.message).toContain("is in the future");
  });

  it("passes when sub has valid numeric memo (G...:<digits>)", async () => {
    setupAuthMock((account) => fakeJwt(`${account}:17509749319012223907`));
    const results = await runSep10Checks({ domain, toml, network: "testnet" });
    const subCheck = results.find((r) => r.id === "sep10.jwt_subject");
    expect(subCheck?.status).toBe("pass");
  });

  it("fails when sub has non-numeric memo suffix", async () => {
    setupAuthMock((account) => fakeJwt(`${account}:notdigits`));
    const results = await runSep10Checks({ domain, toml, network: "testnet" });
    const subCheck = results.find((r) => r.id === "sep10.jwt_subject");
    expect(subCheck?.status).toBe("fail");
    expect(subCheck?.message).toContain("memo suffix must be digits");
  });

  it("fails when sub has arbitrary trailing characters (loose startsWith rejected)", async () => {
    setupAuthMock((account) => fakeJwt(`${account}EXTRA_GARBAGE`));
    const results = await runSep10Checks({ domain, toml, network: "testnet" });
    const subCheck = results.find((r) => r.id === "sep10.jwt_subject");
    expect(subCheck?.status).toBe("fail");
    expect(subCheck?.message).toContain("expected exact");
  });

  it("passes when sub is a valid muxed account (M...) corresponding to the client account", async () => {
    setupAuthMock((account) => {
      const muxed = new MuxedAccount(new Account(account, "0"), "12345");
      return fakeJwt(muxed.accountId());
    });
    const results = await runSep10Checks({ domain, toml, network: "testnet" });
    const subCheck = results.find((r) => r.id === "sep10.jwt_subject");
    expect(subCheck?.status).toBe("pass");
    expect(subCheck?.message).toContain("muxed account");
  });
});

describe("SEP-10 challenge nonce randomness and uniqueness", () => {
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

  function buildCustomChallenge(
    clientPublicKey: string,
    nonceValue: string | Buffer,
  ): string {
    const account = new Account(serverKeypair.publicKey(), "-1");
    const now = Math.floor(Date.now() / 1000);
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
      timebounds: { minTime: now, maxTime: now + 300 },
    })
      .addOperation(
        Operation.manageData({
          name: `${domain} auth`,
          value: nonceValue,
          source: clientPublicKey,
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
    tx.sign(serverKeypair);
    return tx.toXDR();
  }

  it("passes when nonces are unique and properly formatted across two requests", async () => {
    let callCount = 0;
    global.fetch = vi.fn(async (_input, init) => {
      if (!init || init.method === undefined) {
        const url = new URL(_input as string);
        if (url.pathname.includes(".well-known/jwks.json")) {
          return { ok: false, status: 404 } as Response;
        }
        callCount++;
        const account = url.searchParams.get("account")!;
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
        json: async () => ({ token: fakeJwt("any") }),
      } as Response;
    }) as unknown as typeof fetch;

    const results = await runSep10Checks({ domain, toml, network: "testnet" });
    expect(callCount).toBe(2);

    const formatCheck = results.find((r) => r.id === "sep10.challenge_nonce_format");
    const uniqueCheck = results.find((r) => r.id === "sep10.challenge_nonce_unique");

    expect(formatCheck?.status).toBe("pass");
    expect(uniqueCheck?.status).toBe("pass");
  });

  it("fails when identical nonces are returned across two requests (replay risk)", async () => {
    const fixedNonce = "cZgTAntdR+E4LnWI5FjXUWiz0WxqkDqUJsOmWVarS27y5214To8IbWgaEVLNuQSB";

    global.fetch = vi.fn(async (_input, init) => {
      if (!init || init.method === undefined) {
        const url = new URL(_input as string);
        const account = url.searchParams.get("account")!;
        const challengeXdr = buildCustomChallenge(account, fixedNonce);
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
        json: async () => ({ token: fakeJwt("any") }),
      } as Response;
    }) as unknown as typeof fetch;

    const results = await runSep10Checks({ domain, toml, network: "testnet" });
    const uniqueCheck = results.find((r) => r.id === "sep10.challenge_nonce_unique");
    expect(uniqueCheck?.status).toBe("fail");
    expect(uniqueCheck?.severity).toBe("error");
    expect(uniqueCheck?.message).toContain("REPLAY RISK");
  });

  it("fails when nonce is not a 64-character base64 string decoding to 48 bytes", async () => {
    global.fetch = vi.fn(async (_input, init) => {
      if (!init || init.method === undefined) {
        const url = new URL(_input as string);
        const account = url.searchParams.get("account")!;
        const shortNonce = "c2hvcnQtbm9uY2U="; // short base64
        const challengeXdr = buildCustomChallenge(account, shortNonce);
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
        json: async () => ({ token: fakeJwt("any") }),
      } as Response;
    }) as unknown as typeof fetch;

    const results = await runSep10Checks({ domain, toml, network: "testnet" });
    const formatCheck = results.find((r) => r.id === "sep10.challenge_nonce_format");
    expect(formatCheck?.status).toBe("fail");
    expect(formatCheck?.severity).toBe("error");
    expect(formatCheck?.message).toContain("Expected 64-character base64 nonce decoding to 48 bytes");
  });

  it("warns when nonce has low entropy (e.g. all identical bytes)", async () => {
    const lowEntropyBuf = Buffer.alloc(48, 0x41); // 48 'A's
    const lowEntropyNonce = lowEntropyBuf.toString("base64"); // 64 chars

    global.fetch = vi.fn(async (_input, init) => {
      if (!init || init.method === undefined) {
        const url = new URL(_input as string);
        const account = url.searchParams.get("account")!;
        const challengeXdr = buildCustomChallenge(account, lowEntropyNonce);
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
        json: async () => ({ token: fakeJwt("any") }),
      } as Response;
    }) as unknown as typeof fetch;

    const results = await runSep10Checks({ domain, toml, network: "testnet" });
    const formatCheck = results.find((r) => r.id === "sep10.challenge_nonce_format");
    expect(formatCheck?.status).toBe("warn");
    expect(formatCheck?.severity).toBe("warning");
    expect(formatCheck?.message).toContain("low-entropy data");
  });

  it("degrades to warn when second challenge request fails with network error", async () => {
    let getCount = 0;
    global.fetch = vi.fn(async (_input, init) => {
      if (!init || init.method === undefined) {
        getCount++;
        if (getCount === 1) {
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
          return {
            ok: true,
            status: 200,
            json: async () => ({
              transaction: challengeXdr,
              network_passphrase: Networks.TESTNET,
            }),
          } as Response;
        }
        throw new Error("Second request connection timeout");
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: fakeJwt("any") }),
      } as Response;
    }) as unknown as typeof fetch;

    const results = await runSep10Checks({ domain, toml, network: "testnet" });
    const uniqueCheck = results.find((r) => r.id === "sep10.challenge_nonce_unique");
    expect(uniqueCheck?.status).toBe("warn");
    expect(uniqueCheck?.severity).toBe("warning");
    expect(uniqueCheck?.message).toContain("second challenge request failed");
  });
});


