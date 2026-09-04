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

    const coreChecks = results.filter((r) => !r.id.startsWith("sep12.verification"));
    expect(coreChecks).toHaveLength(4);
    expect(coreChecks.every((r) => r.status === "pass")).toBe(true);
    const deleteCheck = results.find((r) => r.id === "sep12.delete_customer");
    expect(deleteCheck?.status).toBe("pass");

    // This anchor asked for no confirmation code, so the verification flow is reported
    // as unexercised rather than as passing — a green report must not imply it was
    // verified.
    const verificationChecks = results.filter((r) => r.id.startsWith("sep12.verification"));
    expect(verificationChecks).toHaveLength(3);
    expect(verificationChecks.every((r) => r.status === "warn")).toBe(true);
    expect(verificationChecks.every((r) => r.message.includes("Not exercised"))).toBe(true);
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

    expect(
      results.filter((r) => !r.id.startsWith("sep12.verification")).every((r) => r.status === "pass"),
    ).toBe(true);
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
    expect(results).toHaveLength(6);
    expect(results.every((r) => r.status === "warn")).toBe(true);
    expect(results.every((r) => r.message.includes("--no-write mode enabled"))).toBe(true);
    // The verification flow mutates customer state, so it is guarded too.
    expect(results.filter((r) => r.id.startsWith("sep12.verification"))).toHaveLength(3);
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

  describe("PUT /customer/verification", () => {
    const customerId = "cust_verify_1";

    /** A provided_fields entry that puts mobile_number into the confirmation-code flow. */
    const verificationRequiredFields = {
      mobile_number: {
        type: "string",
        description: "Mobile phone number awaiting confirmation",
        status: "VERIFICATION_REQUIRED",
      },
    };

    /**
     * Mocks a SEP-12 anchor whose GET /customer flags mobile_number as
     * VERIFICATION_REQUIRED, and routes PUT /customer/verification to `verifyHandler` so
     * each test describes only that endpoint's behaviour. The handler receives the parsed
     * request body and whether the request carried the SEP-10 JWT.
     */
    function mockAnchor(
      verifyHandler: (body: Record<string, unknown>, authed: boolean) => Response,
      providedFields: unknown = verificationRequiredFields,
    ): ReturnType<typeof vi.fn> {
      const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString();
        const headers = init?.headers as Record<string, string> | undefined;
        const authed = headers?.Authorization === `Bearer ${jwt}`;

        if (url === "https://kyc.example.com/customer/verification") {
          return verifyHandler(JSON.parse((init?.body as string) ?? "{}"), authed);
        }
        if (url === "https://kyc.example.com/customer" && init?.method === "PUT") {
          const body = JSON.parse((init.body as string) ?? "{}");
          if (body.email_address === "not-an-email-address") {
            return { ok: false, status: 400, json: async () => ({ error: "bad email" }) } as Response;
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
                mobile_number: { type: "string", description: "Mobile phone number" },
              },
              provided_fields: providedFields,
            }),
          } as Response;
        }
        if (init?.method === "DELETE") {
          return { ok: true, status: 200 } as Response;
        }
        throw new Error(`Unexpected request to ${url}`);
      });
      global.fetch = fn as unknown as typeof fetch;
      return fn as unknown as ReturnType<typeof vi.fn>;
    }

    const run = () =>
      runSep12Checks({ domain, toml: validToml, network: "testnet", jwt });

    /** Same run, with the operator-supplied verification options of #106. */
    const runWith = (extra: { verificationCode?: string; verificationField?: string }) =>
      runSep12Checks({ domain, toml: validToml, network: "testnet", jwt, ...extra });

    const SUPPLIED_CODE = "424242";

    /** Every /customer/verification request body sent during a run, in order. */
    const verificationBodies = (fetchMock: ReturnType<typeof vi.fn>) =>
      fetchMock.mock.calls
        .filter((c: unknown[]) => String(c[0]) === "https://kyc.example.com/customer/verification")
        .map((c: unknown[]) => JSON.parse((c[1] as RequestInit)?.body as string));

    const byId = (results: Awaited<ReturnType<typeof run>>, id: string) =>
      results.find((r) => r.id === id);

    it("passes when the anchor rejects an incorrect code with 400 and an error message", async () => {
      const fetchMock = mockAnchor((_body, authed) => {
        if (!authed) {
          return { ok: false, status: 403, json: async () => ({}) } as Response;
        }
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: "The provided confirmation code was invalid." }),
        } as Response;
      });

      const results = await run();

      const wrongCode = byId(results, "sep12.verification_wrong_code");
      expect(wrongCode?.status).toBe("pass");
      expect(wrongCode?.message).toContain("The provided confirmation code was invalid.");

      const unauth = byId(results, "sep12.verification_unauthenticated");
      expect(unauth?.status).toBe("pass");
      expect(unauth?.message).toContain("HTTP 403");

      // No success response exists to validate, and that is reported honestly rather
      // than as a pass.
      const schema = byId(results, "sep12.verification_response_schema");
      expect(schema?.status).toBe("warn");
      expect(schema?.message).toContain("cannot be known");

      // The code is submitted as <field>_verification alongside the customer id.
      const verifyCall = fetchMock.mock.calls.find(
        (c: unknown[]) => String(c[0]) === "https://kyc.example.com/customer/verification",
      );
      const sent = JSON.parse((verifyCall?.[1] as RequestInit)?.body as string);
      expect(sent.id).toBe(customerId);
      expect(sent.mobile_number_verification).toMatch(/^\d{6}$/);
    });

    it("fails at error severity when the anchor accepts an arbitrary confirmation code", async () => {
      mockAnchor((body, authed) => {
        if (!authed) {
          return { ok: false, status: 403, json: async () => ({}) } as Response;
        }
        // Any code at all is waved through, and the field is duly advanced.
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: body.id,
            status: "ACCEPTED",
            provided_fields: {
              mobile_number: {
                type: "string",
                description: "Mobile phone number",
                status: "ACCEPTED",
              },
            },
          }),
        } as Response;
      });

      const results = await run();

      const wrongCode = byId(results, "sep12.verification_wrong_code");
      expect(wrongCode?.status).toBe("fail");
      expect(wrongCode?.severity).toBe("error");
      expect(wrongCode?.message).toContain("any code will pass");

      // The success body it did return is still schema-checked, and is conformant here.
      const schema = byId(results, "sep12.verification_response_schema");
      expect(schema?.status).toBe("pass");
      expect(schema?.message).toContain("advanced to ACCEPTED");
    });

    it("fails the schema check when a success response does not advance the field status", async () => {
      mockAnchor((body, authed) => {
        if (!authed) {
          return { ok: false, status: 403, json: async () => ({}) } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: body.id,
            status: "NOT_A_STATUS",
            provided_fields: {
              mobile_number: {
                type: "string",
                description: "Mobile phone number",
                status: "VERIFICATION_REQUIRED",
              },
            },
          }),
        } as Response;
      });

      const results = await run();

      const schema = byId(results, "sep12.verification_response_schema");
      expect(schema?.status).toBe("fail");
      expect(schema?.severity).toBe("error");
      expect(schema?.message).toContain("status must be one of");
      expect(schema?.message).toContain("must be advanced to PROCESSING or ACCEPTED");
    });

    it("fails at error severity when verification succeeds without a JWT", async () => {
      mockAnchor((body) => {
        // Authorization is never checked: anyone can verify anyone's field.
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: body.id,
            status: "ACCEPTED",
            provided_fields: {
              mobile_number: { type: "string", description: "Mobile", status: "ACCEPTED" },
            },
          }),
        } as Response;
      });

      const results = await run();

      const unauth = byId(results, "sep12.verification_unauthenticated");
      expect(unauth?.status).toBe("fail");
      expect(unauth?.severity).toBe("error");
      expect(unauth?.message).toContain("AUTHENTICATION BYPASS");
    });

    it("reports the unauthenticated case as inconclusive on a status other than 401/403", async () => {
      mockAnchor((_body, authed) => {
        if (!authed) {
          return { ok: false, status: 500, json: async () => ({}) } as Response;
        }
        return { ok: false, status: 400, json: async () => ({ error: "bad code" }) } as Response;
      });

      const results = await run();

      const unauth = byId(results, "sep12.verification_unauthenticated");
      expect(unauth?.status).toBe("warn");
      expect(unauth?.message).toContain("expected 401 or 403");
    });

    it("fails when the endpoint 404s a customer id PUT /customer just returned", async () => {
      mockAnchor((_body, authed) => {
        if (!authed) {
          return { ok: false, status: 403, json: async () => ({}) } as Response;
        }
        return { ok: false, status: 404, json: async () => ({ error: "unknown id" }) } as Response;
      });

      const results = await run();

      const wrongCode = byId(results, "sep12.verification_wrong_code");
      expect(wrongCode?.status).toBe("fail");
      expect(wrongCode?.message).toContain("HTTP 404");
      expect(wrongCode?.message).toContain("either unimplemented or disagrees");
    });

    it("passes but notes the status when an incorrect code is refused with a non-400 4xx", async () => {
      mockAnchor((_body, authed) => {
        if (!authed) {
          return { ok: false, status: 403, json: async () => ({}) } as Response;
        }
        return { ok: false, status: 422, json: async () => ({ error: "bad code" }) } as Response;
      });

      const results = await run();

      const wrongCode = byId(results, "sep12.verification_wrong_code");
      expect(wrongCode?.status).toBe("pass");
      expect(wrongCode?.message).toContain("SEP-12 specifies 400");
    });

    it("reports the wrong-code check as inconclusive on a 5xx", async () => {
      mockAnchor((_body, authed) => {
        if (!authed) {
          return { ok: false, status: 403, json: async () => ({}) } as Response;
        }
        return { ok: false, status: 503, json: async () => ({}) } as Response;
      });

      const results = await run();

      const wrongCode = byId(results, "sep12.verification_wrong_code");
      expect(wrongCode?.status).toBe("warn");
      expect(wrongCode?.message).toContain("HTTP 503");
    });

    it("passes with 400 but notes a missing error field in the rejection body", async () => {
      mockAnchor((_body, authed) => {
        if (!authed) {
          return { ok: false, status: 403, json: async () => ({}) } as Response;
        }
        return {
          ok: false,
          status: 400,
          json: async () => {
            throw new Error("not json");
          },
        } as unknown as Response;
      });

      const results = await run();

      const wrongCode = byId(results, "sep12.verification_wrong_code");
      expect(wrongCode?.status).toBe("pass");
      expect(wrongCode?.message).toContain("no descriptive 'error' field");
    });

    it("fails the schema check when a success body is not JSON", async () => {
      mockAnchor((_body, authed) => {
        if (!authed) {
          return { ok: false, status: 403, json: async () => ({}) } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("not json");
          },
        } as unknown as Response;
      });

      const results = await run();

      const schema = byId(results, "sep12.verification_response_schema");
      expect(schema?.status).toBe("fail");
      expect(schema?.message).toContain(`id must be "${customerId}"`);
    });

    it("fails the wrong-code check when the verification request throws", async () => {
      mockAnchor((_body, authed) => {
        if (!authed) {
          return { ok: false, status: 403, json: async () => ({}) } as Response;
        }
        throw new Error("socket hang up");
      });

      const results = await run();

      const wrongCode = byId(results, "sep12.verification_wrong_code");
      expect(wrongCode?.status).toBe("fail");
      expect(wrongCode?.message).toContain("socket hang up");
    });

    it("fails the unauthenticated check when its request throws", async () => {
      mockAnchor((_body, authed) => {
        if (!authed) {
          throw new Error("connection reset");
        }
        return { ok: false, status: 400, json: async () => ({ error: "bad code" }) } as Response;
      });

      const results = await run();

      const unauth = byId(results, "sep12.verification_unauthenticated");
      expect(unauth?.status).toBe("fail");
      expect(unauth?.message).toContain("connection reset");
    });

    it("does not exercise the flow when no provided_field requires verification", async () => {
      const fetchMock = mockAnchor(
        () => {
          throw new Error("PUT /customer/verification must not be called");
        },
        {
          mobile_number: {
            type: "string",
            description: "Mobile phone number",
            status: "ACCEPTED",
          },
        },
      );

      const results = await run();

      const verificationChecks = results.filter((r) => r.id.startsWith("sep12.verification"));
      expect(verificationChecks).toHaveLength(3);
      for (const check of verificationChecks) {
        expect(check.status).toBe("warn");
        expect(check.severity).toBe("warning");
        expect(check.message).toContain("did not flag any provided_field as VERIFICATION_REQUIRED");
        expect(check.message).toContain("remains unverified");
      }
      expect(
        fetchMock.mock.calls.some(
          (c: unknown[]) => String(c[0]) === "https://kyc.example.com/customer/verification",
        ),
      ).toBe(false);
    });

    it("fails the schema check when a success response omits the verified field", async () => {
      mockAnchor((body, authed) => {
        if (!authed) {
          return { ok: false, status: 403, json: async () => ({}) } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: body.id,
            status: "ACCEPTED",
            // mobile_number is gone from provided_fields, so its new status is unknowable.
            provided_fields: { email_address: { type: "string", description: "Email" } },
          }),
        } as Response;
      });

      const results = await run();

      const schema = byId(results, "sep12.verification_response_schema");
      expect(schema?.status).toBe("fail");
      expect(schema?.message).toContain("provided_fields.mobile_number.status must be advanced");
      expect(schema?.message).toContain("got undefined");
    });

    it("skips malformed provided_fields entries when looking for VERIFICATION_REQUIRED", async () => {
      mockAnchor(
        (_body, authed) => {
          if (!authed) {
            return { ok: false, status: 403, json: async () => ({}) } as Response;
          }
          return { ok: false, status: 400, json: async () => ({ error: "bad code" }) } as Response;
        },
        {
          // A non-object entry must not crash the scan; validateSep12Fields owns
          // reporting its shape, so this check just steps over it.
          bogus_entry: "not-an-object",
          nested_array: [],
          mobile_number: {
            type: "string",
            description: "Mobile phone number",
            status: "VERIFICATION_REQUIRED",
          },
        },
      );

      const results = await run();

      // mobile_number was still found, so the flow ran rather than skipping.
      const wrongCode = byId(results, "sep12.verification_wrong_code");
      expect(wrongCode?.status).toBe("pass");
      expect(wrongCode?.message).toContain("HTTP 400");
    });

    it("does not exercise the flow when provided_fields is null or absent", async () => {
      mockAnchor(() => {
        throw new Error("PUT /customer/verification must not be called");
      }, null);

      const results = await run();

      const verificationChecks = results.filter((r) => r.id.startsWith("sep12.verification"));
      expect(verificationChecks).toHaveLength(3);
      expect(verificationChecks.every((r) => r.status === "warn")).toBe(true);
    });

    describe("--sep12-verification-code (operator-supplied correct code)", () => {
      /**
       * An anchor that behaves correctly: it rejects any code but the real one, and on the
       * real one advances the field. Without a supplied code this anchor can only ever
       * produce "not exercised" for the schema check.
       */
      const correctlyBehavingAnchor = () =>
        mockAnchor((body, authed) => {
          if (!authed) {
            return { ok: false, status: 403, json: async () => ({}) } as Response;
          }
          if (body.mobile_number_verification !== SUPPLIED_CODE) {
            return {
              ok: false,
              status: 400,
              json: async () => ({ error: "The provided confirmation code was invalid." }),
            } as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: body.id,
              status: "ACCEPTED",
              provided_fields: {
                mobile_number: {
                  type: "string",
                  description: "Mobile phone number",
                  status: "ACCEPTED",
                },
              },
            }),
          } as Response;
        });

      it("validates the real success response when a correct code is supplied", async () => {
        const fetchMock = correctlyBehavingAnchor();

        const results = await runWith({ verificationCode: SUPPLIED_CODE });

        // The success path now reaches a genuine verdict instead of "not exercised".
        const schema = byId(results, "sep12.verification_response_schema");
        expect(schema?.status).toBe("pass");
        expect(schema?.severity).toBe("error");
        expect(schema?.message).toContain("supplied confirmation code");
        expect(schema?.message).toContain("advanced to ACCEPTED");

        // The security assertion is not replaced by the supplied code: a random wrong
        // code still went first, and was still rejected.
        const wrongCode = byId(results, "sep12.verification_wrong_code");
        expect(wrongCode?.status).toBe("pass");
        expect(wrongCode?.message).toContain("The provided confirmation code was invalid.");

        const bodies = verificationBodies(fetchMock);
        expect(bodies[0].mobile_number_verification).toMatch(/^\d{6}$/);
        expect(bodies[0].mobile_number_verification).not.toBe(SUPPLIED_CODE);
        expect(bodies[1].mobile_number_verification).toBe(SUPPLIED_CODE);
      });

      it("never writes the supplied code into any result message", async () => {
        correctlyBehavingAnchor();

        const results = await runWith({ verificationCode: SUPPLIED_CODE });

        for (const check of results) {
          expect(check.message, check.id).not.toContain(SUPPLIED_CODE);
        }
      });

      it("reports a rejected supplied code distinctly from a malformed success body", async () => {
        // Every code is refused, including the operator's — a stale code, or a lockout
        // tripped by the wrong-code probe that necessarily runs first.
        mockAnchor((_body, authed) => {
          if (!authed) {
            return { ok: false, status: 403, json: async () => ({}) } as Response;
          }
          return {
            ok: false,
            status: 400,
            json: async () => ({ error: "The provided confirmation code was invalid." }),
          } as Response;
        });

        const results = await runWith({ verificationCode: SUPPLIED_CODE });

        const schema = byId(results, "sep12.verification_response_schema");
        // warn, not fail: the anchor's success response was never seen, so it has not
        // been shown to be wrong.
        expect(schema?.status).toBe("warn");
        expect(schema?.severity).toBe("warning");
        expect(schema?.message).toContain("rejected the supplied confirmation code");
        expect(schema?.message).toContain("HTTP 400");
        expect(schema?.message).toContain("lockout");
        expect(schema?.message).not.toContain(SUPPLIED_CODE);
      });

      it("fails the schema check when the supplied code is accepted with a malformed body", async () => {
        mockAnchor((body, authed) => {
          if (!authed) {
            return { ok: false, status: 403, json: async () => ({}) } as Response;
          }
          if (body.mobile_number_verification !== SUPPLIED_CODE) {
            return { ok: false, status: 400, json: async () => ({ error: "bad code" }) } as Response;
          }
          // Correct code accepted, but the field status is never advanced.
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: body.id,
              status: "ACCEPTED",
              provided_fields: {
                mobile_number: {
                  type: "string",
                  description: "Mobile phone number",
                  status: "VERIFICATION_REQUIRED",
                },
              },
            }),
          } as Response;
        });

        const results = await runWith({ verificationCode: SUPPLIED_CODE });

        const schema = byId(results, "sep12.verification_response_schema");
        expect(schema?.status).toBe("fail");
        expect(schema?.severity).toBe("error");
        expect(schema?.message).toContain("supplied confirmation code");
        expect(schema?.message).toContain("must be advanced to PROCESSING or ACCEPTED");
        // This is the anchor a correctly-rejecting run could never catch before.
        expect(byId(results, "sep12.verification_wrong_code")?.status).toBe("pass");
      });

      it("does not spend the supplied code on an anchor that accepts arbitrary codes", async () => {
        const fetchMock = mockAnchor((body, authed) => {
          if (!authed) {
            return { ok: false, status: 403, json: async () => ({}) } as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: body.id,
              status: "ACCEPTED",
              provided_fields: {
                mobile_number: { type: "string", description: "Mobile", status: "ACCEPTED" },
              },
            }),
          } as Response;
        });

        const results = await runWith({ verificationCode: SUPPLIED_CODE });

        expect(byId(results, "sep12.verification_wrong_code")?.status).toBe("fail");
        const schema = byId(results, "sep12.verification_response_schema");
        expect(schema?.status).toBe("pass");
        expect(schema?.message).toContain("arbitrary confirmation code");

        // Only the wrong-code probe and the unauthenticated probe were sent; the real
        // code was never put on the wire.
        const bodies = verificationBodies(fetchMock);
        expect(bodies.every((b: Record<string, unknown>) => b.mobile_number_verification !== SUPPLIED_CODE)).toBe(true);
      });

      it("does not exercise the flow when a code is supplied but no field requires verification", async () => {
        const fetchMock = mockAnchor(
          () => {
            throw new Error("PUT /customer/verification must not be called");
          },
          {
            mobile_number: { type: "string", description: "Mobile", status: "ACCEPTED" },
          },
        );

        const results = await runWith({ verificationCode: SUPPLIED_CODE });

        const verificationChecks = results.filter((r) => r.id.startsWith("sep12.verification"));
        expect(verificationChecks).toHaveLength(3);
        expect(verificationChecks.every((r) => r.status === "warn")).toBe(true);
        expect(
          verificationChecks.every((r) =>
            r.message.includes("did not flag any provided_field as VERIFICATION_REQUIRED"),
          ),
        ).toBe(true);
        expect(verificationBodies(fetchMock)).toHaveLength(0);
      });

      it("verifies the named field when --sep12-verification-field is supplied", async () => {
        const fetchMock = mockAnchor(
          (_body, authed) => {
            if (!authed) {
              return { ok: false, status: 403, json: async () => ({}) } as Response;
            }
            return { ok: false, status: 400, json: async () => ({ error: "bad code" }) } as Response;
          },
          {
            mobile_number: { type: "string", description: "Mobile", status: "VERIFICATION_REQUIRED" },
            email_address: { type: "string", description: "Email", status: "VERIFICATION_REQUIRED" },
          },
        );

        const results = await runWith({ verificationField: "email_address" });

        // email_address, not the first-flagged mobile_number.
        expect(verificationBodies(fetchMock)[0]).toHaveProperty("email_address_verification");
        expect(byId(results, "sep12.verification_wrong_code")?.status).toBe("pass");
      });

      it("does not exercise the flow when the named field is not awaiting verification", async () => {
        const fetchMock = mockAnchor(() => {
          throw new Error("PUT /customer/verification must not be called");
        });

        const results = await runWith({
          verificationCode: SUPPLIED_CODE,
          verificationField: "email_address",
        });

        const verificationChecks = results.filter((r) => r.id.startsWith("sep12.verification"));
        expect(verificationChecks).toHaveLength(3);
        for (const check of verificationChecks) {
          expect(check.status).toBe("warn");
          expect(check.message).toContain('"email_address" is not among the field(s)');
          expect(check.message).toContain("mobile_number");
        }
        expect(verificationBodies(fetchMock)).toHaveLength(0);
      });

      it("behaves exactly as before when no code is supplied", async () => {
        const fetchMock = correctlyBehavingAnchor();

        const results = await run();

        const schema = byId(results, "sep12.verification_response_schema");
        expect(schema?.status).toBe("warn");
        expect(schema?.message).toContain("cannot be known");
        // One authed wrong-code probe and one unauthenticated probe, as before.
        expect(verificationBodies(fetchMock)).toHaveLength(2);
      });
    });

    it("does not exercise the flow when PUT /customer returns no customer id", async () => {
      global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString();
        if (url === "https://kyc.example.com/customer" && init?.method === "PUT") {
          return { ok: true, status: 200, json: async () => ({ status: "ACCEPTED" }) } as Response;
        }
        if (init?.method === "DELETE") {
          return { ok: true, status: 200 } as Response;
        }
        throw new Error(`Unexpected request to ${url}`);
      }) as unknown as typeof fetch;

      const results = await run();

      const verificationChecks = results.filter((r) => r.id.startsWith("sep12.verification"));
      expect(verificationChecks).toHaveLength(3);
      expect(
        verificationChecks.every((r) => r.message.includes("did not return a customer id")),
      ).toBe(true);
    });
  });
});

