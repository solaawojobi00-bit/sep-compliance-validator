import { fetchWithTimeout } from "../core/http.js";
import type { CheckResult } from "../core/report.js";
import type { StellarToml } from "./sep1.js";

export interface Sep12Options {
  domain: string;
  toml: StellarToml;
  network: "testnet" | "mainnet";
  jwt: string;
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

  let customerId: string | undefined;

  // 1. PUT /customer with minimal valid field set
  try {
    const putRes = await fetchWithTimeout(`${baseUrl}/customer`, {
      method: "PUT",
      headers: {
        ...authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        first_name: "Jane",
        last_name: "Doe",
        email_address: "jane.doe@example.com",
      }),
    });

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
      const isValidStatus =
        typeof body.status === "string" &&
        VALID_SEP12_STATUSES.includes(body.status as Sep12Status);

      if (!hasId || !isValidStatus) {
        results.push({
          id: "sep12.put_customer",
          description: "PUT /customer accepts minimal valid KYC field set",
          status: "fail",
          severity: "error",
          message: `PUT response invalid: id=${body.id}, status=${body.status} (expected valid id and status in ${VALID_SEP12_STATUSES.join(", ")})`,
        });
      } else {
        customerId = body.id;
        results.push({
          id: "sep12.put_customer",
          description: "PUT /customer accepts minimal valid KYC field set",
          status: "pass",
          severity: "error",
          message: `PUT /customer returned customer id (${body.id}) with status ${body.status}`,
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
      });

      if (!getRes.ok) {
        results.push({
          id: "sep12.get_customer",
          description: "GET /customer returns existing customer record",
          status: "fail",
          severity: "error",
          message: `GET ${getUrl} returned HTTP ${getRes.status}`,
        });
      } else {
        const body = (await getRes.json()) as { id?: string; status?: string };
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
        first_name: "Jane",
        last_name: "Doe",
        email_address: "not-an-email-address",
      }),
    });

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

  return results;
}
