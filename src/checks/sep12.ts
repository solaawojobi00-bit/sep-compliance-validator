import { randomInt, randomUUID } from "node:crypto";
import { fetchWithTimeout } from "../core/http.js";
import type { CheckResult } from "../core/report.js";
import type { StellarToml } from "./sep1.js";
import { validateSep12Fields } from "./sep12-fields.js";

export interface Sep12Options {
  domain: string;
  toml: StellarToml;
  network: "testnet" | "mainnet";
  jwt: string;
  timeoutMs?: number;
  noWrite?: boolean;
}

const VALID_SEP12_STATUSES = ["ACCEPTED", "PROCESSING", "NEEDS_INFO", "REJECTED"] as const;
type Sep12Status = (typeof VALID_SEP12_STATUSES)[number];

const VERIFICATION_CHECK_DESCRIPTIONS = {
  "sep12.verification_wrong_code":
    "PUT /customer/verification rejects an incorrect confirmation code",
  "sep12.verification_response_schema":
    "PUT /customer/verification success response is a customer object with the verified field advanced",
  "sep12.verification_unauthenticated": "PUT /customer/verification without authentication is rejected",
} as const;

type VerificationCheckId = keyof typeof VERIFICATION_CHECK_DESCRIPTIONS;

/** Pushes the same status/message under several verification check ids (shared skip). */
function pushVerificationResults(
  ids: readonly VerificationCheckId[],
  status: CheckResult["status"],
  severity: CheckResult["severity"],
  message: string,
  results: CheckResult[],
): void {
  for (const id of ids) {
    results.push({
      id,
      description: VERIFICATION_CHECK_DESCRIPTIONS[id],
      status,
      severity,
      message,
    });
  }
}

const ALL_VERIFICATION_CHECK_IDS = Object.keys(
  VERIFICATION_CHECK_DESCRIPTIONS,
) as VerificationCheckId[];

/**
 * Names the SEP-9 fields the anchor has flagged as awaiting a confirmation code, by
 * scanning `provided_fields` for `status: "VERIFICATION_REQUIRED"`. Shape errors are not
 * reported here — `validateSep12Fields` already owns that — so anything unexpected is
 * simply skipped.
 */
function collectVerificationRequiredFields(providedFields: unknown): string[] {
  if (!providedFields || typeof providedFields !== "object" || Array.isArray(providedFields)) {
    return [];
  }

  return Object.entries(providedFields as Record<string, unknown>)
    .filter(([, entry]) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return false;
      }
      return (entry as Record<string, unknown>).status === "VERIFICATION_REQUIRED";
    })
    .map(([key]) => key);
}

/** Reads one provided_fields entry's status, or undefined when absent/malformed. */
function providedFieldStatus(providedFields: unknown, field: string): string | undefined {
  if (!providedFields || typeof providedFields !== "object" || Array.isArray(providedFields)) {
    return undefined;
  }
  const entry = (providedFields as Record<string, unknown>)[field];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }
  const status = (entry as Record<string, unknown>).status;
  return typeof status === "string" ? status : undefined;
}

interface VerificationOptions {
  baseUrl: string;
  customerId: string;
  field: string;
  authHeader: Record<string, string>;
  timeoutMs: number | undefined;
}

/**
 * Validates `PUT /customer/verification`, the confirmation-code flow. When an anchor needs
 * to verify a field it already holds it returns that field in `provided_fields` with
 * status `VERIFICATION_REQUIRED`; the wallet then submits the code the user received as
 * `<field_name>_verification`.
 *
 * Only one live request carries a code, and it deliberately carries a *wrong* one — a
 * correct code cannot be known, since it is delivered out of band to a real user's phone
 * or inbox. So the wrong-code rejection is the assertion with teeth: an anchor that
 * answers 2xx has accepted an arbitrary code, which defeats the entire flow. The success
 * response schema can only be checked when an anchor does exactly that, so it reports
 * "not exercised" against a correctly-behaving anchor rather than claiming a pass it did
 * not verify.
 */
