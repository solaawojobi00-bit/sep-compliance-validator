import { afterEach, describe, expect, it, vi } from "vitest";
import { runSep12Checks } from "../src/checks/sep12.js";
import type { StellarToml } from "../src/checks/sep1.js";

describe("runSep12Checks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const domain = "example.com";
  const jwt = "fake.jwt.token";
  const validToml: StellarToml = {
    raw: {
      KYC_SERVER: "https://kyc.example.com",
    },
    kycServer: "https://kyc.example.com",
  };

  it("passes all checks for a well-formed SEP-12 KYC provider", async () => {
    const customerId = "cust_12345";

    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();

      // Check auth header
      const headers = init?.headers as Record<string, string>;
      expect(headers?.Authorization).toBe(`Bearer ${jwt}`);

      if (url === "https://kyc.example.com/customer" && init?.method === "PUT") {
        const body = JSON.parse(init.body as string);
        if (body.email_address === "not-an-email-address") {
          return {
            ok: false,
            status: 400,
            json: async () => ({ error: "Invalid email_address" }),
          } as Response;
        }

        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: customerId,
            status: "ACCEPTED",
          }),
        } as Response;
      }

      if (url === `https://kyc.example.com/customer?id=${customerId}`) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: customerId,
            status: "ACCEPTED",
          }),
        } as Response;
      }

      if (init?.method === "DELETE") {
        return {
          ok: true,
          status: 200,
        } as Response;
      }

      throw new Error(`Unexpected request to ${url}`);
    }) as unknown as typeof fetch;

    const results = await runSep12Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt,
    });

    expect(results).toHaveLength(4);
    expect(results.every((r) => r.status === "pass")).toBe(true);
    const deleteCheck = results.find((r) => r.id === "sep12.delete_customer");
    expect(deleteCheck?.status).toBe("pass");
  });

  it("falls back to TRANSFER_SERVER when KYC_SERVER is not declared", async () => {
    const transferToml: StellarToml = {
      raw: {
        TRANSFER_SERVER: "https://transfer.example.com",
      },
      transferServer: "https://transfer.example.com",
    };

    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      if (init?.method === "DELETE") {
        return { ok: true, status: 200 } as Response;
      }
      if (url.startsWith("https://transfer.example.com/customer")) {
        if (init?.method === "PUT") {
          const body = JSON.parse((init.body as string) || "{}");
          if (body.email_address === "not-an-email-address") {
            return { ok: false, status: 400 } as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: "c1", status: "PROCESSING" }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "c1", status: "PROCESSING" }),
        } as Response;
      }
      throw new Error(`Unexpected request to ${url}`);
    }) as unknown as typeof fetch;

    const results = await runSep12Checks({
      domain,
      toml: transferToml,
      network: "testnet",
      jwt,
    });

    expect(results.every((r) => r.status === "pass")).toBe(true);
  });

  it("skips checks when neither KYC_SERVER nor TRANSFER_SERVER is declared", async () => {
    const emptyToml: StellarToml = { raw: {} };
    const results = await runSep12Checks({
      domain,
      toml: emptyToml,
      network: "testnet",
      jwt,
    });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("sep12.skipped");
    expect(results[0].status).toBe("warn");
  });

  it("skips checks when JWT is missing", async () => {
    const results = await runSep12Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt: "",
    });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("sep12.skipped");
    expect(results[0].status).toBe("warn");
  });

  it("fails when PUT /customer returns non-standard status", async () => {
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://kyc.example.com/customer" && init?.method === "PUT") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "cust_123", status: "UNKNOWN_STATUS" }),
        } as Response;
      }
      return { ok: false, status: 400 } as Response;
    }) as unknown as typeof fetch;

    const results = await runSep12Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const putCheck = results.find((r) => r.id === "sep12.put_customer");
    expect(putCheck?.status).toBe("fail");
  });

  it("passes PUT /customer when response contains only id without status and lets GET proceed", async () => {
    const customerId = "cust_only_id";
    let getCalled = false;

    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://kyc.example.com/customer" && init?.method === "PUT") {
        const body = JSON.parse(init.body as string);
        if (body.email_address === "not-an-email-address") {
          return { ok: false, status: 400 } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: customerId,
          }),
        } as Response;
      }

      if (url === `https://kyc.example.com/customer?id=${customerId}`) {
        getCalled = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: customerId,
            status: "ACCEPTED",
          }),
        } as Response;
      }

      if (init?.method === "DELETE") {
        return { ok: true, status: 200 } as Response;
      }

      throw new Error(`Unexpected request to ${url}`);
    }) as unknown as typeof fetch;

    const results = await runSep12Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const putCheck = results.find((r) => r.id === "sep12.put_customer");
    expect(putCheck?.status).toBe("pass");
    expect(putCheck?.message).toContain(customerId);

    const getCheck = results.find((r) => r.id === "sep12.get_customer");
    expect(getCheck?.status).toBe("pass");
    expect(getCalled).toBe(true);

    const deleteCheck = results.find((r) => r.id === "sep12.delete_customer");
    expect(deleteCheck?.status).toBe("pass");
  });

  it("captures customer id for GET and teardown even when PUT returns non-standard status", async () => {
    let getUrlCalled: string | undefined;
    let deleteUrlCalled: string | undefined;

    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://kyc.example.com/customer" && init?.method === "PUT") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "cust_with_bad_status", status: "UNKNOWN_STATUS" }),
        } as Response;
      }
      if (url.includes("/customer?id=cust_with_bad_status")) {
        getUrlCalled = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "cust_with_bad_status", status: "ACCEPTED" }),
        } as Response;
      }
      if (init?.method === "DELETE") {
        deleteUrlCalled = url;
        return { ok: true, status: 200 } as Response;
      }
      return { ok: false, status: 400 } as Response;
    }) as unknown as typeof fetch;

    const results = await runSep12Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const putCheck = results.find((r) => r.id === "sep12.put_customer");
    expect(putCheck?.status).toBe("fail");

    const getCheck = results.find((r) => r.id === "sep12.get_customer");
    expect(getCheck?.status).toBe("pass");
    expect(getUrlCalled).toBe("https://kyc.example.com/customer?id=cust_with_bad_status");

    expect(deleteUrlCalled).toContain("cust_with_bad_status");
  });

  it("skips GET check with clear message when PUT response has no customer id", async () => {
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://kyc.example.com/customer" && init?.method === "PUT") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "ACCEPTED" }),
        } as Response;
      }
      return { ok: false, status: 400 } as Response;
    }) as unknown as typeof fetch;

    const results = await runSep12Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const putCheck = results.find((r) => r.id === "sep12.put_customer");
    expect(putCheck?.status).toBe("fail");
    expect(putCheck?.message).toContain("missing or empty customer id");

    const getCheck = results.find((r) => r.id === "sep12.get_customer");
    expect(getCheck?.status).toBe("fail");
    expect(getCheck?.message).toContain("did not return a customer id");
  });

  it("fails when PUT /customer silently accepts malformed email_address", async () => {
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://kyc.example.com/customer" && init?.method === "PUT") {
        const body = JSON.parse(init.body as string);
        if (body.email_address === "not-an-email-address") {
          // Silently accepts with status ACCEPTED
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: "cust_123", status: "ACCEPTED" }),
          } as Response;
        }

        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "cust_123", status: "ACCEPTED" }),
        } as Response;
      }
      if (url.includes("/customer?id=cust_123")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "cust_123", status: "ACCEPTED" }),
        } as Response;
      }
      if (init?.method === "DELETE") {
        return { ok: true, status: 200 } as Response;
      }
      throw new Error(`Unexpected url: ${url}`);
    }) as unknown as typeof fetch;

    const results = await runSep12Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const malformedCheck = results.find((r) => r.id === "sep12.put_malformed_field");
    expect(malformedCheck?.status).toBe("fail");
  });

  it("fails when GET /customer returns a mismatched customer id", async () => {
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      if (init?.method === "DELETE") {
        return { ok: true, status: 200 } as Response;
      }
      if (url === "https://kyc.example.com/customer" && init?.method === "PUT") {
        const body = JSON.parse(init?.body as string);
        if (body.email_address === "not-an-email-address") {
          return { ok: false, status: 400 } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "cust_123", status: "ACCEPTED" }),
        } as Response;
      }
      if (url.includes("/customer?id=cust_123")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "different_cust_id", status: "ACCEPTED" }),
        } as Response;
      }
      throw new Error(`Unexpected url: ${url}`);
    }) as unknown as typeof fetch;

    const results = await runSep12Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const getCheck = results.find((r) => r.id === "sep12.get_customer");
    expect(getCheck?.status).toBe("fail");
  });

  it("fails fast when customer request exceeds configured timeoutMs", async () => {
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

    const results = await runSep12Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt,
      timeoutMs: 25,
    });
    const putCheck = results.find((r) => r.id === "sep12.put_customer");
    expect(putCheck?.status).toBe("fail");
    expect(putCheck?.message).toContain("timed out after 25ms");
  });

  it("degrades teardown failure to warn without masking previous check results", async () => {
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      if (init?.method === "PUT") {
        const body = JSON.parse(init.body as string);
        if (body.email_address === "not-an-email-address") {
          return { ok: false, status: 400 } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "leaked_cust_999", status: "ACCEPTED" }),
        } as Response;
      }
      if (url.includes("/customer?id=leaked_cust_999")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "leaked_cust_999", status: "ACCEPTED" }),
        } as Response;
      }
      if (init?.method === "DELETE") {
        return {
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
        } as Response;
      }
      throw new Error(`Unexpected url: ${url}`);
    }) as unknown as typeof fetch;

    const results = await runSep12Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const putCheck = results.find((r) => r.id === "sep12.put_customer");
    expect(putCheck?.status).toBe("pass");

    const deleteCheck = results.find((r) => r.id === "sep12.delete_customer");
    expect(deleteCheck?.status).toBe("warn");
    expect(deleteCheck?.message).toContain("leaked_cust_999");
  });

  it("--no-write skips all mutating operations with warn and does not call fetch", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const results = await runSep12Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt,
      noWrite: true,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === "warn")).toBe(true);
    expect(results[0].message).toContain("--no-write mode enabled");
  });

  it("uses randomized synthetic identities with @invalid.test emails", async () => {
    let capturedBody: any;
    global.fetch = vi.fn(async (_input, init) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(init.body as string);
        if (body.email_address !== "not-an-email-address") {
          capturedBody = body;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "c1", status: "ACCEPTED" }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ id: "c1", status: "ACCEPTED" }) } as Response;
    }) as unknown as typeof fetch;

    await runSep12Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt,
    });

    expect(capturedBody).toBeDefined();
    expect(capturedBody.first_name).toBe("SEPVALIDATOR");
    expect(capturedBody.last_name).toMatch(/^Run-[a-f0-9]{8}$/);
    expect(capturedBody.email_address).toMatch(/^sepvalidator-[a-f0-9]{8}@invalid\.test$/);
  });

  it("surfaces fields/provided_fields findings from the GET /customer response", async () => {
    const customerId = "cust_with_fields";

    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://kyc.example.com/customer" && init?.method === "PUT") {
        const body = JSON.parse(init.body as string);
        if (body.email_address === "not-an-email-address") {
          return { ok: false, status: 400 } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: customerId, status: "NEEDS_INFO" }),
        } as Response;
      }

      if (url === `https://kyc.example.com/customer?id=${customerId}`) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: customerId,
            status: "NEEDS_INFO",
            fields: {
              email_address: { type: "string", description: "Email address" },
              made_up_field: { type: "string", description: "Anchor-specific" },
              bad_field: { type: "not-a-real-type", description: "Bad type" },
            },
          }),
        } as Response;
      }

      if (init?.method === "DELETE") {
        return { ok: true, status: 200 } as Response;
      }

      throw new Error(`Unexpected request to ${url}`);
    }) as unknown as typeof fetch;

    const results = await runSep12Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt,
    });

    expect(results.some((r) => r.id === "sep12.fields.unknown_name" && r.message.includes("made_up_field"))).toBe(
      true,
    );
    expect(results.some((r) => r.id === "sep12.fields.type" && r.message.includes("bad_field"))).toBe(true);
    expect(results.some((r) => r.id === "sep12.fields.needs_info_empty")).toBe(false);
  });

  it("fails when GET /customer reports NEEDS_INFO with no fields object", async () => {
    const customerId = "cust_needs_info_empty";

    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://kyc.example.com/customer" && init?.method === "PUT") {
        const body = JSON.parse(init.body as string);
        if (body.email_address === "not-an-email-address") {
          return { ok: false, status: 400 } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: customerId, status: "NEEDS_INFO" }),
        } as Response;
      }

      if (url === `https://kyc.example.com/customer?id=${customerId}`) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: customerId, status: "NEEDS_INFO" }),
        } as Response;
      }

      if (init?.method === "DELETE") {
        return { ok: true, status: 200 } as Response;
      }

      throw new Error(`Unexpected request to ${url}`);
    }) as unknown as typeof fetch;

    const results = await runSep12Checks({
      domain,
      toml: validToml,
      network: "testnet",
      jwt,
    });

    const needsInfoCheck = results.find((r) => r.id === "sep12.fields.needs_info_empty");
    expect(needsInfoCheck?.status).toBe("fail");
  });
});

