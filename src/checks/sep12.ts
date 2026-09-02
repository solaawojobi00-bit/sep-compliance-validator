import { randomUUID } from "node:crypto";
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
    return results;
  }

  const runId = randomUUID().slice(0, 8);
  const syntheticFirstName = "SEPVALIDATOR";
  const syntheticLastName = `Run-${runId}`;
  const syntheticEmail = `sepvalidator-${runId}@invalid.test`;

  const createdCustomerIds = new Set<string>();
  let customerId: string | undefined;

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

  // 4. Teardown: DELETE /customer/{account}
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
