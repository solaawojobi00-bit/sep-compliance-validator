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
    expect(results.every((r) => r.status === "pass")).toBe(true);
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
});

