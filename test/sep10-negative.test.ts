import { Keypair, Networks, WebAuth } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSep10NegativeChecks } from "../src/checks/sep10-negative.js";

function mockFetchResponse(response: Partial<Response>) {
  global.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

describe("SEP-10 negative-case challenge validation", () => {
  const serverKeypair = Keypair.random();
  const clientKeypair = Keypair.random();
  const webAuthEndpoint = "https://auth.example.com";
  const domain = "example.com";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeBaseChallenge(): string {
    return WebAuth.buildChallengeTx(
      serverKeypair,
      clientKeypair.publicKey(),
      domain,
      300,
      Networks.TESTNET,
      "auth.example.com",
    );
  }

  it("passes when anchor correctly rejects all four invalid challenge types with HTTP 400", async () => {
    mockFetchResponse({
      ok: false,
      status: 400,
      json: async () => ({ error: "Invalid challenge: bad signature or timebounds" }),
    } as Response);

    const results = await runSep10NegativeChecks({
      webAuthEndpoint,
      domain,
      network: "testnet",
      serverSigningKey: serverKeypair.publicKey(),
      challengeXdr: makeBaseChallenge(),
      clientKeypair,
    });

    expect(results.length).toBe(4);
    const expiredCheck = results.find((r) => r.id === "sep10.negative.expired");
    const wrongNetCheck = results.find((r) => r.id === "sep10.negative.wrong_network");
    const tamperedCheck = results.find((r) => r.id === "sep10.negative.tampered_payload");
    const missingSigCheck = results.find((r) => r.id === "sep10.negative.missing_client_sig");

    expect(expiredCheck?.status).toBe("pass");
    expect(expiredCheck?.message).toContain("Anchor correctly rejected expired challenge with HTTP 400");

    expect(wrongNetCheck?.status).toBe("pass");
    expect(wrongNetCheck?.message).toContain("Anchor correctly rejected wrong-network challenge with HTTP 400");

    expect(tamperedCheck?.status).toBe("pass");
    expect(tamperedCheck?.message).toContain("Anchor correctly rejected tampered challenge payload with HTTP 400");

    expect(missingSigCheck?.status).toBe("pass");
    expect(missingSigCheck?.message).toContain("Anchor correctly rejected challenge without client signature with HTTP 400");
  });

  it("fails as AUTHENTICATION BYPASS when anchor wrongly accepts expired challenge", async () => {
    mockFetchResponse({
      ok: true,
      status: 200,
      json: async () => ({ token: "fake.jwt.token" }),
    } as Response);

    const results = await runSep10NegativeChecks({
      webAuthEndpoint,
      domain,
      network: "testnet",
      serverSigningKey: serverKeypair.publicKey(),
      challengeXdr: makeBaseChallenge(),
      clientKeypair,
    });

    const expiredCheck = results.find((r) => r.id === "sep10.negative.expired");
    expect(expiredCheck?.status).toBe("fail");
    expect(expiredCheck?.severity).toBe("error");
    expect(expiredCheck?.message).toContain("AUTHENTICATION BYPASS: Anchor accepted expired challenge");
  });

  it("fails as AUTHENTICATION BYPASS when anchor wrongly accepts wrong-network challenge", async () => {
    mockFetchResponse({
      ok: true,
      status: 200,
      json: async () => ({ token: "fake.jwt.token" }),
    } as Response);

    const results = await runSep10NegativeChecks({
      webAuthEndpoint,
      domain,
      network: "testnet",
      serverSigningKey: serverKeypair.publicKey(),
      challengeXdr: makeBaseChallenge(),
      clientKeypair,
    });

    const wrongNetCheck = results.find((r) => r.id === "sep10.negative.wrong_network");
    expect(wrongNetCheck?.status).toBe("fail");
    expect(wrongNetCheck?.severity).toBe("error");
    expect(wrongNetCheck?.message).toContain("AUTHENTICATION BYPASS: Anchor accepted wrong-network challenge");
  });

  it("fails as AUTHENTICATION BYPASS when anchor wrongly accepts tampered payload", async () => {
    mockFetchResponse({
      ok: true,
      status: 200,
      json: async () => ({ token: "fake.jwt.token" }),
    } as Response);

    const results = await runSep10NegativeChecks({
      webAuthEndpoint,
      domain,
      network: "testnet",
      serverSigningKey: serverKeypair.publicKey(),
      challengeXdr: makeBaseChallenge(),
      clientKeypair,
    });

    const tamperedCheck = results.find((r) => r.id === "sep10.negative.tampered_payload");
    expect(tamperedCheck?.status).toBe("fail");
    expect(tamperedCheck?.severity).toBe("error");
    expect(tamperedCheck?.message).toContain("AUTHENTICATION BYPASS: Anchor accepted tampered challenge payload");
  });

  it("fails as AUTHENTICATION BYPASS when anchor wrongly accepts missing client signature", async () => {
    mockFetchResponse({
      ok: true,
      status: 200,
      json: async () => ({ token: "fake.jwt.token" }),
    } as Response);

    const results = await runSep10NegativeChecks({
      webAuthEndpoint,
      domain,
      network: "testnet",
      serverSigningKey: serverKeypair.publicKey(),
      challengeXdr: makeBaseChallenge(),
      clientKeypair,
    });

    const missingSigCheck = results.find((r) => r.id === "sep10.negative.missing_client_sig");
    expect(missingSigCheck?.status).toBe("fail");
    expect(missingSigCheck?.severity).toBe("error");
    expect(missingSigCheck?.message).toContain("AUTHENTICATION BYPASS: Anchor accepted challenge without client signature");
  });

  it("distinguishes network errors and timeouts from rejections", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Connection timed out")) as unknown as typeof fetch;

    const results = await runSep10NegativeChecks({
      webAuthEndpoint,
      domain,
      network: "testnet",
      serverSigningKey: serverKeypair.publicKey(),
      challengeXdr: makeBaseChallenge(),
      clientKeypair,
    });

    const expiredCheck = results.find((r) => r.id === "sep10.negative.expired");
    expect(expiredCheck?.status).toBe("fail");
    expect(expiredCheck?.message).toContain("Endpoint unreachable or network error");
    expect(expiredCheck?.message).toContain("Connection timed out");
  });
});
