import { describe, expect, it } from "vitest";
import type { CheckResult } from "../src/core/report.js";
import { SEP9_STANDARD_FIELDS, validateSep12Fields } from "../src/checks/sep12-fields.js";

function run(
  fields: unknown,
  providedFields: unknown,
  customerStatus?: string,
): CheckResult[] {
  const results: CheckResult[] = [];
  validateSep12Fields(fields, providedFields, customerStatus, results);
  return results;
}

describe("SEP-12 fields / provided_fields schema validation", () => {
  it("passes a fully conformant multi-field fixture silently", () => {
    const results = run(
      {
        email_address: { type: "string", description: "Email address" },
        photo_id_front: {
          type: "binary",
          description: "Image of front of user's photo ID",
          optional: true,
        },
        id_type: {
          type: "string",
          description: "Type of ID",
          choices: ["passport", "id_card"],
        },
      },
      {
        first_name: { type: "string", description: "Given name", status: "ACCEPTED" },
        last_name: {
          type: "string",
          description: "Family name",
          status: "REJECTED",
          error: "Does not match photo ID",
        },
      },
      "NEEDS_INFO",
    );

    expect(results).toHaveLength(0);
  });

  it("is silent when both fields and provided_fields are absent on an ACCEPTED customer", () => {
    const results = run(undefined, undefined, "ACCEPTED");
    expect(results).toHaveLength(0);
  });

  it("treats null fields/provided_fields the same as absent", () => {
    const results = run(null, null, "ACCEPTED");
    expect(results).toHaveLength(0);
  });

  it("fails when fields is not an object", () => {
    const results = run("not-an-object", undefined, "ACCEPTED");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("sep12.fields.shape");
    expect(results[0].status).toBe("fail");
    expect(results[0].message).toContain("got string");
  });

  it("fails when fields is an array", () => {
    const results = run([{ type: "string" }], undefined, "ACCEPTED");
    expect(results[0].id).toBe("sep12.fields.shape");
    expect(results[0].status).toBe("fail");
    expect(results[0].message).toContain("got array");
  });

  it("fails when provided_fields is not an object", () => {
    const results = run(undefined, 42, "ACCEPTED");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("sep12.provided_fields.shape");
    expect(results[0].status).toBe("fail");
  });

  it("fails when a field entry is not itself an object", () => {
    const results = run({ email_address: "should-be-an-object" }, undefined, "ACCEPTED");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("sep12.fields.entry_shape");
    expect(results[0].status).toBe("fail");
    expect(results[0].message).toContain("fields.email_address");
    expect(results[0].message).toContain("got string");
  });

  it("fails when a field entry is an array rather than an object", () => {
    const results = run({ email_address: ["type", "description"] }, undefined, "ACCEPTED");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("sep12.fields.entry_shape");
    expect(results[0].message).toContain("got array");
  });

  it("fails when type is missing", () => {
    const results = run(
      { email_address: { description: "Email address" } },
      undefined,
      "ACCEPTED",
    );
    const typeCheck = results.find((r) => r.id === "sep12.fields.type");
    expect(typeCheck?.status).toBe("fail");
    expect(typeCheck?.message).toContain("fields.email_address");
    expect(typeCheck?.message).toContain("missing");
  });

  it("fails when type is outside the four permitted values", () => {
    const results = run(
      { email_address: { type: "integer", description: "Email address" } },
      undefined,
      "ACCEPTED",
    );
    const typeCheck = results.find((r) => r.id === "sep12.fields.type");
    expect(typeCheck?.status).toBe("fail");
    expect(typeCheck?.message).toContain("fields.email_address");
    expect(typeCheck?.message).toContain('"integer"');
  });

  it("fails when description is missing", () => {
    const results = run({ email_address: { type: "string" } }, undefined, "ACCEPTED");
    const descCheck = results.find((r) => r.id === "sep12.fields.description");
    expect(descCheck?.status).toBe("fail");
    expect(descCheck?.message).toContain("fields.email_address");
  });

  it("fails when description is an empty string", () => {
    const results = run(
      { email_address: { type: "string", description: "   " } },
      undefined,
      "ACCEPTED",
    );
    const descCheck = results.find((r) => r.id === "sep12.fields.description");
    expect(descCheck?.status).toBe("fail");
  });

  it("fails when choices is present but not an array", () => {
    const results = run(
      { id_type: { type: "string", description: "Type of ID", choices: "passport" } },
      undefined,
      "ACCEPTED",
    );
    const choicesCheck = results.find((r) => r.id === "sep12.fields.choices");
    expect(choicesCheck?.status).toBe("fail");
    expect(choicesCheck?.message).toContain("fields.id_type");
  });

  it("fails when optional is present but not a boolean", () => {
    const results = run(
      { email_address: { type: "string", description: "Email address", optional: "yes" } },
      undefined,
      "ACCEPTED",
    );
    const optionalCheck = results.find((r) => r.id === "sep12.fields.optional");
    expect(optionalCheck?.status).toBe("fail");
    expect(optionalCheck?.message).toContain("fields.email_address");
  });

  it("warns (not fails) on a field name outside the SEP-9 standard set", () => {
    const results = run(
      { my_custom_field: { type: "string", description: "Something anchor-specific" } },
      undefined,
      "ACCEPTED",
    );
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("sep12.fields.unknown_name");
    expect(results[0].status).toBe("warn");
    expect(results[0].message).toContain("my_custom_field");
  });

  it("does not warn for every recognized SEP-9 standard field name", () => {
    for (const name of SEP9_STANDARD_FIELDS) {
      const results = run(
        { [name]: { type: "string", description: "d" } },
        undefined,
        "ACCEPTED",
      );
      expect(results.some((r) => r.id === "sep12.fields.unknown_name")).toBe(false);
    }
  });

  it("fails when a provided_fields entry status is outside the permitted enum", () => {
    const results = run(
      undefined,
      { email_address: { type: "string", description: "Email address", status: "DONE" } },
      "ACCEPTED",
    );
    const statusCheck = results.find((r) => r.id === "sep12.provided_fields.status");
    expect(statusCheck?.status).toBe("fail");
    expect(statusCheck?.message).toContain("provided_fields.email_address");
    expect(statusCheck?.message).toContain("DONE");
  });

  it("accepts VERIFICATION_REQUIRED as a valid provided_fields status", () => {
    const results = run(
      undefined,
      {
        mobile_number: {
          type: "string",
          description: "Mobile number",
          status: "VERIFICATION_REQUIRED",
        },
      },
      "ACCEPTED",
    );
    expect(results.some((r) => r.id === "sep12.provided_fields.status")).toBe(false);
  });

  it("warns when a REJECTED provided_fields entry has no error message", () => {
    const results = run(
      undefined,
      { email_address: { type: "string", description: "Email address", status: "REJECTED" } },
      "ACCEPTED",
    );
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("sep12.provided_fields.rejected_no_error");
    expect(results[0].status).toBe("warn");
    expect(results[0].message).toContain("email_address");
  });

  it("does not warn when a REJECTED provided_fields entry includes an error message", () => {
    const results = run(
      undefined,
      {
        email_address: {
          type: "string",
          description: "Email address",
          status: "REJECTED",
          error: "Domain does not match a known provider",
        },
      },
      "ACCEPTED",
    );
    expect(results).toHaveLength(0);
  });

  it("fails when customer status is NEEDS_INFO but fields is absent", () => {
    const results = run(undefined, undefined, "NEEDS_INFO");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("sep12.fields.needs_info_empty");
    expect(results[0].status).toBe("fail");
    expect(results[0].message).toContain("absent");
  });

  it("fails when customer status is NEEDS_INFO but fields is an empty object", () => {
    const results = run({}, undefined, "NEEDS_INFO");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("sep12.fields.needs_info_empty");
    expect(results[0].message).toContain("empty");
  });

  it("does not fail the NEEDS_INFO rule when fields is non-empty", () => {
    const results = run(
      { email_address: { type: "string", description: "Email address" } },
      undefined,
      "NEEDS_INFO",
    );
    expect(results.some((r) => r.id === "sep12.fields.needs_info_empty")).toBe(false);
  });

  it("names every offending field key across a multi-field response", () => {
    const results = run(
      {
        email_address: { type: "string", description: "d" },
        bad_type: { type: "integer", description: "d" },
        bad_description: { type: "string" },
      },
      undefined,
      "ACCEPTED",
    );

    const messages = results.map((r) => r.message).join("\n");
    expect(messages).toContain("fields.bad_type");
    expect(messages).toContain("fields.bad_description");
    expect(messages).not.toContain("fields.email_address");
  });
});
