import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchStellarToml } from "../src/checks/sep1.js";

function mockFetch(response: Partial<Response>) {
  global.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

describe("fetchStellarToml", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes all checks for a well-formed stellar.toml", async () => {
    const toml = `
WEB_AUTH_ENDPOINT="https://example.com/auth"
SIGNING_KEY="GABCXYZ"
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
`;
    mockFetch({ ok: true, text: async () => toml } as Response);

    const { results, toml: parsed } = await fetchStellarToml("example.com");
    expect(parsed.webAuthEndpoint).toBe("https://example.com/auth");
    expect(parsed.signingKey).toBe("GABCXYZ");
    expect(results.every((r) => r.status === "pass")).toBe(true);
  });

  it("fails when the toml cannot be fetched", async () => {
    mockFetch({ ok: false, status: 404 } as Response);
    const { results } = await fetchStellarToml("missing.example.com");
    expect(results[0].status).toBe("fail");
  });

  it("fails when required fields are missing", async () => {
    mockFetch({
      ok: true,
      text: async () => 'FEDERATION_SERVER="https://example.com/federation"',
    } as Response);
    const { results } = await fetchStellarToml("example.com");
    const webAuth = results.find((r) => r.id === "sep1.web_auth_endpoint");
    const signing = results.find((r) => r.id === "sep1.signing_key");
    expect(webAuth?.status).toBe("fail");
    expect(signing?.status).toBe("fail");
  });

  it("warns when NETWORK_PASSPHRASE is missing but other fields are present", async () => {
    mockFetch({
      ok: true,
      text: async () =>
        'WEB_AUTH_ENDPOINT="https://example.com/auth"\nSIGNING_KEY="GABCXYZ"',
    } as Response);
    const { results } = await fetchStellarToml("example.com");
    const passphrase = results.find((r) => r.id === "sep1.network_passphrase");
    expect(passphrase?.status).toBe("warn");
  });

  it("fails on invalid TOML", async () => {
    mockFetch({ ok: true, text: async () => "this is not [valid toml" } as Response);
    const { results } = await fetchStellarToml("example.com");
    const parseCheck = results.find((r) => r.id === "sep1.parse");
    expect(parseCheck?.status).toBe("fail");
  });
});
