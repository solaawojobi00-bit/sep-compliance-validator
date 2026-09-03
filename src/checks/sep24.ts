import { fetchWithTimeout } from "../core/http.js";
import type { CheckResult } from "../core/report.js";
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

type InteractiveKind = "deposit" | "withdraw";

interface InteractiveFlowResult {
  interactiveUrl?: string;
  transactionId?: string;
}

/**
 * POSTs /transactions/{kind}/interactive and validates the response shape shared by
 * both the deposit and withdraw flows: type="interactive_customer_info_needed", plus
 * non-empty id and url.
 */
async function requestInteractive(
  kind: InteractiveKind,
  assetCode: string,
  baseUrl: string,
  authHeader: Record<string, string>,
  timeoutMs: number | undefined,
  results: CheckResult[],
): Promise<InteractiveFlowResult> {
  const id = `sep24.${kind}_interactive`;
  const description = `POST /transactions/${kind}/interactive returns interactive response with url and id`;
  const endpoint = `${baseUrl}/transactions/${kind}/interactive`;

  try {
    const res = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          ...authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ asset_code: assetCode }),
      },
      timeoutMs,
    );

    if (!res.ok) {
      results.push({
        id,
        description,
        status: "fail",
        severity: "error",
        message: `POST ${endpoint} returned HTTP ${res.status}`,
      });
      return {};
    }

    const body = (await res.json()) as { type?: string; url?: string; id?: string };
    const isInteractiveType = body.type === "interactive_customer_info_needed";
    const hasValidId = typeof body.id === "string" && body.id.trim().length > 0;
    const hasValidUrl = typeof body.url === "string" && body.url.trim().length > 0;

    if (!isInteractiveType || !hasValidId || !hasValidUrl) {
      results.push({
        id,
        description,
        status: "fail",
        severity: "error",
        message: `Expected type="interactive_customer_info_needed" and valid url/id, received: type=${body.type}, id=${body.id}, url=${body.url}`,
      });
      return {};
    }

    results.push({
      id,
      description,
      status: "pass",
      severity: "error",
      message: `Received interactive response with id ${body.id}`,
    });
    return { interactiveUrl: body.url, transactionId: body.id };
  } catch (err) {
    results.push({
      id,
      description,
      status: "fail",
      severity: "error",
      message: (err as Error).message,
    });
    return {};
  }
}

/** Validates the interactive URL is a well-formed, reachable HTTPS URL. */
async function checkInteractiveUrlReachable(
  kind: InteractiveKind,
  interactiveUrl: string | undefined,
  timeoutMs: number | undefined,
  results: CheckResult[],
): Promise<void> {
  const id = kind === "deposit" ? "sep24.interactive_url_reachable" : "sep24.withdraw_interactive_url_reachable";
  const description = "Interactive URL is a well-formed, reachable HTTPS URL";

  if (!interactiveUrl) {
    results.push({
      id,
      description,
      status: "fail",
      severity: "error",
      message: `Skipped: no interactive URL returned by POST /transactions/${kind}/interactive`,
    });
    return;
  }

  try {
    const parsedUrl = new URL(interactiveUrl);
    if (parsedUrl.protocol !== "https:") {
      results.push({
        id,
        description,
        status: "fail",
        severity: "error",
        message: `Interactive URL protocol must be https:, got: ${parsedUrl.protocol}`,
      });
      return;
    }

    const res = await fetchWithTimeout(interactiveUrl, { method: "GET" }, timeoutMs);

    // 2xx, 3xx, or 4xx (e.g. auth/cookie prompt) indicates server reachable; 5xx is server error
    if (res.status >= 500) {
      results.push({
        id,
        description,
        status: "fail",
        severity: "error",
        message: `Interactive URL ${interactiveUrl} returned HTTP ${res.status}`,
      });
    } else {
      results.push({
        id,
        description,
        status: "pass",
        severity: "error",
        message: `Interactive URL is well-formed HTTPS and reachable (HTTP ${res.status})`,
      });
    }
  } catch (err) {
    results.push({
      id,
      description,
      status: "fail",
      severity: "error",
      message: `Failed to reach interactive URL ${interactiveUrl}: ${(err as Error).message}`,
    });
  }
}

