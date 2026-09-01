import { fetchWithTimeout } from "../core/http.js";
import type { CheckResult } from "../core/report.js";
import { runSep24BrowserChecks } from "./sep24-browser.js";
import type { StellarToml } from "./sep1.js";

export interface Sep24Options {
  domain: string;
  toml: StellarToml;
  network: "testnet" | "mainnet";
  jwt: string;
  timeoutMs?: number;
  interactiveBrowser?: boolean;
}

export const VALID_SEP24_STATUSES = [
  "incomplete",
  "pending_user_transfer_start",
  "pending_usr_transfer_complete",
  "pending_external",
  "pending_anchor",
  "pending_stellar",
  "pending_trust",
  "pending_user",
  "completed",
  "refunded",
  "expired",
  "no_market",
  "too_small",
  "too_large",
  "error",
] as const;

export type Sep24Status = (typeof VALID_SEP24_STATUSES)[number];

interface AssetInfo {
  enabled?: boolean;
  min_amount?: number;
  max_amount?: number;
}

interface Sep24InfoResponse {
  deposit?: Record<string, AssetInfo>;
  withdraw?: Record<string, AssetInfo>;
  fee?: { enabled?: boolean };
}

export async function runSep24Checks(opts: Sep24Options): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const server =
    opts.toml.transferServerSep24 ??
    (typeof opts.toml.raw.TRANSFER_SERVER_SEP0024 === "string"
      ? opts.toml.raw.TRANSFER_SERVER_SEP0024
      : undefined);

  if (!server) {
    results.push({
      id: "sep24.skipped",
      description: "Run SEP-24 interactive deposit/withdraw checks",
      status: "warn",
      severity: "warning",
      message: "Skipped: TRANSFER_SERVER_SEP0024 missing from stellar.toml",
    });
    return results;
  }

  if (!opts.jwt) {
    results.push({
      id: "sep24.skipped",
      description: "Run SEP-24 interactive deposit/withdraw checks",
      status: "warn",
      severity: "error",
      message: "Skipped: valid SEP-10 JWT is required to run SEP-24 checks",
    });
    return results;
  }

  const baseUrl = server.replace(/\/+$/, "");
  const authHeader = {
    Authorization: `Bearer ${opts.jwt}`,
  };

  let depositAssetCode = "USDC";

  // 1. GET /info endpoint check
  try {
    const res = await fetchWithTimeout(`${baseUrl}/info`, {}, opts.timeoutMs);
    if (!res.ok) {
      results.push({
        id: "sep24.info",
        description: "Fetch SEP-24 /info to discover supported assets",
        status: "fail",
        severity: "error",
        message: `GET ${baseUrl}/info returned HTTP ${res.status}`,
      });
    } else {
      const data = (await res.json()) as Sep24InfoResponse;
      const hasDepositOrWithdraw =
        (data.deposit && typeof data.deposit === "object") ||
        (data.withdraw && typeof data.withdraw === "object");

      if (!hasDepositOrWithdraw) {
        results.push({
          id: "sep24.info",
          description: "Fetch SEP-24 /info to discover supported assets",
          status: "fail",
          severity: "error",
          message: 'Response JSON missing "deposit" or "withdraw" object',
        });
      } else {
        // Validate asset fields
        let invalidFieldsCount = 0;
        const allAssets: Array<[string, AssetInfo]> = [
          ...Object.entries(data.deposit ?? {}),
          ...Object.entries(data.withdraw ?? {}),
        ];

        for (const [, info] of allAssets) {
          if (typeof info.enabled !== "boolean") {
            invalidFieldsCount++;
          }
          if (info.min_amount !== undefined && typeof info.min_amount !== "number") {
            invalidFieldsCount++;
          }
          if (info.max_amount !== undefined && typeof info.max_amount !== "number") {
            invalidFieldsCount++;
          }
        }

        if (invalidFieldsCount > 0) {
          results.push({
            id: "sep24.info",
            description: "Fetch SEP-24 /info to discover supported assets",
            status: "fail",
            severity: "error",
            message: `Discovered ${invalidFieldsCount} asset(s) with incorrectly-typed enabled, min_amount, or max_amount fields`,
          });
        } else {
          results.push({
            id: "sep24.info",
            description: "Fetch SEP-24 /info to discover supported assets",
            status: "pass",
            severity: "error",
            message: `Discovered valid deposit/withdraw asset metadata from ${baseUrl}/info`,
          });

          // Pick an enabled deposit asset code if available
          if (data.deposit) {
            const enabledEntry = Object.entries(data.deposit).find(
              ([, info]) => info.enabled !== false,
            );
            if (enabledEntry) {
              depositAssetCode = enabledEntry[0];
            }
          }
        }
      }
    }
  } catch (err) {
    results.push({
      id: "sep24.info",
      description: "Fetch SEP-24 /info to discover supported assets",
      status: "fail",
      severity: "error",
      message: (err as Error).message,
    });
  }

  // 2. POST /transactions/deposit/interactive check
  let interactiveUrl: string | undefined;
  let transactionId: string | undefined;

  try {
    const depositRes = await fetchWithTimeout(
      `${baseUrl}/transactions/deposit/interactive`,
      {
        method: "POST",
        headers: {
          ...authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          asset_code: depositAssetCode,
        }),
      },
      opts.timeoutMs,
    );

    if (!depositRes.ok) {
      results.push({
        id: "sep24.deposit_interactive",
        description:
          "POST /transactions/deposit/interactive returns interactive response with url and id",
        status: "fail",
        severity: "error",
        message: `POST ${baseUrl}/transactions/deposit/interactive returned HTTP ${depositRes.status}`,
      });
    } else {
      const body = (await depositRes.json()) as {
        type?: string;
        url?: string;
        id?: string;
      };

      const isInteractiveType = body.type === "interactive_customer_info_needed";
      const hasValidId = typeof body.id === "string" && body.id.trim().length > 0;
      const hasValidUrl = typeof body.url === "string" && body.url.trim().length > 0;

      if (!isInteractiveType || !hasValidId || !hasValidUrl) {
        results.push({
          id: "sep24.deposit_interactive",
          description:
            "POST /transactions/deposit/interactive returns interactive response with url and id",
          status: "fail",
          severity: "error",
          message: `Expected type="interactive_customer_info_needed" and valid url/id, received: type=${body.type}, id=${body.id}, url=${body.url}`,
        });
      } else {
        interactiveUrl = body.url;
        transactionId = body.id;
        results.push({
          id: "sep24.deposit_interactive",
          description:
            "POST /transactions/deposit/interactive returns interactive response with url and id",
          status: "pass",
          severity: "error",
          message: `Received interactive response with id ${body.id}`,
        });
      }
    }
  } catch (err) {
    results.push({
      id: "sep24.deposit_interactive",
      description:
        "POST /transactions/deposit/interactive returns interactive response with url and id",
      status: "fail",
      severity: "error",
      message: (err as Error).message,
    });
  }

  // 3. Interactive URL reachability check (simple GET / HEAD)
  if (interactiveUrl) {
    try {
      const parsedUrl = new URL(interactiveUrl);
      const isHttps = parsedUrl.protocol === "https:";

      if (!isHttps) {
        results.push({
          id: "sep24.interactive_url_reachable",
          description: "Interactive URL is a well-formed, reachable HTTPS URL",
          status: "fail",
          severity: "error",
          message: `Interactive URL protocol must be https:, got: ${parsedUrl.protocol}`,
        });
      } else {
        const urlCheckRes = await fetchWithTimeout(
          interactiveUrl,
          {
            method: "GET",
          },
          opts.timeoutMs,
        );

        // 2xx, 3xx, or 4xx (e.g. auth/cookie prompt) indicates server reachable; 5xx is server error
        if (urlCheckRes.status >= 500) {
          results.push({
            id: "sep24.interactive_url_reachable",
            description: "Interactive URL is a well-formed, reachable HTTPS URL",
            status: "fail",
            severity: "error",
            message: `Interactive URL ${interactiveUrl} returned HTTP ${urlCheckRes.status}`,
          });
        } else {
          results.push({
            id: "sep24.interactive_url_reachable",
            description: "Interactive URL is a well-formed, reachable HTTPS URL",
            status: "pass",
            severity: "error",
            message: `Interactive URL is well-formed HTTPS and reachable (HTTP ${urlCheckRes.status})`,
          });
        }
      }
    } catch (err) {
      results.push({
        id: "sep24.interactive_url_reachable",
        description: "Interactive URL is a well-formed, reachable HTTPS URL",
        status: "fail",
        severity: "error",
        message: `Failed to reach interactive URL ${interactiveUrl}: ${(err as Error).message}`,
      });
    }

    if (opts.interactiveBrowser) {
      const browserResult = await runSep24BrowserChecks({
        interactiveUrl,
        timeoutMs: opts.timeoutMs,
      });
      results.push(...browserResult.results);
    }
  } else {
    results.push({
      id: "sep24.interactive_url_reachable",
      description: "Interactive URL is a well-formed, reachable HTTPS URL",
      status: "fail",
      severity: "error",
      message: "Skipped: no interactive URL returned by POST /transactions/deposit/interactive",
    });
  }

  // 4. GET /transaction?id=... check
  if (transactionId) {
    try {
      const txUrl = `${baseUrl}/transaction?id=${encodeURIComponent(transactionId)}`;
      const txRes = await fetchWithTimeout(
        txUrl,
        {
          headers: {
            ...authHeader,
          },
        },
        opts.timeoutMs,
      );

      if (!txRes.ok) {
        results.push({
          id: "sep24.transaction_status",
          description: "GET /transaction returns record with valid SEP-24 status",
          status: "fail",
          severity: "error",
          message: `GET ${txUrl} returned HTTP ${txRes.status}`,
        });
      } else {
        const body = (await txRes.json()) as {
          transaction?: {
            id?: string;
            status?: string;
          };
        };

        const txObj = body.transaction;
        const hasMatchingId = txObj?.id === transactionId;
        const hasValidStatus =
          typeof txObj?.status === "string" &&
          VALID_SEP24_STATUSES.includes(txObj.status as Sep24Status);

        if (!txObj || !hasMatchingId || !hasValidStatus) {
          results.push({
            id: "sep24.transaction_status",
            description: "GET /transaction returns record with valid SEP-24 status",
            status: "fail",
            severity: "error",
            message: `Invalid transaction response: id=${txObj?.id}, status=${txObj?.status} (expected id=${transactionId} and valid status from SEP-24 enum)`,
          });
        } else {
          results.push({
            id: "sep24.transaction_status",
            description: "GET /transaction returns record with valid SEP-24 status",
            status: "pass",
            severity: "error",
            message: `Transaction record matches id ${txObj.id} with valid status "${txObj.status}"`,
          });
        }
      }
    } catch (err) {
      results.push({
        id: "sep24.transaction_status",
        description: "GET /transaction returns record with valid SEP-24 status",
        status: "fail",
        severity: "error",
        message: (err as Error).message,
      });
    }
  } else {
    results.push({
      id: "sep24.transaction_status",
      description: "GET /transaction returns record with valid SEP-24 status",
      status: "fail",
      severity: "error",
      message: "Skipped: no transaction ID returned by POST /transactions/deposit/interactive",
    });
  }

  return results;
}