async function checkCustomerVerification(
  opts: VerificationOptions,
  results: CheckResult[],
): Promise<void> {
  const { baseUrl, customerId, field, authHeader, timeoutMs } = opts;
  const url = `${baseUrl}/customer/verification`;
  const verificationKey = `${field}_verification`;

  // Confirmation codes are conventionally six numeric digits, so a random code in that
  // shape exercises the wrong-code path faithfully: an anchor that rejected a
  // deliberately malformed value would tell us nothing about whether it checks codes at
  // all. The 1-in-10^6 chance of colliding with the live code is acceptable — in that
  // case the anchor genuinely did receive a correct code.
  const wrongCode = String(randomInt(100000, 1000000));

  let acceptedBody: Record<string, unknown> | undefined;

  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "PUT",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ id: customerId, [verificationKey]: wrongCode }),
      },
      timeoutMs,
    );

    if (res.ok) {
      try {
        acceptedBody = (await res.json()) as Record<string, unknown>;
      } catch {
        // Non-JSON success body; the schema check below reports it.
        acceptedBody = {};
      }
      results.push({
        id: "sep12.verification_wrong_code",
        description: VERIFICATION_CHECK_DESCRIPTIONS["sep12.verification_wrong_code"],
        status: "fail",
        severity: "error",
        message: `Anchor accepted an arbitrary confirmation code for ${verificationKey} with HTTP ${res.status}; any code will pass, so the verification flow provides no assurance`,
      });
    } else if (res.status === 400) {
      let errorMessage: string | undefined;
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body.error === "string" && body.error.trim().length > 0) {
          errorMessage = body.error;
        }
      } catch {
        // Non-JSON error body; noted in the message below.
      }
      results.push({
        id: "sep12.verification_wrong_code",
        description: VERIFICATION_CHECK_DESCRIPTIONS["sep12.verification_wrong_code"],
        status: "pass",
        severity: "error",
        message: errorMessage
          ? `Anchor correctly rejected an incorrect code with HTTP 400 and error "${errorMessage}"`
          : "Anchor correctly rejected an incorrect code with HTTP 400 (no descriptive 'error' field in the body)",
      });
    } else if (res.status === 404) {
      // SEP-12 reserves 404 for an unknown id, but this id came from PUT /customer
      // moments ago — so either the endpoint is unimplemented or the two endpoints
      // disagree about which customers exist.
      results.push({
        id: "sep12.verification_wrong_code",
        description: VERIFICATION_CHECK_DESCRIPTIONS["sep12.verification_wrong_code"],
        status: "fail",
        severity: "error",
        message: `PUT ${url} returned HTTP 404 for customer id ${customerId}, which PUT /customer returned in this same run; the endpoint is either unimplemented or disagrees with PUT /customer about which customers exist`,
      });
    } else if (res.status >= 400 && res.status < 500) {
      results.push({
        id: "sep12.verification_wrong_code",
        description: VERIFICATION_CHECK_DESCRIPTIONS["sep12.verification_wrong_code"],
        status: "pass",
        severity: "error",
        message: `Anchor rejected an incorrect code with HTTP ${res.status}; SEP-12 specifies 400 for this case, but the code was correctly refused`,
      });
    } else {
      results.push({
        id: "sep12.verification_wrong_code",
        description: VERIFICATION_CHECK_DESCRIPTIONS["sep12.verification_wrong_code"],
        status: "warn",
        severity: "warning",
        message: `Inconclusive: anchor returned HTTP ${res.status} for PUT ${url}`,
      });
    }
  } catch (err) {
    results.push({
      id: "sep12.verification_wrong_code",
      description: VERIFICATION_CHECK_DESCRIPTIONS["sep12.verification_wrong_code"],
      status: "fail",
      severity: "error",
      message: (err as Error).message,
    });
  }

  // Success-response schema. SEP-12: the body matches GET /customer, and "the field
  // statuses for which verifications were sent must be updated to either PROCESSING or
  // ACCEPTED".
  if (!acceptedBody) {
    results.push({
      id: "sep12.verification_response_schema",
      description: VERIFICATION_CHECK_DESCRIPTIONS["sep12.verification_response_schema"],
      status: "warn",
      severity: "warning",
      message: `Not exercised: no success response to validate, because a correct confirmation code for ${field} cannot be known (it is delivered out of band to the customer)`,
    });
  } else {
    const bodyId = acceptedBody.id;
    const bodyStatus = acceptedBody.status;
    const fieldStatus = providedFieldStatus(acceptedBody.provided_fields, field);

    const defects: string[] = [];
    if (bodyId !== customerId) {
      defects.push(`id must be "${customerId}", got ${JSON.stringify(bodyId)}`);
    }
    if (typeof bodyStatus !== "string" || !VALID_SEP12_STATUSES.includes(bodyStatus as Sep12Status)) {
      defects.push(
        `status must be one of ${VALID_SEP12_STATUSES.join(", ")}, got ${JSON.stringify(bodyStatus)}`,
      );
    }
    if (fieldStatus !== "PROCESSING" && fieldStatus !== "ACCEPTED") {
      defects.push(
        `provided_fields.${field}.status must be advanced to PROCESSING or ACCEPTED after a successful verification, got ${JSON.stringify(fieldStatus)}`,
      );
    }

    results.push({
      id: "sep12.verification_response_schema",
      description: VERIFICATION_CHECK_DESCRIPTIONS["sep12.verification_response_schema"],
      status: defects.length > 0 ? "fail" : "pass",
      severity: "error",
      message:
        defects.length > 0
          ? `Success response is not a conformant customer object: ${defects.join("; ")}`
          : `Success response is a customer object with id ${customerId}, status ${String(bodyStatus)}, and provided_fields.${field}.status advanced to ${String(fieldStatus)}`,
    });
  }

  // Negative: the endpoint mutates customer state, so SEP-12 requires the SEP-10 JWT.
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: customerId, [verificationKey]: wrongCode }),
      },
      timeoutMs,
    );

    if (res.status === 401 || res.status === 403) {
      results.push({
        id: "sep12.verification_unauthenticated",
        description: VERIFICATION_CHECK_DESCRIPTIONS["sep12.verification_unauthenticated"],
        status: "pass",
        severity: "error",
        message: `Anchor correctly rejected unauthenticated PUT /customer/verification with HTTP ${res.status}`,
      });
    } else if (res.ok) {
      results.push({
        id: "sep12.verification_unauthenticated",
        description: VERIFICATION_CHECK_DESCRIPTIONS["sep12.verification_unauthenticated"],
        status: "fail",
        severity: "error",
        message: `AUTHENTICATION BYPASS: Anchor verified a customer field from an unauthenticated PUT /customer/verification request (HTTP ${res.status})`,
      });
    } else {
      results.push({
        id: "sep12.verification_unauthenticated",
        description: VERIFICATION_CHECK_DESCRIPTIONS["sep12.verification_unauthenticated"],
        status: "warn",
        severity: "warning",
        message: `Anchor returned HTTP ${res.status} for unauthenticated PUT /customer/verification (expected 401 or 403); inconclusive`,
      });
    }
  } catch (err) {
    results.push({
      id: "sep12.verification_unauthenticated",
      description: VERIFICATION_CHECK_DESCRIPTIONS["sep12.verification_unauthenticated"],
      status: "fail",
      severity: "error",
      message: (err as Error).message,
    });
  }
}