/** Validates GET /transaction?id= returns a matching record with a valid SEP-24 status. */
async function checkTransactionStatus(
  kind: InteractiveKind,
  transactionId: string | undefined,
  baseUrl: string,
  authHeader: Record<string, string>,
  timeoutMs: number | undefined,
  results: CheckResult[],
): Promise<void> {
  const id = kind === "deposit" ? "sep24.transaction_status" : "sep24.withdraw_transaction_status";
  const description = "GET /transaction returns record with valid SEP-24 status";

  if (!transactionId) {
    results.push({
      id,
      description,
      status: "fail",
      severity: "error",
      message: `Skipped: no transaction ID returned by POST /transactions/${kind}/interactive`,
    });
    return;
  }

  try {
    const txUrl = `${baseUrl}/transaction?id=${encodeURIComponent(transactionId)}`;
    const res = await fetchWithTimeout(txUrl, { headers: { ...authHeader } }, timeoutMs);

    if (!res.ok) {
      results.push({
        id,
        description,
        status: "fail",
        severity: "error",
        message: `GET ${txUrl} returned HTTP ${res.status}`,
      });
      return;
    }

    const body = (await res.json()) as { transaction?: { id?: string; status?: string } };
    const txObj = body.transaction;
    const hasMatchingId = txObj?.id === transactionId;
    const hasValidStatus =
      typeof txObj?.status === "string" && VALID_SEP24_STATUSES.includes(txObj.status as Sep24Status);

    if (!txObj || !hasMatchingId || !hasValidStatus) {
      results.push({
        id,
        description,
        status: "fail",
        severity: "error",
        message: `Invalid transaction response: id=${txObj?.id}, status=${txObj?.status} (expected id=${transactionId} and valid status from SEP-24 enum)`,
      });
    } else {
      results.push({
        id,
        description,
        status: "pass",
        severity: "error",
        message: `Transaction record matches id ${txObj.id} with valid status "${txObj.status}"`,
      });
    }
  } catch (err) {
    results.push({
      id,
      description,
      status: "fail",
      severity: "error",
      message: (err as Error).message,
    });
  }
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
  let withdrawAssetCode: string | undefined;

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

          // Pick an enabled withdraw asset code if available; unlike deposit, there is
          // no hardcoded fallback here — a deposit-only anchor legitimately advertises
          // no withdraw assets at all, and that must not be treated as a defect.
          if (data.withdraw) {
            const enabledEntry = Object.entries(data.withdraw).find(
              ([, info]) => info.enabled !== false,
            );
            if (enabledEntry) {
              withdrawAssetCode = enabledEntry[0];
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
  const deposit = await requestInteractive(
    "deposit",
    depositAssetCode,
    baseUrl,
    authHeader,
    opts.timeoutMs,
    results,
  );

  // 3. Deposit interactive URL reachability check (simple GET / HEAD)
  await checkInteractiveUrlReachable("deposit", deposit.interactiveUrl, opts.timeoutMs, results);

  if (deposit.interactiveUrl && opts.interactiveBrowser) {
    const { runSep24BrowserChecks } = await import("./sep24-browser.js");
    const browserResult = await runSep24BrowserChecks({
      interactiveUrl: deposit.interactiveUrl,
      timeoutMs: opts.timeoutMs,
    });
    results.push(...browserResult.results);
  }

  // 4. GET /transaction?id=... check for the deposit transaction
  await checkTransactionStatus(
    "deposit",
    deposit.transactionId,
    baseUrl,
    authHeader,
    opts.timeoutMs,
    results,
  );

  // 5. POST /transactions/withdraw/interactive check, mirroring the deposit flow above.
  // Note: --interactive-browser automation is not run against the withdraw interactive
  // URL. runSep24BrowserChecks's own check ids (sep24.interactive_browser_launch, etc.)
  // are not parameterized by deposit/withdraw, so running it twice in one report would
  // silently overwrite/duplicate results rather than produce distinguishable findings.
  // Parameterizing those ids is a reasonable follow-up but touches sep24-browser.ts,
  // which is outside this change's scope.
  if (!withdrawAssetCode) {
    const message = "Skipped: /info advertised no enabled withdraw asset (a deposit-only anchor is legitimate)";
    results.push({
      id: "sep24.withdraw_interactive",
      description:
        "POST /transactions/withdraw/interactive returns interactive response with url and id",
      status: "warn",
      severity: "warning",
      message,
    });
    results.push({
      id: "sep24.withdraw_interactive_url_reachable",
      description: "Interactive URL is a well-formed, reachable HTTPS URL",
      status: "warn",
      severity: "warning",
      message,
    });
    results.push({
      id: "sep24.withdraw_transaction_status",
      description: "GET /transaction returns record with valid SEP-24 status",
      status: "warn",
      severity: "warning",
      message,
    });
  } else {
    const withdraw = await requestInteractive(
      "withdraw",
      withdrawAssetCode,
      baseUrl,
      authHeader,
      opts.timeoutMs,
      results,
    );

    await checkInteractiveUrlReachable("withdraw", withdraw.interactiveUrl, opts.timeoutMs, results);

    await checkTransactionStatus(
      "withdraw",
      withdraw.transactionId,
      baseUrl,
      authHeader,
      opts.timeoutMs,
      results,
    );
  }

  return results;
}
