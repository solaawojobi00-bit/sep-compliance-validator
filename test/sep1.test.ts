import { Networks } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchStellarToml, parseStellarToml } from "../src/checks/sep1.js";

function mockFetch(response: Partial<Response>) {
  const headers =
    response.headers ??
    new Headers({
      "access-control-allow-origin": "*",
      "content-type": "text/plain",
    });
  const defaultResponse = {
    headers,
    ...response,
  };
  global.fetch = vi.fn().mockResolvedValue(defaultResponse) as unknown as typeof fetch;
}

describe("fetchStellarToml", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes all checks for a well-formed stellar.toml", async () => {
    const toml = `
VERSION="2.0.0"
WEB_AUTH_ENDPOINT="https://example.com/auth"
SIGNING_KEY="GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
`;
    mockFetch({ ok: true, text: async () => toml } as Response);

    const { results, toml: parsed } = await fetchStellarToml("example.com");
    expect(parsed.version).toBe("2.0.0");
    expect(parsed.webAuthEndpoint).toBe("https://example.com/auth");
    expect(parsed.signingKey).toBe("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7");
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

describe("SEP-1 NETWORK_PASSPHRASE value validation", () => {
  it("fails when declared mainnet passphrase does not match testnet target", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "GABCXYZ"
WEB_AUTH_ENDPOINT = "https://auth.example.com"
NETWORK_PASSPHRASE = "${Networks.PUBLIC}"
`;
    const { results } = parseStellarToml(rawToml, "testnet");
    const check = results.find((r) => r.id === "sep1.network_passphrase_value");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain(Networks.PUBLIC);
    expect(check?.message).toContain(Networks.TESTNET);
    expect(check?.message).toContain("--network mainnet");
  });

  it("fails when declared testnet passphrase does not match mainnet target", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "GABCXYZ"
WEB_AUTH_ENDPOINT = "https://auth.example.com"
NETWORK_PASSPHRASE = "${Networks.TESTNET}"
`;
    const { results } = parseStellarToml(rawToml, "mainnet");
    const check = results.find((r) => r.id === "sep1.network_passphrase_value");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain(Networks.TESTNET);
    expect(check?.message).toContain(Networks.PUBLIC);
    expect(check?.message).toContain("--network testnet");
  });

  it("passes when declared passphrase matches target network", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "GABCXYZ"
WEB_AUTH_ENDPOINT = "https://auth.example.com"
NETWORK_PASSPHRASE = "${Networks.TESTNET}"
`;
    const { results } = parseStellarToml(rawToml, "testnet");
    const check = results.find((r) => r.id === "sep1.network_passphrase_value");
    expect(check?.status).toBe("pass");
  });

  it("maintains warn on presence and skips value check when NETWORK_PASSPHRASE is absent", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "GABCXYZ"
WEB_AUTH_ENDPOINT = "https://auth.example.com"
`;
    const { results } = parseStellarToml(rawToml, "testnet");
    const presenceCheck = results.find((r) => r.id === "sep1.network_passphrase");
    expect(presenceCheck?.status).toBe("warn");
    expect(results.some((r) => r.id === "sep1.network_passphrase_value")).toBe(false);
  });
});

describe("SEP-1 SIGNING_KEY and ACCOUNTS validation", () => {
  const validKey = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
  const validKey2 = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  const malformedKey = "GNOTVALIDED25519";

  it("passes when SIGNING_KEY is a well-formed Stellar ed25519 public key", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "${validKey}"
`;
    const { results } = parseStellarToml(rawToml);
    const check = results.find((r) => r.id === "sep1.signing_key_format");
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain(validKey);
  });

  it("fails when SIGNING_KEY is malformed", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "${malformedKey}"
`;
    const { results } = parseStellarToml(rawToml);
    const check = results.find((r) => r.id === "sep1.signing_key_format");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain(malformedKey);
    expect(check?.message).toContain("not a valid Stellar ed25519 public key");
  });

  it("skips signing_key_format check when SIGNING_KEY is absent", () => {
    const rawToml = `
VERSION = "2.0.0"
WEB_AUTH_ENDPOINT = "https://auth.example.com"
`;
    const { results } = parseStellarToml(rawToml);
    const presenceCheck = results.find((r) => r.id === "sep1.signing_key");
    expect(presenceCheck?.status).toBe("fail");
    expect(results.some((r) => r.id === "sep1.signing_key_format")).toBe(false);
  });

  it("validates ACCOUNTS when all entries are valid ed25519 keys", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "${validKey}"
ACCOUNTS = ["${validKey}", "${validKey2}"]
`;
    const { toml, results } = parseStellarToml(rawToml);
    expect(toml.accounts).toEqual([validKey, validKey2]);
    const check = results.find((r) => r.id === "sep1.accounts");
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain("All 2 ACCOUNTS are valid");
  });

  it("fails ACCOUNTS validation when entries contain invalid public keys", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "${validKey}"
ACCOUNTS = ["${validKey}", "not-a-valid-key", 12345]
`;
    const { toml, results } = parseStellarToml(rawToml);
    expect(toml.accounts).toEqual([validKey]);
    const check = results.find((r) => r.id === "sep1.accounts");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("index 1");
    expect(check?.message).toContain("index 2");
  });

  it("remains silent when ACCOUNTS is absent", () => {
    const rawToml = `
VERSION = "2.0.0"
SIGNING_KEY = "${validKey}"
`;
    const { results } = parseStellarToml(rawToml);
    expect(results.some((r) => r.id === "sep1.accounts")).toBe(false);
  });
});

