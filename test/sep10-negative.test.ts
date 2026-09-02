import {
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  WebAuth,
} from "@stellar/stellar-sdk";
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

  function runChecks() {
    return runSep10NegativeChecks({
      webAuthEndpoint,
      domain,
      network: "testnet",
      serverSigningKey: serverKeypair.publicKey(),
      challengeXdr: makeBaseChallenge(),
      clientKeypair,
    });
  }

  it("passes when the anchor cites the condition actually under test", async () => {
    // Reason mentions both expiry and the network passphrase, so both reason-checked
    // cases can confirm the condition they test was evaluated.
    mockFetchResponse({
      ok: false,
      status: 400,
      json: async () => ({
        error: "Challenge transaction has expired and its network passphrase is invalid",
      }),
    } as Response);

    const results = await runChecks();

    expect(results.length).toBe(4);
    const expiredCheck = results.find((r) => r.id === "sep10.negative.expired");
    const wrongNetCheck = results.find((r) => r.id === "sep10.negative.wrong_network");
    const tamperedCheck = results.find((r) => r.id === "sep10.negative.tampered_payload");
    const missingSigCheck = results.find((r) => r.id === "sep10.negative.missing_client_sig");

    expect(expiredCheck?.status).toBe("pass");
    expect(expiredCheck?.message).toContain("citing challenge expiry");

    expect(wrongNetCheck?.status).toBe("pass");
    expect(wrongNetCheck?.message).toContain("citing network passphrase validation");

    // Cases that reuse the anchor's real signed challenge stay conclusive on any 4xx.
    expect(tamperedCheck?.status).toBe("pass");
    expect(tamperedCheck?.message).toContain("Anchor correctly rejected tampered challenge payload with HTTP 400");

    expect(missingSigCheck?.status).toBe("pass");
    expect(missingSigCheck?.message).toContain("Anchor correctly rejected challenge without client signature with HTTP 400");
  });

  it("warns instead of passing when the anchor short-circuits on source account", async () => {
    // Verbatim rejection observed from testanchor.stellar.org: the anchor rejects the
    // forged challenge on source-account mismatch and never evaluates timebounds or
    // network passphrase. Reporting this as a pass would be a false pass.
    mockFetchResponse({
      ok: false,
      status: 400,
      json: async () => ({
        error: "Transaction source account is not equal to server's account.",
      }),
    } as Response);

    const results = await runChecks();

    const expiredCheck = results.find((r) => r.id === "sep10.negative.expired");
    expect(expiredCheck?.status).toBe("warn");
    expect(expiredCheck?.severity).toBe("warning");
    expect(expiredCheck?.message).toContain("Transaction source account is not equal");
    expect(expiredCheck?.message).toContain("challenge expiry was NOT verified");

    const wrongNetCheck = results.find((r) => r.id === "sep10.negative.wrong_network");
    expect(wrongNetCheck?.status).toBe("warn");
    expect(wrongNetCheck?.severity).toBe("warning");
    expect(wrongNetCheck?.message).toContain("network passphrase validation was NOT verified");

    // The two conclusive cases are unaffected by reason analysis.
    expect(results.find((r) => r.id === "sep10.negative.tampered_payload")?.status).toBe("pass");
    expect(results.find((r) => r.id === "sep10.negative.missing_client_sig")?.status).toBe("pass");
  });

  it("warns when the anchor rejects with no error message at all", async () => {
    mockFetchResponse({
      ok: false,
      status: 400,
      json: async () => ({}),
    } as Response);

    const results = await runChecks();

    const expiredCheck = results.find((r) => r.id === "sep10.negative.expired");
    expect(expiredCheck?.status).toBe("warn");
    expect(expiredCheck?.message).toContain("gave no error message");
    expect(expiredCheck?.message).toContain("challenge expiry was NOT verified");

    const wrongNetCheck = results.find((r) => r.id === "sep10.negative.wrong_network");
    expect(wrongNetCheck?.status).toBe("warn");
    expect(wrongNetCheck?.message).toContain("gave no error message");
  });

  it("reads the rejection reason from a message field when error is absent", async () => {
    mockFetchResponse({
      ok: false,
      status: 400,
      json: async () => ({ message: "challenge transaction is expired" }),
    } as Response);

    const results = await runChecks();

    const expiredCheck = results.find((r) => r.id === "sep10.negative.expired");
    expect(expiredCheck?.status).toBe("pass");
    expect(expiredCheck?.message).toContain("citing challenge expiry");
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

  it("fails when the anchor returns a 5xx instead of rejecting with a 4xx", async () => {
    mockFetchResponse({
      ok: false,
      status: 503,
      json: async () => ({ error: "upstream unavailable" }),
    } as Response);

    const results = await runChecks();

    const expiredCheck = results.find((r) => r.id === "sep10.negative.expired");
    expect(expiredCheck?.status).toBe("fail");
    expect(expiredCheck?.message).toContain("expected HTTP 4xx rejection");
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

  it("runs against mainnet, using the public passphrase and testnet as the opposite", async () => {
    mockFetchResponse({
      ok: false,
      status: 400,
      json: async () => ({
        error: "Challenge transaction has expired and its network passphrase is invalid",
      }),
    } as Response);

    const results = await runSep10NegativeChecks({
      webAuthEndpoint,
      domain,
      network: "mainnet",
      serverSigningKey: serverKeypair.publicKey(),
      challengeXdr: makeBaseChallenge(),
      clientKeypair,
    });

    expect(results.length).toBe(4);
    expect(results.find((r) => r.id === "sep10.negative.expired")?.status).toBe("pass");
    expect(results.find((r) => r.id === "sep10.negative.wrong_network")?.status).toBe("pass");
  });

  it("generates a client keypair when none is supplied", async () => {
    mockFetchResponse({
      ok: false,
      status: 400,
      json: async () => ({ error: "generic rejection" }),
    } as Response);

    const results = await runSep10NegativeChecks({
      webAuthEndpoint,
      domain,
      network: "testnet",
      serverSigningKey: serverKeypair.publicKey(),
      challengeXdr: makeBaseChallenge(),
    });

    expect(results.length).toBe(4);
    expect(results.every((r) => r.status !== undefined)).toBe(true);
  });

  it("falls back to the configured domain when webAuthEndpoint is not a parseable URL", async () => {
    mockFetchResponse({
      ok: false,
      status: 400,
      json: async () => ({ error: "generic rejection" }),
    } as Response);

    const results = await runSep10NegativeChecks({
      webAuthEndpoint: "not a valid url",
      domain,
      network: "testnet",
      serverSigningKey: serverKeypair.publicKey(),
      challengeXdr: makeBaseChallenge(),
      clientKeypair,
    });

    expect(results.find((r) => r.id === "sep10.negative.expired")?.status).not.toBe("fail");
    expect(results.find((r) => r.id === "sep10.negative.wrong_network")?.status).not.toBe("fail");
  });

  it("reports a construction failure for the expired-challenge case", async () => {
    mockFetchResponse({
      ok: false,
      status: 400,
      json: async () => ({ error: "generic rejection" }),
    } as Response);

    const baseXdr = makeBaseChallenge();
    const spy = vi
      .spyOn(Operation, "manageData")
      .mockImplementationOnce(() => {
        throw new Error("manageData boom");
      });

    const results = await runSep10NegativeChecks({
      webAuthEndpoint,
      domain,
      network: "testnet",
      serverSigningKey: serverKeypair.publicKey(),
      challengeXdr: baseXdr,
      clientKeypair,
    });

    spy.mockRestore();

    const expiredCheck = results.find((r) => r.id === "sep10.negative.expired");
    expect(expiredCheck?.status).toBe("fail");
    expect(expiredCheck?.message).toContain("Failed to construct expired challenge: manageData boom");
  });

  it("reports a construction failure for the wrong-network case", async () => {
    mockFetchResponse({
      ok: false,
      status: 400,
      json: async () => ({ error: "generic rejection" }),
    } as Response);

    const baseXdr = makeBaseChallenge();
    // WebAuth.buildChallengeTx itself is a non-configurable accessor export and can't be
    // spied on directly, so instead we force the parse step that immediately follows it
    // (inside the same try block) to throw.
    const spy = vi
      .spyOn(TransactionBuilder, "fromXDR")
      .mockImplementationOnce(() => {
        throw new Error("fromXDR boom");
      });

    const results = await runSep10NegativeChecks({
      webAuthEndpoint,
      domain,
      network: "testnet",
      serverSigningKey: serverKeypair.publicKey(),
      challengeXdr: baseXdr,
      clientKeypair,
    });

    spy.mockRestore();

    const wrongNetCheck = results.find((r) => r.id === "sep10.negative.wrong_network");
    expect(wrongNetCheck?.status).toBe("fail");
    expect(wrongNetCheck?.message).toContain("Failed to construct wrong-network challenge: fromXDR boom");
  });

  it("falls back to fetching a challenge when none is supplied, and fails tampered/missing-sig cases gracefully when the refetch yields nothing", async () => {
    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: "generic rejection" }),
        } as Response;
      }
      // The challenge-refetch GET: simulate the anchor refusing to issue one.
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
      } as Response;
    }) as unknown as typeof fetch;

    const results = await runSep10NegativeChecks({
      webAuthEndpoint,
      domain,
      network: "testnet",
      serverSigningKey: serverKeypair.publicKey(),
      clientKeypair,
    });

    expect(results.length).toBe(4);

    const tamperedCheck = results.find((r) => r.id === "sep10.negative.tampered_payload");
    expect(tamperedCheck?.status).toBe("fail");
    expect(tamperedCheck?.message).toContain("Failed to construct tampered challenge: No server challenge available to tamper");

    const missingSigCheck = results.find((r) => r.id === "sep10.negative.missing_client_sig");
    expect(missingSigCheck?.status).toBe("fail");
    expect(missingSigCheck?.message).toContain("Failed to test missing client signature: No server challenge available for unsigned submission");
  });

  it("uses a freshly-fetched challenge for tampered/missing-sig cases when the GET refetch succeeds", async () => {
    const fetchedXdr = makeBaseChallenge();
    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: "generic rejection" }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ transaction: fetchedXdr }),
      } as Response;
    }) as unknown as typeof fetch;

    const results = await runSep10NegativeChecks({
      webAuthEndpoint,
      domain,
      network: "testnet",
      serverSigningKey: serverKeypair.publicKey(),
      clientKeypair,
    });

    expect(results.length).toBe(4);
    expect(results.find((r) => r.id === "sep10.negative.tampered_payload")?.status).toBe("pass");
    expect(results.find((r) => r.id === "sep10.negative.missing_client_sig")?.status).toBe("pass");
  });

  it("silently ignores a network error during the challenge refetch, still reporting the other cases", async () => {
    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: "generic rejection" }),
        } as Response;
      }
      throw new Error("refetch network error");
    }) as unknown as typeof fetch;

    const results = await runSep10NegativeChecks({
      webAuthEndpoint,
      domain,
      network: "testnet",
      serverSigningKey: serverKeypair.publicKey(),
      clientKeypair,
    });

    expect(results.length).toBe(4);
    const tamperedCheck = results.find((r) => r.id === "sep10.negative.tampered_payload");
    expect(tamperedCheck?.status).toBe("fail");
    expect(tamperedCheck?.message).toContain("Failed to construct tampered challenge: No server challenge available to tamper");
  });
});
