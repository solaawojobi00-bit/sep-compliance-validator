import { afterEach, describe, expect, it, vi } from "vitest";
import { runSep24Checks } from "../src/checks/sep24.js";
import type { StellarToml } from "../src/checks/sep1.js";

describe("runSep24Checks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const domain = "example.com";
  const jwt = "fake.jwt.token";
  const validToml: StellarToml = {
    raw: {
      TRANSFER_SERVER_SEP0024: "https://transfer.example.com/sep24",
    },
    transferServerSep24: "https://transfer.example.com/sep24",
  };

  it("passes all checks for a well-formed SEP-24 anchor", async () => {
    const transactionId = "tx_sep24_12345";
    const interactiveUrl = "https://interactive.example.com/deposit?id=" + transactionId;

    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();

      if (url === "https://transfer.example.com/sep24/info") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            deposit: {
              USDC: {
                enabled: true,
                min_amount: 1,
                max_amount: 1000,
              },
            },
            withdraw: {
              USDC: {
                enabled: true,
              },
            },
          }),
        } as Response;
      }

      if (url === "https://transfer.example.com/sep24/transactions/deposit/interactive") {
        const headers = init?.headers as Record<string, string>;
        expect(headers?.Authorization).toBe(`Bearer ${jwt}`);
        expect(init?.method).toBe("POST");

        return {
          ok: true,
          status: 200,
          json: async () => ({
            type: "interactive_customer_info_needed",
            url: interactiveUrl,
            id: transactionId,
          }),
        } as Response;
      }

      if (url === interactiveUrl) {
        return {
          ok: true,
          status: 200,
          text: async () => "<html>Interactive form</html>",
        } as Response;
      }

      if (url === `https://transfer.example.com/sep24/transaction?id=${transactionId}`) {
        const headers = init?.headers as Record<string, string>;
        expect(headers?.Authorization).toBe(`Bearer ${jwt}`);

        return {
          ok: true,
          status: 200,
          json: async () => ({
            transaction: {
              id: transactionId,
              status: "incomplete",
              kind: "deposit",
            },
          }),
        } as Response;
      }

      throw new Error(`Unexpected request to ${url}`);
    }) as unknown as typeof fetch;

    const results = await runSep24Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt,
    });

    expect(results).toHaveLength(4);
    expect(results.every((r) => r.status === "pass")).toBe(true);
  });

  it("skips checks when TRANSFER_SERVER_SEP0024 is missing", async () => {
    const results = await runSep24Checks({
      domain,
      toml: { raw: {} },
      network: "testnet",
      jwt,
    });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("sep24.skipped");
    expect(results[0].status).toBe("warn");
  });

  it("skips checks when JWT is missing", async () => {
    const results = await runSep24Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt: "",
    });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("sep24.skipped");
    expect(results[0].status).toBe("warn");
  });

  it("fails when /info has incorrectly-typed asset fields", async () => {
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.endsWith("/info")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            deposit: {
              USDC: {
                enabled: "yes", // should be boolean
                min_amount: "one", // should be number
              },
            },
          }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const results = await runSep24Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const infoCheck = results.find((r) => r.id === "sep24.info");
    expect(infoCheck?.status).toBe("fail");
  });

  it("fails when POST /transactions/deposit/interactive returns invalid type", async () => {
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.endsWith("/info")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ deposit: { USDC: { enabled: true } } }),
        } as Response;
      }
      if (url.endsWith("/transactions/deposit/interactive")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            type: "wrong_type",
            url: "https://example.com/interactive",
            id: "tx_123",
          }),
        } as Response;
      }
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;

    const results = await runSep24Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const depositCheck = results.find((r) => r.id === "sep24.deposit_interactive");
    expect(depositCheck?.status).toBe("fail");
  });

  it("fails when interactive URL is non-HTTPS or unreachable", async () => {
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.endsWith("/info")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ deposit: { USDC: { enabled: true } } }),
        } as Response;
      }
      if (url.endsWith("/transactions/deposit/interactive")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            type: "interactive_customer_info_needed",
            url: "http://insecure.example.com/form",
            id: "tx_123",
          }),
        } as Response;
      }
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;

    const results = await runSep24Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const urlCheck = results.find((r) => r.id === "sep24.interactive_url_reachable");
    expect(urlCheck?.status).toBe("fail");
  });

  it("fails when GET /transaction returns non-standard status", async () => {
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.endsWith("/info")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ deposit: { USDC: { enabled: true } } }),
        } as Response;
      }
      if (url.endsWith("/transactions/deposit/interactive")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            type: "interactive_customer_info_needed",
            url: "https://interactive.example.com/form",
            id: "tx_123",
          }),
        } as Response;
      }
      if (url === "https://interactive.example.com/form") {
        return { ok: true, status: 200 } as Response;
      }
      if (url.includes("/transaction?id=tx_123")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            transaction: {
              id: "tx_123",
              status: "NON_STANDARD_STATUS",
            },
          }),
        } as Response;
      }
      throw new Error(`Unexpected url: ${url}`);
    }) as unknown as typeof fetch;

    const results = await runSep24Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const txCheck = results.find((r) => r.id === "sep24.transaction_status");
    expect(txCheck?.status).toBe("fail");
  });

  it("fails fast when info request exceeds configured timeoutMs", async () => {
    global.fetch = vi.fn(async (_url, init) => {
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
    }) as unknown as typeof fetch;

    const results = await runSep24Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt,
      timeoutMs: 25,
    });
    const infoCheck = results.find((r) => r.id === "sep24.info");
    expect(infoCheck?.status).toBe("fail");
    expect(infoCheck?.message).toContain("timed out after 25ms");
  });
});