export async function runSep12Checks(opts: Sep12Options): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const kycServer =
    opts.toml.kycServer ??
    opts.toml.transferServer ??
    (typeof opts.toml.raw.KYC_SERVER === "string"
      ? opts.toml.raw.KYC_SERVER
      : typeof opts.toml.raw.TRANSFER_SERVER === "string"
        ? opts.toml.raw.TRANSFER_SERVER
        : undefined);

  if (!kycServer) {
    results.push({
      id: "sep12.skipped",
      description: "Run SEP-12 KYC endpoint checks",
      status: "warn",
      severity: "warning",
      message: "Skipped: KYC_SERVER or TRANSFER_SERVER missing from stellar.toml",
    });
    return results;
  }

  if (!opts.jwt) {
    results.push({
      id: "sep12.skipped",
      description: "Run SEP-12 KYC endpoint checks",
      status: "warn",
      severity: "error",
      message: "Skipped: valid SEP-10 JWT is required to run SEP-12 checks",
    });
    return results;
  }

  const baseUrl = kycServer.replace(/\/+$/, "");
  const authHeader = {
    Authorization: `Bearer ${opts.jwt}`,
  };

  // If --no-write is enabled, skip mutating operations
  if (opts.noWrite) {
    results.push({
      id: "sep12.put_customer",
      description: "PUT /customer accepts minimal valid KYC field set",
      status: "warn",
      severity: "warning",
      message: "Skipped: --no-write mode enabled; mutating PUT /customer request omitted",
    });
    results.push({
      id: "sep12.get_customer",
      description: "GET /customer returns existing customer record",
      status: "warn",
      severity: "warning",
      message: "Skipped: --no-write mode enabled; no customer record created to fetch by id",
    });
    results.push({
      id: "sep12.put_malformed_field",
      description: "PUT /customer rejects malformed fields with error response",
      status: "warn",
      severity: "warning",
      message: "Skipped: --no-write mode enabled; mutating PUT /customer request omitted",
    });
    pushVerificationResults(
      ALL_VERIFICATION_CHECK_IDS,
      "warn",
      "warning",
      "Skipped: --no-write mode enabled; mutating PUT /customer/verification request omitted",
      results,
    );
    return results;
  }

  const runId = randomUUID().slice(0, 8);
  const syntheticFirstName = "SEPVALIDATOR";
  const syntheticLastName = `Run-${runId}`;
  const syntheticEmail = `sepvalidator-${runId}@invalid.test`;

  const createdCustomerIds = new Set<string>();
  let customerId: string | undefined;
  let verificationRequiredFields: string[] = [];

  let account: string | undefined;
  try {
    const parts = opts.jwt.split(".");
    if (parts.length >= 2) {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
      if (typeof payload.sub === "string") {
        account = payload.sub.split(":")[0];
      }
    }
  } catch {
    // ignore non-base64 or mock tokens
  }

  // 1. PUT /customer with minimal valid field set
  try {
    const putRes = await fetchWithTimeout(`${baseUrl}/customer`, {
      method: "PUT",
      headers: {
        ...authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        first_name: syntheticFirstName,
        last_name: syntheticLastName,
        email_address: syntheticEmail,
      }),
    }, opts.timeoutMs);

    if (!putRes.ok) {
      results.push({
        id: "sep12.put_customer",
        description: "PUT /customer accepts minimal valid KYC field set",
        status: "fail",
        severity: "error",
        message: `PUT ${baseUrl}/customer returned HTTP ${putRes.status}`,
      });
    } else {
      const body = (await putRes.json()) as { id?: string; status?: string };
      const hasId = typeof body.id === "string" && body.id.trim().length > 0;
      if (hasId) {
        customerId = body.id!.trim();
        createdCustomerIds.add(customerId);
      }

      const hasInvalidStatus =
        body.status !== undefined &&
        (typeof body.status !== "string" ||
          !VALID_SEP12_STATUSES.includes(body.status as Sep12Status));

      if (!hasId) {
        results.push({
          id: "sep12.put_customer",
          description: "PUT /customer accepts minimal valid KYC field set",
          status: "fail",
          severity: "error",
          message: `PUT response invalid: missing or empty customer id (got id=${body.id})`,
        });
      } else if (hasInvalidStatus) {
        results.push({
          id: "sep12.put_customer",
          description: "PUT /customer accepts minimal valid KYC field set",
          status: "fail",
          severity: "error",
          message: `PUT response invalid: status "${body.status}" is not one of ${VALID_SEP12_STATUSES.join(", ")}`,
        });
      } else {
        const statusMsg = body.status ? ` with status ${body.status}` : "";
        results.push({
          id: "sep12.put_customer",
          description: "PUT /customer accepts minimal valid KYC field set",
          status: "pass",
          severity: "error",
          message: `PUT /customer returned customer id (${customerId})${statusMsg}`,
        });
      }
    }
  } catch (err) {
    results.push({
      id: "sep12.put_customer",
      description: "PUT /customer accepts minimal valid KYC field set",
      status: "fail",
      severity: "error",
      message: (err as Error).message,
    });
  }

  // 2. GET /customer?id=... (with JWT) returns the same customer record
  if (customerId) {
    try {
      const getUrl = `${baseUrl}/customer?id=${encodeURIComponent(customerId)}`;
      const getRes = await fetchWithTimeout(getUrl, {
        headers: {
          ...authHeader,
        },
      }, opts.timeoutMs);

      if (!getRes.ok) {
        results.push({
          id: "sep12.get_customer",
          description: "GET /customer returns existing customer record",
          status: "fail",
          severity: "error",
          message: `GET ${getUrl} returned HTTP ${getRes.status}`,
        });
      } else {
        const body = (await getRes.json()) as {
          id?: string;
          status?: string;
          fields?: unknown;
          provided_fields?: unknown;
        };
        const hasMatchingId = body.id === customerId;
        const isValidStatus =
          typeof body.status === "string" &&
          VALID_SEP12_STATUSES.includes(body.status as Sep12Status);

        if (!hasMatchingId || !isValidStatus) {
          results.push({
            id: "sep12.get_customer",
            description: "GET /customer returns existing customer record",
            status: "fail",
            severity: "error",
            message: `GET response mismatch: expected id=${customerId}, got id=${body.id}, status=${body.status}`,
          });
        } else {
          results.push({
            id: "sep12.get_customer",
            description: "GET /customer returns existing customer record",
            status: "pass",
            severity: "error",
            message: `GET /customer returned consistent record with id ${body.id} and status ${body.status}`,
          });
        }

        validateSep12Fields(body.fields, body.provided_fields, body.status, results);
        verificationRequiredFields = collectVerificationRequiredFields(body.provided_fields);
      }
    } catch (err) {
      results.push({
        id: "sep12.get_customer",
        description: "GET /customer returns existing customer record",
        status: "fail",
        severity: "error",
        message: (err as Error).message,
      });
    }
  } else {
    results.push({
      id: "sep12.get_customer",
      description: "GET /customer returns existing customer record",
      status: "fail",
      severity: "error",
      message: "Skipped GET /customer check because PUT /customer did not return a customer id",
    });
  }

  // 3. Negative check: submitting malformed email_address results in error response
  try {
    const invalidPutRes = await fetchWithTimeout(`${baseUrl}/customer`, {
      method: "PUT",
      headers: {
        ...authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        first_name: syntheticFirstName,
        last_name: syntheticLastName,
        email_address: "not-an-email-address",
      }),
    }, opts.timeoutMs);

    try {
      const invalidBody = (await invalidPutRes.json()) as { id?: string; status?: string; error?: string };
      if (typeof invalidBody.id === "string" && invalidBody.id.trim().length > 0) {
        createdCustomerIds.add(invalidBody.id);
      }
    } catch {
      // ignore parse error if body is non-json
    }

    if (invalidPutRes.status === 400 || (invalidPutRes.status >= 400 && invalidPutRes.status < 500)) {
      results.push({
        id: "sep12.put_malformed_field",
        description: "PUT /customer rejects malformed fields with error response",
        status: "pass",
        severity: "error",
        message: `PUT /customer rejected malformed email_address with HTTP ${invalidPutRes.status}`,
      });
    } else {
      let body: { status?: string; error?: string } = {};
      try {
        body = (await invalidPutRes.json()) as { status?: string; error?: string };
      } catch {
        // ignore parse error if body is text
      }

      if (body.status === "ACCEPTED") {
        results.push({
          id: "sep12.put_malformed_field",
          description: "PUT /customer rejects malformed fields with error response",
          status: "fail",
          severity: "error",
          message: 'PUT /customer silently accepted malformed email_address with status "ACCEPTED"; expected HTTP 400',
        });
      } else {
        results.push({
          id: "sep12.put_malformed_field",
          description: "PUT /customer rejects malformed fields with error response",
          status: "pass",
          severity: "error",
          message: `PUT /customer handled malformed field with HTTP ${invalidPutRes.status} and status ${body.status ?? "non-ACCEPTED"}`,
        });
      }
    }
  } catch (err) {
    results.push({
      id: "sep12.put_malformed_field",
      description: "PUT /customer rejects malformed fields with error response",
      status: "fail",
      severity: "error",
      message: (err as Error).message,
    });
  }

  // 4. PUT /customer/verification confirmation-code flow. Only reachable when the anchor
  // actually asked for a code; most anchors will not for a synthetic customer with a
  // randomized @invalid.test email, so the skip message has to make clear the flow was
  // never exercised rather than verified.
  if (!customerId) {
    pushVerificationResults(
      ALL_VERIFICATION_CHECK_IDS,
      "warn",
      "warning",
      "Not exercised: PUT /customer did not return a customer id, so the verification flow could not be reached",
      results,
    );
  } else if (verificationRequiredFields.length === 0) {
    pushVerificationResults(
      ALL_VERIFICATION_CHECK_IDS,
      "warn",
      "warning",
      "Not exercised: the anchor did not flag any provided_field as VERIFICATION_REQUIRED for this synthetic customer, so the confirmation-code flow was never triggered and remains unverified",
      results,
    );
  } else {
    await checkCustomerVerification(
      {
        baseUrl,
        customerId,
        // One field is enough to exercise the endpoint; SEP-12 accepts several
        // <field>_verification values per request, but a second adds no new assertion.
        field: verificationRequiredFields[0],
        authHeader,
        timeoutMs: opts.timeoutMs,
      },
      results,
    );
  }

  // 5. Teardown: DELETE /customer/{account}
  if (createdCustomerIds.size > 0) {
    const targetIdentifier = account ?? customerId;
    if (targetIdentifier) {
      const deleteUrl = `${baseUrl}/customer/${encodeURIComponent(targetIdentifier)}`;
      try {
        const deleteRes = await fetchWithTimeout(deleteUrl, {
          method: "DELETE",
          headers: {
            ...authHeader,
          },
        }, opts.timeoutMs);

        if (deleteRes.ok || deleteRes.status === 200 || deleteRes.status === 204) {
          results.push({
            id: "sep12.delete_customer",
            description: "DELETE /customer/{account} cleans up test customer data",
            status: "pass",
            severity: "warning",
            message: `DELETE ${deleteUrl} returned HTTP ${deleteRes.status}; test customer data successfully cleaned up`,
          });
        } else {
          results.push({
            id: "sep12.delete_customer",
            description: "DELETE /customer/{account} cleans up test customer data",
            status: "warn",
            severity: "warning",
            message: `Teardown DELETE ${deleteUrl} failed with HTTP ${deleteRes.status}; created customer id(s) [${[...createdCustomerIds].join(", ")}] may have leaked`,
          });
        }
      } catch (err) {
        results.push({
          id: "sep12.delete_customer",
          description: "DELETE /customer/{account} cleans up test customer data",
          status: "warn",
          severity: "warning",
          message: `Teardown DELETE ${deleteUrl} error (${(err as Error).message}); created customer id(s) [${[...createdCustomerIds].join(", ")}] may have leaked`,
        });
      }
    }
  }

  return results;
}
