import { afterEach, describe, expect, it, vi } from "vitest";
import { runSep38Checks } from "../src/checks/sep38.js";
import type { StellarToml } from "../src/checks/sep1.js";

describe("runSep38Checks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const validToml: StellarToml = {
    raw: {
      ANCHOR_QUOTE_SERVER: "https://quote.example.com",
    },
    anchorQuoteServer: "https://quote.example.com",
  };

  it("passes all checks when endpoints conform to SEP-38 spec", async () => {
    const futureDate = new Date(Date.now() + 60_000).toISOString();

    global.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr === "https://quote.example.com/info") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            assets: [
              { asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
              { asset: "iso4217:USD" },
            ],
          }),
        } as unknown as Response;
      }
      if (urlStr === "https://quote.example.com/prices") {
        // Missing sell_asset and buy_asset -> rejected with 400
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: "Either sell_asset or buy_asset must be provided" }),
        } as unknown as Response;
      }
      if (urlStr.includes("not-a-valid-asset")) {
        // Malformed asset -> rejected with 400
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: "Invalid asset identifier" }),
        } as unknown as Response;
      }
      if (urlStr.startsWith("https://quote.example.com/prices?sell_asset=")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            buy_tokens: [
              {
                asset: "iso4217:USD",
                price: "1.00",
                decimals: 2,
              },
            ],
          }),
        } as unknown as Response;
      }
      if (urlStr.startsWith("https://quote.example.com/price?")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            total_price: "1.02",
            price: "1.02",
            sell_amount: "100.00",
            buy_amount: "98.0392",
            fee: {
              total: "0.00",
              asset: "iso4217:USD",
            },
            expires_at: futureDate,
          }),
        } as unknown as Response;
      }
      if (urlStr === "https://quote.example.com/quote") {
        // Unauthenticated POST /quote (no jwt supplied in this test).
        return {
          ok: false,
          status: 403,
          json: async () => ({ error: "Missing or invalid Authorization header" }),
        } as unknown as Response;
      }
      throw new Error(`Unexpected url: ${urlStr}`);
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
    });

    expect(results.length).toBeGreaterThan(0);
    const failures = results.filter((r) => r.status === "fail");
    expect(failures).toHaveLength(0);

    const nonSkippedQuoteChecks = results.filter(
      (r) => r.id.startsWith("sep38.quote_") && r.id !== "sep38.quote_unauthenticated",
    );
    expect(nonSkippedQuoteChecks.every((r) => r.status === "warn")).toBe(true);

    const unauthCheck = results.find((r) => r.id === "sep38.quote_unauthenticated");
    expect(unauthCheck?.status).toBe("pass");
  });

  it("skips checks when ANCHOR_QUOTE_SERVER is missing", async () => {
    const tomlWithoutQuote: StellarToml = { raw: {} };
    const results = await runSep38Checks({
      domain: "example.com",
      toml: tomlWithoutQuote,
      network: "testnet",
    });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("sep38.skipped");
    expect(results[0].status).toBe("warn");
  });

  it("fails when GET /prices does not require sell_asset or buy_asset", async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr === "https://quote.example.com/info") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            assets: [{ asset: "iso4217:USD" }],
          }),
        } as unknown as Response;
      }
      if (urlStr === "https://quote.example.com/prices") {
        // Unexpectedly returns 200 instead of 400
        return {
          ok: true,
          status: 200,
          json: async () => ({ buy_tokens: [] }),
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: "error" }),
      } as unknown as Response;
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
    });

    const missingAssetsCheck = results.find(
      (r) => r.id === "sep38.prices_missing_assets",
    );
    expect(missingAssetsCheck?.status).toBe("fail");
  });

  it("fails when GET /prices does not reject malformed asset identifiers", async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr === "https://quote.example.com/info") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ assets: [{ asset: "iso4217:USD" }] }),
        } as unknown as Response;
      }
      if (urlStr === "https://quote.example.com/prices") {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: "missing param" }),
        } as unknown as Response;
      }
      if (urlStr.includes("not-a-valid-asset")) {
        // Incorrectly accepts malformed asset
        return {
          ok: true,
          status: 200,
          json: async () => ({ buy_tokens: [] }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ buy_tokens: [] }),
      } as unknown as Response;
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
    });

    const malformedCheck = results.find(
      (r) => r.id === "sep38.prices_malformed_asset",
    );
    expect(malformedCheck?.status).toBe("fail");
  });

  it("fails when prices returned in /prices are non-positive numbers", async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr === "https://quote.example.com/info") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ assets: [{ asset: "iso4217:USD" }] }),
        } as unknown as Response;
      }
      if (urlStr === "https://quote.example.com/prices") {
        return { ok: false, status: 400 } as unknown as Response;
      }
      if (urlStr.includes("not-a-valid-asset")) {
        return { ok: false, status: 400 } as unknown as Response;
      }
      if (urlStr.startsWith("https://quote.example.com/prices?sell_asset=")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            buy_tokens: [
              {
                asset: "iso4217:USD",
                price: "-0.50",
                decimals: 2,
              },
            ],
          }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          total_price: "1.00",
          price: "1.00",
          sell_amount: "10",
          buy_amount: "10",
          fee: { total: "0", asset: "iso4217:USD" },
        }),
      } as unknown as Response;
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
    });

    const pricesPosCheck = results.find(
      (r) => r.id === "sep38.prices_positive",
    );
    expect(pricesPosCheck?.status).toBe("fail");
  });

  it("fails when /price expires_at timestamp is in the past", async () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString();

    global.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr === "https://quote.example.com/info") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            assets: [
              { asset: "iso4217:USD" },
              { asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
            ],
          }),
        } as unknown as Response;
      }
      if (urlStr === "https://quote.example.com/prices") {
        return { ok: false, status: 400 } as unknown as Response;
      }
      if (urlStr.includes("not-a-valid-asset")) {
        return { ok: false, status: 400 } as unknown as Response;
      }
      if (urlStr.startsWith("https://quote.example.com/prices?sell_asset=")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            buy_tokens: [{ asset: "iso4217:USD", price: "1.00", decimals: 2 }],
          }),
        } as unknown as Response;
      }
      if (urlStr.startsWith("https://quote.example.com/price?")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            total_price: "1.00",
            price: "1.00",
            sell_amount: "10",
            buy_amount: "10",
            fee: { total: "0", asset: "iso4217:USD" },
            expires_at: pastDate,
          }),
        } as unknown as Response;
      }
      throw new Error(`Unexpected url: ${urlStr}`);
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
    });

    const expiresAtCheck = results.find(
      (r) => r.id === "sep38.price_expires_at",
    );
    expect(expiresAtCheck?.status).toBe("fail");
  });

  it("fails fast when /info request exceeds configured timeoutMs", async () => {
    global.fetch = vi.fn().mockImplementation(async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = (init as RequestInit)?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
      timeoutMs: 25,
    });
    const infoCheck = results.find((r) => r.id === "sep38.info");
    expect(infoCheck?.status).toBe("fail");
    expect(infoCheck?.message).toContain("timed out after 25ms");
  });

  it("sends sell_amount in GET /prices and handles buy_assets format", async () => {
    let capturedPricesUrl: string | undefined;

    global.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr === "https://quote.example.com/info") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            assets: [
              { asset: "iso4217:USD" },
              { asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
            ],
          }),
        } as unknown as Response;
      }
      if (urlStr === "https://quote.example.com/prices") {
        return { ok: false, status: 400 } as unknown as Response;
      }
      if (urlStr.includes("not-a-valid-asset")) {
        return { ok: false, status: 400 } as unknown as Response;
      }
      if (urlStr.startsWith("https://quote.example.com/prices?")) {
        capturedPricesUrl = urlStr;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            buy_assets: [
              {
                asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
                price: "1.00",
                decimals: 7,
              },
            ],
          }),
        } as unknown as Response;
      }
      if (urlStr.startsWith("https://quote.example.com/price?")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            total_price: "1.00",
            price: "1.00",
            sell_amount: "100",
            buy_amount: "100",
            fee: { total: "0", asset: "iso4217:USD" },
          }),
        } as unknown as Response;
      }
      throw new Error(`Unexpected url: ${urlStr}`);
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
    });

    expect(capturedPricesUrl).toBeDefined();
    expect(capturedPricesUrl).toContain("sell_amount=100");
    expect(capturedPricesUrl).toContain("sell_asset=iso4217%3AUSD");

    const pricesSchemaCheck = results.find((r) => r.id === "sep38.prices_schema");
    expect(pricesSchemaCheck?.status).toBe("pass");

    const pricesPosCheck = results.find((r) => r.id === "sep38.prices_positive");
    expect(pricesPosCheck?.status).toBe("pass");
  });

  it("surfaces client request parameter error on 400 without reporting anchor schema failure", async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr === "https://quote.example.com/info") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            assets: [
              { asset: "iso4217:USD" },
              { asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
            ],
          }),
        } as unknown as Response;
      }
      if (urlStr === "https://quote.example.com/prices") {
        return { ok: false, status: 400 } as unknown as Response;
      }
      if (urlStr.includes("not-a-valid-asset")) {
        return { ok: false, status: 400 } as unknown as Response;
      }
      if (urlStr.startsWith("https://quote.example.com/prices?")) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: 'The "sell_amount" parameter is missing.' }),
        } as unknown as Response;
      }
      if (urlStr.startsWith("https://quote.example.com/price?")) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: "Unsupported context. Should be one of [sep6, sep31]." }),
        } as unknown as Response;
      }
      throw new Error(`Unexpected url: ${urlStr}`);
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
    });

    const pricesReqError = results.find((r) => r.id === "sep38.prices_request_error");
    expect(pricesReqError?.status).toBe("warn");
    expect(pricesReqError?.message).toContain("sell_amount");

    const pricesSchemaCheck = results.find((r) => r.id === "sep38.prices_schema");
    expect(pricesSchemaCheck?.status).toBe("warn");
    expect(pricesSchemaCheck?.message).toContain("Skipped");

    const priceReqError = results.find((r) => r.id === "sep38.price_request_error");
    expect(priceReqError?.status).toBe("warn");
    expect(priceReqError?.message).toContain("Unsupported context");

    const priceSchemaCheck = results.find((r) => r.id === "sep38.price_schema");
    expect(priceSchemaCheck?.status).toBe("warn");
    expect(priceSchemaCheck?.message).toContain("Skipped");
  });

  it("does not pair asset with itself when only one asset is advertised in /info", async () => {
    let priceEndpointCalled = false;

    global.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr === "https://quote.example.com/info") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            assets: [{ asset: "stellar:native" }],
          }),
        } as unknown as Response;
      }
      if (urlStr === "https://quote.example.com/prices" || urlStr.includes("not-a-valid-asset")) {
        return { ok: false, status: 400 } as unknown as Response;
      }
      if (urlStr.startsWith("https://quote.example.com/prices?")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ buy_assets: [] }),
        } as unknown as Response;
      }
      if (urlStr.startsWith("https://quote.example.com/price?")) {
        priceEndpointCalled = true;
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }
      throw new Error(`Unexpected url: ${urlStr}`);
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
    });

    expect(priceEndpointCalled).toBe(false);
    const priceSchemaCheck = results.find((r) => r.id === "sep38.price_schema");
    expect(priceSchemaCheck?.status).toBe("warn");
    expect(priceSchemaCheck?.message).toContain("at least two distinct assets are required");
  });

  const jwt = "fake.jwt.token";
  const sellAssetId = "iso4217:USD";
  const buyAssetId = "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

  function makeFetchMock(handlers: {
    quotePost?: (body: any, hasAuth: boolean) => Response | Promise<Response>;
    quoteGet?: (id: string) => Response | Promise<Response>;
  }) {
    return vi.fn().mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      const method = init?.method ?? "GET";

      if (urlStr === "https://quote.example.com/info") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ assets: [{ asset: sellAssetId }, { asset: buyAssetId }] }),
        } as unknown as Response;
      }
      if (urlStr === "https://quote.example.com/prices") {
        return { ok: false, status: 400, json: async () => ({ error: "missing" }) } as unknown as Response;
      }
      if (urlStr.includes("not-a-valid-asset")) {
        return { ok: false, status: 400 } as unknown as Response;
      }
      if (urlStr.startsWith("https://quote.example.com/prices?")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ buy_assets: [{ asset: buyAssetId, price: "1.00", decimals: 7 }] }),
        } as unknown as Response;
      }
      if (urlStr.startsWith("https://quote.example.com/price?")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            total_price: "1.00",
            price: "1.00",
            sell_amount: "100",
            buy_amount: "100",
            fee: { total: "0", asset: sellAssetId },
            expires_at: new Date(Date.now() + 60_000).toISOString(),
          }),
        } as unknown as Response;
      }
      if (urlStr === "https://quote.example.com/quote" && method === "POST") {
        const hasAuth = Boolean((init?.headers as Record<string, string> | undefined)?.Authorization);
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (handlers.quotePost) return handlers.quotePost(body, hasAuth);
        throw new Error("quotePost handler not provided for this test");
      }
      if (urlStr.startsWith("https://quote.example.com/quote/")) {
        const id = decodeURIComponent(urlStr.split("https://quote.example.com/quote/")[1]);
        if (handlers.quoteGet) return handlers.quoteGet(id);
        throw new Error("quoteGet handler not provided for this test");
      }
      throw new Error(`Unexpected request: ${method} ${urlStr}`);
    });
  }

  it("passes the full firm-quote flow: create, refetch, and both negative cases", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const quoteId = "de762cda-a193-4961-861e-57b31fed6eb3";

    global.fetch = makeFetchMock({
      quotePost: (_body, hasAuth) => {
        if (!hasAuth) {
          return {
            ok: false,
            status: 403,
            json: async () => ({ error: "Missing Authorization header" }),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: quoteId,
            expires_at: expiresAt,
            total_price: "5.42",
            price: "5.00",
            sell_asset: sellAssetId,
            sell_amount: "542",
            buy_asset: buyAssetId,
            buy_amount: "100",
            fee: { total: "42.00", asset: sellAssetId },
          }),
        } as unknown as Response;
      },
      quoteGet: (id) => {
        if (id === quoteId) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ id, price: "5.00", expires_at: expiresAt }),
          } as unknown as Response;
        }
        return { ok: false, status: 404, json: async () => ({ error: "Quote not found" }) } as unknown as Response;
      },
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const quoteChecks = results.filter((r) => r.id.startsWith("sep38.quote"));
    expect(quoteChecks.length).toBe(6);
    expect(quoteChecks.every((r) => r.status === "pass")).toBe(true);
  });

  it("skips authenticated quote checks with a warn when no JWT is available", async () => {
    global.fetch = makeFetchMock({
      quotePost: (_body, hasAuth) => {
        expect(hasAuth).toBe(false);
        return {
          ok: false,
          status: 401,
          json: async () => ({ error: "Unauthorized" }),
        } as unknown as Response;
      },
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
    });

    const unauthCheck = results.find((r) => r.id === "sep38.quote_unauthenticated");
    expect(unauthCheck?.status).toBe("pass");

    for (const id of [
      "sep38.quote_schema",
      "sep38.quote_positive",
      "sep38.quote_expires_at",
      "sep38.quote_get_matches",
      "sep38.quote_get_nonexistent",
    ]) {
      const check = results.find((r) => r.id === id);
      expect(check?.status).toBe("warn");
      expect(check?.message).toContain("SEP-10 JWT required");
    }
  });

  it("skips mutating quote checks with a warn under --no-write, but still runs GET /quote/{id} 404 check", async () => {
    global.fetch = makeFetchMock({
      quoteGet: () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response,
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
      jwt,
      noWrite: true,
    });

    for (const id of [
      "sep38.quote_unauthenticated",
      "sep38.quote_schema",
      "sep38.quote_positive",
      "sep38.quote_expires_at",
      "sep38.quote_get_matches",
    ]) {
      const check = results.find((r) => r.id === id);
      expect(check?.status).toBe("warn");
      expect(check?.message).toContain("--no-write");
    }

    const nonexistentCheck = results.find((r) => r.id === "sep38.quote_get_nonexistent");
    expect(nonexistentCheck?.status).toBe("pass");
  });

  it("fails quote_unauthenticated as an AUTHENTICATION BYPASS when the anchor issues a quote without a JWT", async () => {
    global.fetch = makeFetchMock({
      quotePost: (_body, hasAuth) => {
        if (!hasAuth) {
          return {
            ok: true,
            status: 201,
            json: async () => ({ id: "should-not-exist" }),
          } as unknown as Response;
        }
        return { ok: false, status: 500 } as unknown as Response;
      },
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const unauthCheck = results.find((r) => r.id === "sep38.quote_unauthenticated");
    expect(unauthCheck?.status).toBe("fail");
    expect(unauthCheck?.message).toContain("AUTHENTICATION BYPASS");
  });

  it("warns quote_unauthenticated when the anchor returns an ambiguous status for an unauthenticated request", async () => {
    global.fetch = makeFetchMock({
      quotePost: (_body, hasAuth) => {
        if (!hasAuth) {
          return { ok: false, status: 500 } as unknown as Response;
        }
        return { ok: false, status: 500 } as unknown as Response;
      },
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const unauthCheck = results.find((r) => r.id === "sep38.quote_unauthenticated");
    expect(unauthCheck?.status).toBe("warn");
    expect(unauthCheck?.message).toContain("inconclusive");
  });

  it("fails quote_schema when the POST /quote response is missing required fields", async () => {
    global.fetch = makeFetchMock({
      quotePost: (_body, hasAuth) => {
        if (!hasAuth) return { ok: false, status: 403 } as unknown as Response;
        return {
          ok: true,
          status: 201,
          json: async () => ({ id: "q1", price: "5.00" }),
        } as unknown as Response;
      },
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const schemaCheck = results.find((r) => r.id === "sep38.quote_schema");
    expect(schemaCheck?.status).toBe("fail");
    expect(schemaCheck?.message).toContain("missing required fields");

    const getMatchesCheck = results.find((r) => r.id === "sep38.quote_get_matches");
    expect(getMatchesCheck?.status).toBe("warn");
    expect(getMatchesCheck?.message).toContain("did not return a usable id");
  });

  it("fails quote_positive when price or total_price is non-positive", async () => {
    global.fetch = makeFetchMock({
      quotePost: (_body, hasAuth) => {
        if (!hasAuth) return { ok: false, status: 403 } as unknown as Response;
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: "q1",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            total_price: "-1.00",
            price: "5.00",
            sell_asset: sellAssetId,
            sell_amount: "542",
            buy_asset: buyAssetId,
            buy_amount: "100",
            fee: { total: "42.00", asset: sellAssetId },
          }),
        } as unknown as Response;
      },
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const positiveCheck = results.find((r) => r.id === "sep38.quote_positive");
    expect(positiveCheck?.status).toBe("fail");
    expect(positiveCheck?.message).toContain("must all be positive");
  });

  it("fails quote_positive when returned amounts are inconsistent with the quoted price", async () => {
    global.fetch = makeFetchMock({
      quotePost: (_body, hasAuth) => {
        if (!hasAuth) return { ok: false, status: 403 } as unknown as Response;
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: "q1",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            // total_price * buy_amount (5.42 * 100 = 542) does not equal sell_amount (999)
            total_price: "5.42",
            price: "5.00",
            sell_asset: sellAssetId,
            sell_amount: "999",
            buy_asset: buyAssetId,
            buy_amount: "100",
            fee: { total: "42.00", asset: sellAssetId },
          }),
        } as unknown as Response;
      },
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const positiveCheck = results.find((r) => r.id === "sep38.quote_positive");
    expect(positiveCheck?.status).toBe("fail");
    expect(positiveCheck?.message).toContain("inconsistent with the quoted price");
  });

  it("validates fee-in-buy-asset price consistency using the alternate SEP-38 formula", async () => {
    global.fetch = makeFetchMock({
      quotePost: (_body, hasAuth) => {
        if (!hasAuth) return { ok: false, status: 403 } as unknown as Response;
        return {
          ok: true,
          status: 201,
          // fee.asset is the requested buy_asset here, so the applicable formula is
          // sell_amount = price * (buy_amount + fee) => 105 = 1.00 * (100 + 5)
          json: async () => ({
            id: "q1",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            total_price: "1.05", // 105/100
            price: "1.00",
            sell_asset: sellAssetId,
            sell_amount: "105",
            buy_asset: buyAssetId,
            buy_amount: "100",
            fee: { total: "5", asset: buyAssetId },
          }),
        } as unknown as Response;
      },
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const positiveCheck = results.find((r) => r.id === "sep38.quote_positive");
    expect(positiveCheck?.status).toBe("pass");
  });

  it("fails quote_expires_at when the field is missing from POST /quote", async () => {
    global.fetch = makeFetchMock({
      quotePost: (_body, hasAuth) => {
        if (!hasAuth) return { ok: false, status: 403 } as unknown as Response;
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: "q1",
            total_price: "5.42",
            price: "5.00",
            sell_asset: sellAssetId,
            sell_amount: "542",
            buy_asset: buyAssetId,
            buy_amount: "100",
            fee: { total: "42.00", asset: sellAssetId },
          }),
        } as unknown as Response;
      },
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const expiresCheck = results.find((r) => r.id === "sep38.quote_expires_at");
    expect(expiresCheck?.status).toBe("fail");
    expect(expiresCheck?.message).toContain("required");

    // The schema check should also fail since expires_at is a required field.
    const schemaCheck = results.find((r) => r.id === "sep38.quote_schema");
    expect(schemaCheck?.status).toBe("fail");
  });

  it("fails quote_expires_at when the firm quote is already expired", async () => {
    global.fetch = makeFetchMock({
      quotePost: (_body, hasAuth) => {
        if (!hasAuth) return { ok: false, status: 403 } as unknown as Response;
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: "q1",
            expires_at: new Date(Date.now() - 60_000).toISOString(),
            total_price: "5.42",
            price: "5.00",
            sell_asset: sellAssetId,
            sell_amount: "542",
            buy_asset: buyAssetId,
            buy_amount: "100",
            fee: { total: "42.00", asset: sellAssetId },
          }),
        } as unknown as Response;
      },
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const expiresCheck = results.find((r) => r.id === "sep38.quote_expires_at");
    expect(expiresCheck?.status).toBe("fail");
    expect(expiresCheck?.message).toContain("must be in the future");
  });

  it("fails quote_get_matches when GET /quote/{id} returns a different price than POST /quote created", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    global.fetch = makeFetchMock({
      quotePost: (_body, hasAuth) => {
        if (!hasAuth) return { ok: false, status: 403 } as unknown as Response;
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: "q1",
            expires_at: expiresAt,
            total_price: "5.42",
            price: "5.00",
            sell_asset: sellAssetId,
            sell_amount: "542",
            buy_asset: buyAssetId,
            buy_amount: "100",
            fee: { total: "42.00", asset: sellAssetId },
          }),
        } as unknown as Response;
      },
      quoteGet: (id) => {
        if (id === "q1") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ id, price: "999.00", expires_at: expiresAt }),
          } as unknown as Response;
        }
        return { ok: false, status: 404 } as unknown as Response;
      },
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const getMatchesCheck = results.find((r) => r.id === "sep38.quote_get_matches");
    expect(getMatchesCheck?.status).toBe("fail");
    expect(getMatchesCheck?.message).toContain("price (expected 5.00, got 999.00)");
  });

  it("fails quote_get_nonexistent when the anchor returns a quote body for a nonexistent id", async () => {
    global.fetch = makeFetchMock({
      quotePost: (_body, hasAuth) => {
        if (!hasAuth) return { ok: false, status: 403 } as unknown as Response;
        return { ok: false, status: 500 } as unknown as Response;
      },
      quoteGet: () =>
        ({ ok: true, status: 200, json: async () => ({ id: "unexpected" }) }) as unknown as Response,
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const nonexistentCheck = results.find((r) => r.id === "sep38.quote_get_nonexistent");
    expect(nonexistentCheck?.status).toBe("fail");
    expect(nonexistentCheck?.message).toContain("expected HTTP 404");
  });

  it("warns quote-creation checks when POST /quote is rejected for an unsupported delivery-method parameter", async () => {
    global.fetch = makeFetchMock({
      quotePost: (_body, hasAuth) => {
        if (!hasAuth) return { ok: false, status: 403 } as unknown as Response;
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: "buy_delivery_method is required for this asset" }),
        } as unknown as Response;
      },
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
      jwt,
    });

    for (const id of ["sep38.quote_schema", "sep38.quote_positive", "sep38.quote_expires_at"]) {
      const check = results.find((r) => r.id === id);
      expect(check?.status).toBe("warn");
      expect(check?.message).toContain("delivery_method");
    }
  });

  it("fails quote-creation checks when POST /quote returns an unrecognized 4xx error", async () => {
    global.fetch = makeFetchMock({
      quotePost: (_body, hasAuth) => {
        if (!hasAuth) return { ok: false, status: 403 } as unknown as Response;
        return {
          ok: false,
          status: 422,
          json: async () => ({ error: "Unprocessable entity" }),
        } as unknown as Response;
      },
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
      jwt,
    });

    for (const id of ["sep38.quote_schema", "sep38.quote_positive", "sep38.quote_expires_at"]) {
      const check = results.find((r) => r.id === id);
      expect(check?.status).toBe("fail");
      expect(check?.message).toContain("422");
      expect(check?.message).toContain("Unprocessable entity");
    }
  });

  it("fails quote_expires_at when the field is not a valid ISO 8601 string", async () => {
    global.fetch = makeFetchMock({
      quotePost: (_body, hasAuth) => {
        if (!hasAuth) return { ok: false, status: 403 } as unknown as Response;
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: "q1",
            expires_at: "not-a-real-date",
            total_price: "5.42",
            price: "5.00",
            sell_asset: sellAssetId,
            sell_amount: "542",
            buy_asset: buyAssetId,
            buy_amount: "100",
            fee: { total: "42.00", asset: sellAssetId },
          }),
        } as unknown as Response;
      },
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const expiresCheck = results.find((r) => r.id === "sep38.quote_expires_at");
    expect(expiresCheck?.status).toBe("fail");
    expect(expiresCheck?.message).toContain("not a valid ISO 8601");
  });

  it("fails quote_get_matches when GET /quote/{id} returns a non-2xx status", async () => {
    global.fetch = makeFetchMock({
      quotePost: (_body, hasAuth) => {
        if (!hasAuth) return { ok: false, status: 403 } as unknown as Response;
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: "q1",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            total_price: "5.42",
            price: "5.00",
            sell_asset: sellAssetId,
            sell_amount: "542",
            buy_asset: buyAssetId,
            buy_amount: "100",
            fee: { total: "42.00", asset: sellAssetId },
          }),
        } as unknown as Response;
      },
      quoteGet: () => ({ ok: false, status: 500 }) as unknown as Response,
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const getMatchesCheck = results.find((r) => r.id === "sep38.quote_get_matches");
    expect(getMatchesCheck?.status).toBe("fail");
    expect(getMatchesCheck?.message).toContain("returned HTTP 500");
  });

  it("fails quote_get_matches naming id and expires_at mismatches", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const wrongExpiresAt = new Date(Date.now() + 120_000).toISOString();

    global.fetch = makeFetchMock({
      quotePost: (_body, hasAuth) => {
        if (!hasAuth) return { ok: false, status: 403 } as unknown as Response;
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: "q1",
            expires_at: expiresAt,
            total_price: "5.42",
            price: "5.00",
            sell_asset: sellAssetId,
            sell_amount: "542",
            buy_asset: buyAssetId,
            buy_amount: "100",
            fee: { total: "42.00", asset: sellAssetId },
          }),
        } as unknown as Response;
      },
      quoteGet: () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ id: "different-id", price: "5.00", expires_at: wrongExpiresAt }),
        }) as unknown as Response,
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const getMatchesCheck = results.find((r) => r.id === "sep38.quote_get_matches");
    expect(getMatchesCheck?.status).toBe("fail");
    expect(getMatchesCheck?.message).toContain("id (expected q1, got different-id)");
    expect(getMatchesCheck?.message).toContain(`expires_at (expected ${expiresAt}, got ${wrongExpiresAt})`);
  });

  it("warns quote_get_nonexistent when the anchor returns an ambiguous status for a nonexistent id", async () => {
    global.fetch = makeFetchMock({
      quotePost: (_body, hasAuth) => {
        if (!hasAuth) return { ok: false, status: 403 } as unknown as Response;
        return { ok: false, status: 500 } as unknown as Response;
      },
      quoteGet: () => ({ ok: false, status: 500 }) as unknown as Response,
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const nonexistentCheck = results.find((r) => r.id === "sep38.quote_get_nonexistent");
    expect(nonexistentCheck?.status).toBe("warn");
    expect(nonexistentCheck?.message).toContain("inconclusive");
  });

  it("fails quote-creation checks with a network error message on fetch failure", async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      const method = init?.method ?? "GET";
      if (urlStr === "https://quote.example.com/info") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ assets: [{ asset: sellAssetId }, { asset: buyAssetId }] }),
        } as unknown as Response;
      }
      if (urlStr === "https://quote.example.com/prices") {
        return { ok: false, status: 400 } as unknown as Response;
      }
      if (urlStr.includes("not-a-valid-asset")) {
        return { ok: false, status: 400 } as unknown as Response;
      }
      if (urlStr.startsWith("https://quote.example.com/prices?")) {
        return { ok: true, status: 200, json: async () => ({ buy_assets: [] }) } as unknown as Response;
      }
      if (urlStr.startsWith("https://quote.example.com/price?")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            total_price: "1.00",
            price: "1.00",
            sell_amount: "100",
            buy_amount: "100",
            fee: { total: "0", asset: sellAssetId },
          }),
        } as unknown as Response;
      }
      if (urlStr === "https://quote.example.com/quote" && method === "POST") {
        const hasAuth = Boolean((init?.headers as Record<string, string> | undefined)?.Authorization);
        if (!hasAuth) return { ok: false, status: 403 } as unknown as Response;
        throw new Error("simulated network failure");
      }
      throw new Error(`Unexpected request: ${method} ${urlStr}`);
    });

    const results = await runSep38Checks({
      domain: "example.com",
      toml: validToml,
      network: "testnet",
      jwt,
    });

    for (const id of ["sep38.quote_schema", "sep38.quote_positive", "sep38.quote_expires_at"]) {
      const check = results.find((r) => r.id === id);
      expect(check?.status).toBe("fail");
      expect(check?.message).toContain("simulated network failure");
    }
  });
});

