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
            // Deposit-only in this fixture; the dedicated withdraw tests below cover
            // the withdraw flow itself.
            withdraw: {},
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

    const depositChecks = results.filter((r) => !r.id.startsWith("sep24.withdraw"));
    expect(depositChecks).toHaveLength(4);
    expect(depositChecks.every((r) => r.status === "pass")).toBe(true);

    const withdrawChecks = results.filter((r) => r.id.startsWith("sep24.withdraw"));
    expect(withdrawChecks).toHaveLength(3);
    expect(withdrawChecks.every((r) => r.status === "warn")).toBe(true);
    expect(withdrawChecks.every((r) => r.message.includes("deposit-only anchor is legitimate"))).toBe(true);
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

  it("passes a conformant withdraw flow with check ids distinct from the deposit ones", async () => {
    const depositTxId = "tx_deposit_1";
    const depositUrl = "https://interactive.example.com/deposit?id=" + depositTxId;
    const withdrawTxId = "tx_withdraw_1";
    const withdrawUrl = "https://interactive.example.com/withdraw?id=" + withdrawTxId;

    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";

      if (url === "https://transfer.example.com/sep24/info") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            deposit: { USDC: { enabled: true } },
            withdraw: { USDC: { enabled: true, min_amount: 1, max_amount: 500 } },
          }),
        } as Response;
      }
      if (url === "https://transfer.example.com/sep24/transactions/deposit/interactive" && method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            type: "interactive_customer_info_needed",
            url: depositUrl,
            id: depositTxId,
          }),
        } as Response;
      }
      if (url === "https://transfer.example.com/sep24/transactions/withdraw/interactive" && method === "POST") {
        const body = JSON.parse((init?.body as string) ?? "{}");
        expect(body.asset_code).toBe("USDC");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            type: "interactive_customer_info_needed",
            url: withdrawUrl,
            id: withdrawTxId,
          }),
        } as Response;
      }
      if (url === depositUrl || url === withdrawUrl) {
        return { ok: true, status: 200, text: async () => "<html>Interactive form</html>" } as Response;
      }
      if (url === `https://transfer.example.com/sep24/transaction?id=${depositTxId}`) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ transaction: { id: depositTxId, status: "incomplete" } }),
        } as Response;
      }
      if (url === `https://transfer.example.com/sep24/transaction?id=${withdrawTxId}`) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ transaction: { id: withdrawTxId, status: "pending_user_transfer_start" } }),
        } as Response;
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }) as unknown as typeof fetch;

    const results = await runSep24Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt,
    });

    expect(results.every((r) => r.status === "pass")).toBe(true);

    const withdrawInteractive = results.find((r) => r.id === "sep24.withdraw_interactive");
    expect(withdrawInteractive?.status).toBe("pass");
    expect(withdrawInteractive?.message).toContain(withdrawTxId);

    const withdrawUrlCheck = results.find((r) => r.id === "sep24.withdraw_interactive_url_reachable");
    expect(withdrawUrlCheck?.status).toBe("pass");

    const withdrawTxCheck = results.find((r) => r.id === "sep24.withdraw_transaction_status");
    expect(withdrawTxCheck?.status).toBe("pass");
    expect(withdrawTxCheck?.message).toContain("pending_user_transfer_start");

    // Deposit's own check ids must be unaffected and distinct.
    expect(results.find((r) => r.id === "sep24.deposit_interactive")?.status).toBe("pass");
    expect(results.find((r) => r.id === "sep24.interactive_url_reachable")?.status).toBe("pass");
    expect(results.find((r) => r.id === "sep24.transaction_status")?.status).toBe("pass");
  });

  it("fails withdraw_interactive when POST /transactions/withdraw/interactive returns a malformed response", async () => {
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";

      if (url === "https://transfer.example.com/sep24/info") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            deposit: { USDC: { enabled: true } },
            withdraw: { USDC: { enabled: true } },
          }),
        } as Response;
      }
      if (url === "https://transfer.example.com/sep24/transactions/deposit/interactive" && method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            type: "interactive_customer_info_needed",
            url: "https://interactive.example.com/deposit",
            id: "tx_deposit_1",
          }),
        } as Response;
      }
      if (url === "https://transfer.example.com/sep24/transactions/withdraw/interactive" && method === "POST") {
        // Missing url and wrong type
        return { ok: true, status: 200, json: async () => ({ type: "wrong_type", id: "tx_withdraw_1" }) } as Response;
      }
      if (url === "https://interactive.example.com/deposit") {
        return { ok: true, status: 200 } as Response;
      }
      if (url.includes("/transaction?id=tx_deposit_1")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ transaction: { id: "tx_deposit_1", status: "incomplete" } }),
        } as Response;
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }) as unknown as typeof fetch;

    const results = await runSep24Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const withdrawInteractive = results.find((r) => r.id === "sep24.withdraw_interactive");
    expect(withdrawInteractive?.status).toBe("fail");
    expect(withdrawInteractive?.message).toContain("wrong_type");

    const withdrawUrlCheck = results.find((r) => r.id === "sep24.withdraw_interactive_url_reachable");
    expect(withdrawUrlCheck?.status).toBe("fail");
    expect(withdrawUrlCheck?.message).toContain("no interactive URL");

    const withdrawTxCheck = results.find((r) => r.id === "sep24.withdraw_transaction_status");
    expect(withdrawTxCheck?.status).toBe("fail");
    expect(withdrawTxCheck?.message).toContain("no transaction ID");

    // Deposit's checks should still pass, unaffected by the withdraw failure.
    expect(results.find((r) => r.id === "sep24.deposit_interactive")?.status).toBe("pass");
  });

  it("skips all withdraw checks with a warn when /info advertises no enabled withdraw assets", async () => {
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";

      if (url === "https://transfer.example.com/sep24/info") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            deposit: { USDC: { enabled: true } },
            withdraw: { USDC: { enabled: false } },
          }),
        } as Response;
      }
      if (url === "https://transfer.example.com/sep24/transactions/deposit/interactive" && method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            type: "interactive_customer_info_needed",
            url: "https://interactive.example.com/deposit",
            id: "tx_deposit_1",
          }),
        } as Response;
      }
      if (url === "https://interactive.example.com/deposit") {
        return { ok: true, status: 200 } as Response;
      }
      if (url.includes("/transaction?id=tx_deposit_1")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ transaction: { id: "tx_deposit_1", status: "incomplete" } }),
        } as Response;
      }
      throw new Error(`Unexpected request: ${method} ${url} (withdraw should not be called at all)`);
    }) as unknown as typeof fetch;

    const results = await runSep24Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt,
    });

    for (const id of [
      "sep24.withdraw_interactive",
      "sep24.withdraw_interactive_url_reachable",
      "sep24.withdraw_transaction_status",
    ]) {
      const check = results.find((r) => r.id === id);
      expect(check?.status).toBe("warn");
      expect(check?.message).toContain("no enabled withdraw asset");
    }
  });

  it("skips all withdraw checks with a warn when /info declares no withdraw object at all", async () => {
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";

      if (url === "https://transfer.example.com/sep24/info") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ deposit: { USDC: { enabled: true } } }),
        } as Response;
      }
      if (url === "https://transfer.example.com/sep24/transactions/deposit/interactive" && method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            type: "interactive_customer_info_needed",
            url: "https://interactive.example.com/deposit",
            id: "tx_deposit_1",
          }),
        } as Response;
      }
      if (url === "https://interactive.example.com/deposit") {
        return { ok: true, status: 200 } as Response;
      }
      if (url.includes("/transaction?id=tx_deposit_1")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ transaction: { id: "tx_deposit_1", status: "incomplete" } }),
        } as Response;
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }) as unknown as typeof fetch;

    const results = await runSep24Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const withdrawInteractive = results.find((r) => r.id === "sep24.withdraw_interactive");
    expect(withdrawInteractive?.status).toBe("warn");
  });

  it("runs browser checks dynamically on demand when interactiveBrowser is true", async () => {
    const transactionId = "tx_sep24_browser_dynamic";
    const interactiveUrl = "https://interactive.example.com/deposit?id=" + transactionId;

    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === "https://transfer.example.com/sep24/info") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ deposit: { USDC: { enabled: true } }, withdraw: {} }),
        } as Response;
      }
      if (url === "https://transfer.example.com/sep24/transactions/deposit/interactive") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ type: "interactive_customer_info_needed", url: interactiveUrl, id: transactionId }),
        } as Response;
      }
      if (url === interactiveUrl) {
        return { ok: true, status: 200, text: async () => "<html>Interactive form</html>" } as Response;
      }
      if (url === `https://transfer.example.com/sep24/transaction?id=${transactionId}`) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ transaction: { id: transactionId, status: "incomplete", kind: "deposit" } }),
        } as Response;
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof fetch;

    const results = await runSep24Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt,
      interactiveBrowser: true,
    });

    const browserCheck = results.find((r) =>
      r.id.startsWith("sep24.interactive_browser_"),
    );
    expect(browserCheck).toBeDefined();
  }, 35000);
});

