import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchStellarToml, parseStellarToml } from "../src/checks/sep1.js";

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

  it("fails fast when fetch exceeds the configured timeoutMs", async () => {
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

    const { results } = await fetchStellarToml("slow.example.com", 25);
    expect(results[0].status).toBe("fail");
    expect(results[0].message).toContain("timed out after 25ms");
  });
});

describe("SEP-1 declared service URL validation", () => {
  it("validates all declared valid HTTPS service endpoints", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "GABCXYZ"
WEB_AUTH_ENDPOINT = "https://auth.example.com"
ANCHOR_QUOTE_SERVER = "https://quote.example.com"
KYC_SERVER = "https://kyc.example.com"
TRANSFER_SERVER = "https://transfer.example.com"
TRANSFER_SERVER_SEP0024 = "https://sep24.example.com"
DIRECT_PAYMENT_SERVER = "https://direct.example.com"
JWKS_URI = "https://auth.example.com/.well-known/jwks.json"
`;
    const { toml, results } = parseStellarToml(rawToml);

    expect(toml.webAuthEndpoint).toBe("https://auth.example.com");
    expect(toml.anchorQuoteServer).toBe("https://quote.example.com");
    expect(toml.kycServer).toBe("https://kyc.example.com");
    expect(toml.transferServer).toBe("https://transfer.example.com");
    expect(toml.transferServerSep24).toBe("https://sep24.example.com");
    expect(toml.directPaymentServer).toBe("https://direct.example.com");
    expect(toml.jwksUri).toBe("https://auth.example.com/.well-known/jwks.json");

    const urlChecks = results.filter((r) => r.id.startsWith("sep1.url."));
    expect(urlChecks.length).toBe(7);
    expect(urlChecks.every((r) => r.status === "pass")).toBe(true);
  });

  it("fails when service endpoints use http:// scheme", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "GABCXYZ"
WEB_AUTH_ENDPOINT = "http://insecure.example.com/auth"
ANCHOR_QUOTE_SERVER = "http://insecure.example.com/quote"
`;
    const { results } = parseStellarToml(rawToml);

    const webAuthCheck = results.find((r) => r.id === "sep1.url.web_auth_endpoint");
    expect(webAuthCheck?.status).toBe("fail");
    expect(webAuthCheck?.message).toContain("must use the https: scheme");
    expect(webAuthCheck?.message).toContain("http://insecure.example.com/auth");

    const quoteCheck = results.find((r) => r.id === "sep1.url.anchor_quote_server");
    expect(quoteCheck?.status).toBe("fail");
    expect(quoteCheck?.message).toContain("must use the https: scheme");
    expect(quoteCheck?.message).toContain("http://insecure.example.com/quote");
  });

  it("fails when service endpoints are schemeless", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "GABCXYZ"
KYC_SERVER = "kyc.example.com/api"
TRANSFER_SERVER = "transfer.example.com"
`;
    const { results } = parseStellarToml(rawToml);

    const kycCheck = results.find((r) => r.id === "sep1.url.kyc_server");
    expect(kycCheck?.status).toBe("fail");
    expect(kycCheck?.message).toContain('KYC_SERVER "kyc.example.com/api" is not a valid absolute URL');

    const transferCheck = results.find((r) => r.id === "sep1.url.transfer_server");
    expect(transferCheck?.status).toBe("fail");
    expect(transferCheck?.message).toContain('TRANSFER_SERVER "transfer.example.com" is not a valid absolute URL');
  });

  it("fails when service endpoints contain unparseable garbage", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "GABCXYZ"
DIRECT_PAYMENT_SERVER = "https://[::1:invalid-ipv6"
`;
    const { results } = parseStellarToml(rawToml);

    const directCheck = results.find((r) => r.id === "sep1.url.direct_payment_server");
    expect(directCheck?.status).toBe("fail");
    expect(directCheck?.message).toContain("DIRECT_PAYMENT_SERVER");
    expect(directCheck?.message).toContain("is not a valid absolute URL");
  });

  it("remains silent when optional service endpoint fields are absent", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "GABCXYZ"
WEB_AUTH_ENDPOINT = "https://auth.example.com"
`;
    const { results } = parseStellarToml(rawToml);

    // Should NOT have checks for absent fields
    expect(results.some((r) => r.id === "sep1.url.anchor_quote_server")).toBe(false);
    expect(results.some((r) => r.id === "sep1.url.kyc_server")).toBe(false);
    expect(results.some((r) => r.id === "sep1.url.transfer_server")).toBe(false);
    expect(results.some((r) => r.id === "sep1.url.transfer_server_sep0024")).toBe(false);
    expect(results.some((r) => r.id === "sep1.url.direct_payment_server")).toBe(false);
    expect(results.some((r) => r.id === "sep1.url.jwks_uri")).toBe(false);
  });
});
