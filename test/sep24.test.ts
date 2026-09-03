import { afterEach, describe, expect, it, vi } from "vitest";
import { runSep24Checks } from "../src/checks/sep24.js";
import type { StellarToml } from "../src/checks/sep1.js";

describe("runSep24Checks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const domain = "example.com";
  const jwt = "fake.jwt.token";
  const base = "https://transfer.example.com/sep24";
  const validToml: StellarToml = {
    raw: {
      TRANSFER_SERVER_SEP0024: base,
    },
    transferServerSep24: base,
  };

  const LIST_CHECK_IDS = [
    "sep24.transactions_list",
    "sep24.transactions_list_records",
    "sep24.transactions_list_asset_filter",
    "sep24.transactions_list_contains_created",
    "sep24.transactions_list_asset_filter_excludes",
    "sep24.transactions_list_limit",
    "sep24.transactions_list_requires_asset_code",
    "sep24.transactions_list_unauthenticated",
  ];

  interface ListRecord {
    id?: unknown;
    status?: unknown;
    kind?: unknown;
    asset_code?: unknown;
    amount_in_asset?: unknown;
    amount_out_asset?: unknown;
  }

  const jsonOk = (transactions: unknown) =>
    ({ ok: true, status: 200, json: async () => ({ transactions }) }) as Response;

  /**
   * GET /transactions as a fully conformant anchor serves it: the SEP-10 JWT is required,
   * asset_code is required, records are filtered by asset_code, and limit is honoured.
   */
  const conformantList =
    (records: ListRecord[]) =>
    (url: string, init: RequestInit | undefined): Response => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers?.Authorization !== `Bearer ${jwt}`) {
        return { ok: false, status: 403, json: async () => ({ error: "unauthorized" }) } as Response;
      }

      const params = new URLSearchParams(url.split("?")[1] ?? "");
      const assetCode = params.get("asset_code");
      if (!assetCode) {
        return { ok: false, status: 400, json: async () => ({ error: "asset_code is required" }) } as Response;
      }

      let matching = records.filter((r) => r.asset_code === assetCode);
      const limit = params.get("limit");
      if (limit) {
        matching = matching.slice(0, Number(limit));
      }
      return jsonOk(matching);
    };

  const listTxId = "tx_deposit_list";
  const listInteractiveUrl = "https://interactive.example.com/deposit";

  /**
   * Mocks a conformant deposit-only anchor and routes every GET /transactions request to
   * `listHandler`, so a list test only has to describe the list endpoint's behaviour.
   * Set `interactiveFails` to model a run where no transaction id was produced.
   *
   * /info advertises two enabled assets by default so the asset-filter exclusion check has
   * a second code to filter by; `singleAsset` models the single-asset anchor for which
   * that check cannot be exercised.
   */
  function mockAnchor(
    listHandler: (url: string, init: RequestInit | undefined) => Response,
    {
      interactiveFails = false,
      singleAsset = false,
    }: { interactiveFails?: boolean; singleAsset?: boolean } = {},
  ): void {
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const path = url.split("?")[0];

      if (url === `${base}/info`) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            deposit: singleAsset
              ? { USDC: { enabled: true } }
              : { USDC: { enabled: true }, EURC: { enabled: true } },
            withdraw: {},
          }),
        } as Response;
      }
      if (url === `${base}/transactions/deposit/interactive`) {
        if (interactiveFails) {
          return { ok: false, status: 500, json: async () => ({}) } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            type: "interactive_customer_info_needed",
            url: listInteractiveUrl,
            id: listTxId,
          }),
        } as Response;
      }
      if (url === listInteractiveUrl) {
        return { ok: true, status: 200 } as Response;
      }
      if (path === `${base}/transaction`) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ transaction: { id: listTxId, status: "incomplete" } }),
        } as Response;
      }
      if (path === `${base}/transactions`) {
        return listHandler(url, init);
      }
      throw new Error(`Unexpected request to ${url}`);
    }) as unknown as typeof fetch;
  }

  /** Runs the checks against the mocked anchor and indexes the list results by id. */
  async function runListChecks(): Promise<Map<string, { status: string; severity: string; message: string }>> {
    const results = await runSep24Checks({ domain, toml: validToml, network: "testnet", jwt });
    return new Map(
      results
        .filter((r) => r.id.startsWith("sep24.transactions_list"))
        .map((r) => [r.id, { status: r.status, severity: r.severity, message: r.message }]),
    );
  }

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
              // A second enabled asset, so the list-filter exclusion check has another
              // code to filter by and is actually exercised here.
              EURC: {
                enabled: true,
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

      if (url.split("?")[0] === `${base}/transactions`) {
        return conformantList([
          { id: transactionId, status: "incomplete", kind: "deposit", asset_code: "USDC" },
          { id: "tx_older", status: "completed", kind: "withdrawal", asset_code: "USDC" },
          { id: "tx_other_asset", status: "completed", kind: "deposit", asset_code: "EURC" },
        ])(url, init);
      }

      throw new Error(`Unexpected request to ${url}`);
    }) as unknown as typeof fetch;

    const results = await runSep24Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const depositChecks = results.filter(
      (r) => !r.id.startsWith("sep24.withdraw") && !r.id.startsWith("sep24.transactions_list"),
    );
    expect(depositChecks).toHaveLength(4);
    expect(depositChecks.every((r) => r.status === "pass")).toBe(true);

    const listChecks = results.filter((r) => r.id.startsWith("sep24.transactions_list"));
    expect(listChecks.map((r) => r.id)).toEqual(LIST_CHECK_IDS);
    expect(listChecks.every((r) => r.status === "pass")).toBe(true);

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
            // EURC is a second enabled asset so the list-filter exclusion check is
            // exercised; USDC stays first, so it remains the deposit/withdraw asset.
            deposit: { USDC: { enabled: true }, EURC: { enabled: true } },
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
      if (url.split("?")[0] === `${base}/transactions`) {
        return conformantList([
          { id: depositTxId, status: "incomplete", kind: "deposit", asset_code: "USDC" },
          { id: withdrawTxId, status: "pending_user_transfer_start", kind: "withdrawal", asset_code: "USDC" },
        ])(url, init);
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
      if (url.split("?")[0] === `${base}/transactions`) {
        return conformantList([{ id: "tx_deposit_1", status: "incomplete", kind: "deposit", asset_code: "USDC" }])(
          url,
          init,
        );
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

  describe("GET /transactions list endpoint", () => {
    it("passes every list check against a conformant anchor and sends the JWT", async () => {
      mockAnchor(
        conformantList([
          { id: listTxId, status: "incomplete", kind: "deposit", asset_code: "USDC" },
          { id: "tx_old", status: "completed", kind: "withdrawal", asset_code: "USDC" },
        ]),
      );

      const checks = await runListChecks();

      expect([...checks.keys()]).toEqual(LIST_CHECK_IDS);
      for (const id of LIST_CHECK_IDS) {
        expect(checks.get(id)?.status, id).toBe("pass");
      }
      expect(checks.get("sep24.transactions_list")?.message).toContain("2 record(s)");
      expect(checks.get("sep24.transactions_list_contains_created")?.message).toContain(listTxId);
    });

    it("fails every derived check when GET /transactions returns an HTTP error", async () => {
      mockAnchor((url, init) => {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        const headers = init?.headers as Record<string, string> | undefined;
        // Only the primary/limit reads fail; the negative cases keep their own behaviour.
        if (params.get("asset_code") && headers?.Authorization) {
          return { ok: false, status: 502, json: async () => ({}) } as Response;
        }
        return conformantList([])(url, init);
      });

      const checks = await runListChecks();

      for (const id of [
        "sep24.transactions_list",
        "sep24.transactions_list_records",
        "sep24.transactions_list_contains_created",
        "sep24.transactions_list_asset_filter",
        "sep24.transactions_list_limit",
      ]) {
        expect(checks.get(id)?.status, id).toBe("fail");
        expect(checks.get(id)?.message, id).toContain("HTTP 502");
      }
    });

    it("fails when the response has no transactions array", async () => {
      mockAnchor(() => ({ ok: true, status: 200, json: async () => ({ records: [] }) }) as Response);

      const checks = await runListChecks();

      expect(checks.get("sep24.transactions_list")?.status).toBe("fail");
      expect(checks.get("sep24.transactions_list")?.message).toContain('"transactions" array');
      expect(checks.get("sep24.transactions_list_records")?.status).toBe("fail");
      expect(checks.get("sep24.transactions_list_limit")?.status).toBe("fail");
    });

    it("reports every per-record schema defect: empty id, unknown status, unknown kind", async () => {
      mockAnchor((url, init) => {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        const headers = init?.headers as Record<string, string> | undefined;
        if (!params.get("asset_code") || !headers?.Authorization) {
          return conformantList([])(url, init);
        }
        return jsonOk([
          { id: "   ", status: "incomplete", kind: "deposit", asset_code: "USDC" },
          { id: listTxId, status: "NOT_A_STATUS", kind: "transfer", asset_code: "USDC" },
        ]);
      });

      const checks = await runListChecks();

      const records = checks.get("sep24.transactions_list_records");
      expect(records?.status).toBe("fail");
      expect(records?.severity).toBe("error");
      expect(records?.message).toContain("3 schema defect(s)");
      expect(records?.message).toContain("[0] id must be a non-empty string");
      expect(records?.message).toContain("[1] status not in SEP-24 enum");
      expect(records?.message).toContain('[1] kind must be "deposit" or "withdrawal"');
    });

    it("warns rather than fails on an empty list when no transaction was created this run", async () => {
      mockAnchor(conformantList([]), { interactiveFails: true });

      const checks = await runListChecks();

      expect(checks.get("sep24.transactions_list")?.status).toBe("pass");
      expect(checks.get("sep24.transactions_list_records")?.status).toBe("warn");
      expect(checks.get("sep24.transactions_list_records")?.severity).toBe("warning");
      expect(checks.get("sep24.transactions_list_records")?.message).toContain("empty transactions array");
      expect(checks.get("sep24.transactions_list_asset_filter")?.status).toBe("warn");

      const created = checks.get("sep24.transactions_list_contains_created");
      expect(created?.status).toBe("warn");
      expect(created?.message).toContain("no transaction id was produced");
    });

    it("fails the cross-check when a transaction created this run is absent from the list", async () => {
      mockAnchor(
        conformantList([{ id: "some_other_tx", status: "completed", kind: "deposit", asset_code: "USDC" }]),
      );

      const checks = await runListChecks();

      const created = checks.get("sep24.transactions_list_contains_created");
      expect(created?.status).toBe("fail");
      expect(created?.severity).toBe("error");
      expect(created?.message).toContain("list and lookup endpoints disagree");
      // The records themselves are conformant, so only the cross-check fails.
      expect(checks.get("sep24.transactions_list_records")?.status).toBe("pass");
    });

    it("fails the cross-check when the created transaction is missing from an empty list", async () => {
      mockAnchor(conformantList([]));

      const checks = await runListChecks();

      expect(checks.get("sep24.transactions_list_contains_created")?.status).toBe("fail");
      expect(checks.get("sep24.transactions_list_records")?.status).toBe("warn");
    });

    it("fails the asset filter when a record belongs to a different asset", async () => {
      mockAnchor((url, init) => {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        const headers = init?.headers as Record<string, string> | undefined;
        if (!params.get("asset_code") || !headers?.Authorization) {
          return conformantList([])(url, init);
        }
        // asset_code is ignored: an EURC record leaks into a USDC-filtered response.
        return jsonOk([
          { id: listTxId, status: "incomplete", kind: "deposit", asset_code: "USDC" },
          { id: "tx_eurc", status: "completed", kind: "deposit", asset_code: "EURC" },
        ]);
      });

      const checks = await runListChecks();

      const filter = checks.get("sep24.transactions_list_asset_filter");
      expect(filter?.status).toBe("fail");
      expect(filter?.severity).toBe("error");
      expect(filter?.message).toContain("1 record(s) do not match requested asset_code=USDC");
      expect(filter?.message).toContain("tx_eurc");
    });

    it("matches the asset filter through SEP-38 amount_in_asset/amount_out_asset identifiers", async () => {
      mockAnchor((url, init) => {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        const headers = init?.headers as Record<string, string> | undefined;
        if (!params.get("asset_code") || !headers?.Authorization) {
          return conformantList([])(url, init);
        }
        return jsonOk([
          {
            id: listTxId,
            status: "incomplete",
            kind: "deposit",
            amount_in_asset: "iso4217:USD",
            amount_out_asset: "stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
          },
        ]);
      });

      const checks = await runListChecks();

      expect(checks.get("sep24.transactions_list_asset_filter")?.status).toBe("pass");
      expect(checks.get("sep24.transactions_list_records")?.status).toBe("pass");
    });

    it("matches a bare asset code in amount_in_asset rather than calling it a mismatch", async () => {
      mockAnchor((url, init) => {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        const headers = init?.headers as Record<string, string> | undefined;
        if (!params.get("asset_code") || !headers?.Authorization) {
          return conformantList([])(url, init);
        }
        // Non-conformant: a bare code where a SEP-38 identifier belongs.
        return jsonOk([{ id: listTxId, status: "incomplete", kind: "deposit", amount_in_asset: "USDC" }]);
      });

      const checks = await runListChecks();

      expect(checks.get("sep24.transactions_list_asset_filter")?.status).toBe("pass");
    });

    it("reports a non-object element as a schema defect without crashing the other checks", async () => {
      mockAnchor((url, init) => {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        const headers = init?.headers as Record<string, string> | undefined;
        if (!params.get("asset_code") || !headers?.Authorization) {
          return conformantList([])(url, init);
        }
        return jsonOk([null, "not-a-record", { id: listTxId, status: "incomplete", kind: "deposit", asset_code: "USDC" }]);
      });

      const checks = await runListChecks();

      const records = checks.get("sep24.transactions_list_records");
      expect(records?.status).toBe("fail");
      expect(records?.message).toContain("[0] must be a transaction object, got: null");
      expect(records?.message).toContain('[1] must be a transaction object, got: "not-a-record"');
      // The malformed entries are inconclusive for the filter, not violations of it, and
      // the conformant third record is still found by the cross-check.
      expect(checks.get("sep24.transactions_list_asset_filter")?.status).toBe("pass");
      expect(checks.get("sep24.transactions_list_asset_filter")?.message).toContain(
        "2 record(s) carried no asset identifier",
      );
      expect(checks.get("sep24.transactions_list_contains_created")?.status).toBe("pass");
    });

    it("reports the asset filter as inconclusive when no record carries an asset identifier", async () => {
      mockAnchor((url, init) => {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        const headers = init?.headers as Record<string, string> | undefined;
        if (!params.get("asset_code") || !headers?.Authorization) {
          return conformantList([])(url, init);
        }
        return jsonOk([{ id: listTxId, status: "incomplete", kind: "deposit" }]);
      });

      const checks = await runListChecks();

      const filter = checks.get("sep24.transactions_list_asset_filter");
      expect(filter?.status).toBe("warn");
      expect(filter?.severity).toBe("warning");
      expect(filter?.message).toContain("cannot be verified");
    });

    it("passes the asset filter and notes records that carry no asset identifier", async () => {
      mockAnchor((url, init) => {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        const headers = init?.headers as Record<string, string> | undefined;
        if (!params.get("asset_code") || !headers?.Authorization) {
          return conformantList([])(url, init);
        }
        return jsonOk([
          { id: listTxId, status: "incomplete", kind: "deposit", asset_code: "USDC" },
          { id: "tx_bare", status: "completed", kind: "deposit", amount_in_asset: "   " },
        ]);
      });

      const checks = await runListChecks();

      const filter = checks.get("sep24.transactions_list_asset_filter");
      expect(filter?.status).toBe("pass");
      expect(filter?.message).toContain("1 record(s) carried no asset identifier");
    });

    it("passes the exclusion check when the created transaction is absent under a second asset", async () => {
      mockAnchor(
        conformantList([{ id: listTxId, status: "incomplete", kind: "deposit", asset_code: "USDC" }]),
      );

      const checks = await runListChecks();

      const excludes = checks.get("sep24.transactions_list_asset_filter_excludes");
      expect(excludes?.status).toBe("pass");
      expect(excludes?.severity).toBe("error");
      expect(excludes?.message).toContain("correctly absent");
      expect(excludes?.message).toContain("asset_code=EURC");
    });

    it("fails the exclusion check when the created transaction is returned under a different asset", async () => {
      // Records carry no asset identifier at all, which is exactly the case the positive
      // filter check cannot judge — so this is the only check that catches the anchor.
      mockAnchor((url, init) => {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        const headers = init?.headers as Record<string, string> | undefined;
        if (!params.get("asset_code") || !headers?.Authorization) {
          return conformantList([])(url, init);
        }
        // asset_code is ignored: the same history comes back whatever asset is requested.
        return jsonOk([{ id: listTxId, status: "incomplete", kind: "deposit" }]);
      });

      const checks = await runListChecks();

      const excludes = checks.get("sep24.transactions_list_asset_filter_excludes");
      expect(excludes?.status).toBe("fail");
      expect(excludes?.severity).toBe("error");
      expect(excludes?.message).toContain("asset_code filter ignored");
      expect(excludes?.message).toContain(listTxId);
      // The positive check stays inconclusive, which is what makes this check necessary.
      expect(checks.get("sep24.transactions_list_asset_filter")?.status).toBe("warn");
    });

    it("does not exercise the exclusion check when /info advertises only one enabled asset", async () => {
      mockAnchor(
        conformantList([{ id: listTxId, status: "incomplete", kind: "deposit", asset_code: "USDC" }]),
        { singleAsset: true },
      );

      const checks = await runListChecks();

      const excludes = checks.get("sep24.transactions_list_asset_filter_excludes");
      expect(excludes?.status).toBe("warn");
      expect(excludes?.severity).toBe("warning");
      expect(excludes?.message).toContain("no enabled asset other than USDC");
    });

    it("skips the exclusion check when no transaction was created this run", async () => {
      mockAnchor(conformantList([]), { interactiveFails: true });

      const checks = await runListChecks();

      const excludes = checks.get("sep24.transactions_list_asset_filter_excludes");
      expect(excludes?.status).toBe("warn");
      expect(excludes?.severity).toBe("warning");
      expect(excludes?.message).toContain("no transaction id was produced");
    });

    it("fails the exclusion check when the second-asset request returns an error or malformed body", async () => {
      mockAnchor((url, init) => {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        if (params.get("asset_code") === "EURC") {
          return { ok: false, status: 502, json: async () => ({}) } as Response;
        }
        return conformantList([{ id: listTxId, status: "incomplete", kind: "deposit", asset_code: "USDC" }])(
          url,
          init,
        );
      });

      const checks = await runListChecks();

      const excludes = checks.get("sep24.transactions_list_asset_filter_excludes");
      expect(excludes?.status).toBe("fail");
      expect(excludes?.message).toContain("HTTP 502");
      // The USDC-filtered checks are unaffected.
      expect(checks.get("sep24.transactions_list")?.status).toBe("pass");
    });

    it("fails the exclusion check when the second-asset response has no transactions array", async () => {
      mockAnchor((url, init) => {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        if (params.get("asset_code") === "EURC") {
          return { ok: true, status: 200, json: async () => ({ records: [] }) } as Response;
        }
        return conformantList([{ id: listTxId, status: "incomplete", kind: "deposit", asset_code: "USDC" }])(
          url,
          init,
        );
      });

      const checks = await runListChecks();

      const excludes = checks.get("sep24.transactions_list_asset_filter_excludes");
      expect(excludes?.status).toBe("fail");
      expect(excludes?.message).toContain('"transactions" array');
    });

    it("fails when limit=1 is ignored", async () => {
      const records: ListRecord[] = [
        { id: listTxId, status: "incomplete", kind: "deposit", asset_code: "USDC" },
        { id: "tx_two", status: "completed", kind: "deposit", asset_code: "USDC" },
      ];
      mockAnchor((url, init) => {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        const headers = init?.headers as Record<string, string> | undefined;
        if (!params.get("asset_code") || !headers?.Authorization) {
          return conformantList(records)(url, init);
        }
        return jsonOk(records); // limit is not applied
      });

      const checks = await runListChecks();

      const limit = checks.get("sep24.transactions_list_limit");
      expect(limit?.status).toBe("fail");
      expect(limit?.message).toContain("limit=1 was ignored: anchor returned 2 records");
      // The unlimited primary read is still conformant.
      expect(checks.get("sep24.transactions_list")?.status).toBe("pass");
    });

    it("fails at warning severity when GET /transactions accepts a missing asset_code", async () => {
      mockAnchor((url, init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        if (!headers?.Authorization) {
          return { ok: false, status: 403, json: async () => ({}) } as Response;
        }
        // asset_code is not enforced at all.
        return jsonOk([{ id: listTxId, status: "incomplete", kind: "deposit", asset_code: "USDC" }]);
      });

      const checks = await runListChecks();

      const required = checks.get("sep24.transactions_list_requires_asset_code");
      expect(required?.status).toBe("fail");
      expect(required?.severity).toBe("warning");
      expect(required?.message).toContain("lists asset_code as required");
    });

    it("reports the missing-asset_code case as inconclusive on a 5xx", async () => {
      mockAnchor((url, init) => {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        if (!params.get("asset_code")) {
          return { ok: false, status: 503, json: async () => ({}) } as Response;
        }
        return conformantList([{ id: listTxId, status: "incomplete", kind: "deposit", asset_code: "USDC" }])(
          url,
          init,
        );
      });

      const checks = await runListChecks();

      const required = checks.get("sep24.transactions_list_requires_asset_code");
      expect(required?.status).toBe("warn");
      expect(required?.message).toContain("HTTP 503");
      expect(required?.message).toContain("inconclusive");
    });

    it("fails at error severity when GET /transactions serves history without a JWT", async () => {
      mockAnchor((url, _init) => {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        if (!params.get("asset_code")) {
          return { ok: false, status: 400, json: async () => ({}) } as Response;
        }
        // Authorization is never checked: any caller gets the account's history.
        return jsonOk([{ id: listTxId, status: "incomplete", kind: "deposit", asset_code: "USDC" }]);
      });

      const checks = await runListChecks();

      const unauth = checks.get("sep24.transactions_list_unauthenticated");
      expect(unauth?.status).toBe("fail");
      expect(unauth?.severity).toBe("error");
      expect(unauth?.message).toContain("AUTHENTICATION BYPASS");
    });

    it("reports the unauthenticated case as inconclusive on a status other than 401/403", async () => {
      mockAnchor((url, init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        if (!headers?.Authorization) {
          return { ok: false, status: 500, json: async () => ({}) } as Response;
        }
        return conformantList([{ id: listTxId, status: "incomplete", kind: "deposit", asset_code: "USDC" }])(
          url,
          init,
        );
      });

      const checks = await runListChecks();

      const unauth = checks.get("sep24.transactions_list_unauthenticated");
      expect(unauth?.status).toBe("warn");
      expect(unauth?.severity).toBe("warning");
      expect(unauth?.message).toContain("expected 401 or 403");
    });

    it("fails every list check when the transfer server is unreachable", async () => {
      mockAnchor(() => {
        throw new Error("socket hang up");
      });

      const checks = await runListChecks();

      for (const id of LIST_CHECK_IDS) {
        expect(checks.get(id)?.status, id).toBe("fail");
        expect(checks.get(id)?.message, id).toContain("socket hang up");
      }
    });
  });
});