describe("SEP-1 HTTP serving requirements and VERSION", () => {
  const validToml = `
VERSION = "2.0.0"
SIGNING_KEY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"
WEB_AUTH_ENDPOINT = "https://auth.example.com"
`;

  it("passes when VERSION is declared as a string", () => {
    const { results, toml } = parseStellarToml(validToml);
    expect(toml.version).toBe("2.0.0");
    const check = results.find((r) => r.id === "sep1.version");
    expect(check?.status).toBe("pass");
  });

  it("fails when VERSION is absent", () => {
    const tomlWithoutVersion = `
SIGNING_KEY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"
`;
    const { results } = parseStellarToml(tomlWithoutVersion);
    const check = results.find((r) => r.id === "sep1.version");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("VERSION is missing");
  });

  it("fails when VERSION is not a string", () => {
    const tomlWithNumericVersion = `
VERSION = 2
SIGNING_KEY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"
`;
    const { results } = parseStellarToml(tomlWithNumericVersion);
    const check = results.find((r) => r.id === "sep1.version");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("not a string");
  });

  it("passes CORS check when Access-Control-Allow-Origin is *", async () => {
    mockFetch({
      ok: true,
      headers: new Headers({
        "access-control-allow-origin": "*",
        "content-type": "text/plain",
      }),
      text: async () => validToml,
    } as Response);

    const { results } = await fetchStellarToml("example.com");
    const corsCheck = results.find((r) => r.id === "sep1.cors_header");
    expect(corsCheck?.status).toBe("pass");
  });

  it("fails CORS check when Access-Control-Allow-Origin is missing or not *", async () => {
    mockFetch({
      ok: true,
      headers: new Headers({
        "access-control-allow-origin": "https://example.com",
        "content-type": "text/plain",
      }),
      text: async () => validToml,
    } as Response);

    const { results } = await fetchStellarToml("example.com");
    const corsCheck = results.find((r) => r.id === "sep1.cors_header");
    expect(corsCheck?.status).toBe("fail");
    expect(corsCheck?.message).toContain('expected "*"');
  });

  it("passes Content-Type check when text/plain (with or without charset)", async () => {
    mockFetch({
      ok: true,
      headers: new Headers({
        "access-control-allow-origin": "*",
        "content-type": "text/plain; charset=utf-8",
      }),
      text: async () => validToml,
    } as Response);

    const { results } = await fetchStellarToml("example.com");
    const typeCheck = results.find((r) => r.id === "sep1.content_type");
    expect(typeCheck?.status).toBe("pass");
  });

  it("warns when Content-Type is not text/plain", async () => {
    mockFetch({
      ok: true,
      headers: new Headers({
        "access-control-allow-origin": "*",
        "content-type": "application/octet-stream",
      }),
      text: async () => validToml,
    } as Response);

    const { results } = await fetchStellarToml("example.com");
    const typeCheck = results.find((r) => r.id === "sep1.content_type");
    expect(typeCheck?.status).toBe("warn");
    expect(typeCheck?.message).toContain("application/octet-stream");
  });

  it("fails when file size exceeds 100KB", async () => {
    const hugeToml = validToml + "\n# " + "A".repeat(105 * 1024);
    mockFetch({
      ok: true,
      text: async () => hugeToml,
    } as Response);

    const { results } = await fetchStellarToml("example.com");
    const sizeCheck = results.find((r) => r.id === "sep1.file_size");
    expect(sizeCheck?.status).toBe("fail");
    expect(sizeCheck?.message).toContain("exceeds the 100KB limit");
  });

  it("surfaces final URL when request is redirected to another host", async () => {
    mockFetch({
      ok: true,
      url: "https://www.circle.com/.well-known/stellar.toml",
      text: async () => validToml,
    } as Response);

    const { results } = await fetchStellarToml("circle.com");
    const fetchCheck = results.find((r) => r.id === "sep1.fetch");
    expect(fetchCheck?.message).toContain("redirected to https://www.circle.com/.well-known/stellar.toml");
  });

  it("explicitly identifies HTML response when TOML parse fails", () => {
    const htmlBody = `<!DOCTYPE html><html><body><h1>404 Not Found</h1></body></html>`;
    const { results } = parseStellarToml(htmlBody);
    const parseCheck = results.find((r) => r.id === "sep1.parse");
    expect(parseCheck?.status).toBe("fail");
    expect(parseCheck?.message).toContain("Endpoint served HTML instead of a valid stellar.toml");
  });
});



