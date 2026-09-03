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

/**
 * SEP-24 defines exactly two transaction kinds: "kind | string | `deposit` or
 * `withdrawal`". Asset-exchange flows reuse these two values rather than introducing
 * `deposit-exchange`/`withdrawal-exchange`, so this list is complete.
 */
export const VALID_SEP24_KINDS = ["deposit", "withdrawal"] as const;

export type Sep24Kind = (typeof VALID_SEP24_KINDS)[number];

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

interface Sep24TransactionRecord {
  id?: unknown;
  status?: unknown;
  kind?: unknown;
  asset_code?: unknown;
  amount_in_asset?: unknown;
  amount_out_asset?: unknown;
}

const LIST_CHECK_DESCRIPTIONS = {
  "sep24.transactions_list": "GET /transactions returns an object containing a transactions array",
  "sep24.transactions_list_records":
    "Every GET /transactions record has a non-empty id, a valid SEP-24 status, and kind deposit or withdrawal",
  "sep24.transactions_list_asset_filter": "GET /transactions honours the asset_code filter",
  "sep24.transactions_list_asset_filter_excludes":
    "GET /transactions filtered by a different asset_code excludes the transaction created under the first",
  "sep24.transactions_list_contains_created":
    "Transaction created by the interactive check this run appears in GET /transactions",
  "sep24.transactions_list_limit": "GET /transactions?limit=1 returns at most one record",
  "sep24.transactions_list_requires_asset_code":
    "GET /transactions without the required asset_code parameter is rejected",
  "sep24.transactions_list_unauthenticated": "GET /transactions without authentication is rejected",
} as const;

type ListCheckId = keyof typeof LIST_CHECK_DESCRIPTIONS;

/** Pushes the same status/message under several list check ids (shared failure or skip). */
function pushListResults(
  ids: readonly ListCheckId[],
  status: CheckResult["status"],
  severity: CheckResult["severity"],
  message: string,
  results: CheckResult[],
): void {
  for (const id of ids) {
    results.push({ id, description: LIST_CHECK_DESCRIPTIONS[id], status, severity, message });
  }
}

/** Narrows one /transactions element to a record object, or undefined when malformed. */
function asRecord(entry: unknown): Sep24TransactionRecord | undefined {
  return typeof entry === "object" && entry !== null && !Array.isArray(entry)
    ? (entry as Sep24TransactionRecord)
    : undefined;
}

/** Describes every schema defect on one transaction record, or [] when it is conformant. */
function describeRecordDefects(entry: unknown, index: number): string[] {
  const record = asRecord(entry);
  if (!record) {
    return [`[${index}] must be a transaction object, got: ${JSON.stringify(entry)}`];
  }

  const defects: string[] = [];

  if (typeof record.id !== "string" || record.id.trim().length === 0) {
    defects.push(`[${index}] id must be a non-empty string, got: ${JSON.stringify(record.id)}`);
  }
  if (typeof record.status !== "string" || !VALID_SEP24_STATUSES.includes(record.status as Sep24Status)) {
    defects.push(`[${index}] status not in SEP-24 enum, got: ${JSON.stringify(record.status)}`);
  }
  if (typeof record.kind !== "string" || !VALID_SEP24_KINDS.includes(record.kind as Sep24Kind)) {
    defects.push(`[${index}] kind must be "deposit" or "withdrawal", got: ${JSON.stringify(record.kind)}`);
  }

  return defects;
}

/**
 * Decides whether a transaction record belongs to `assetCode`.
 *
 * SEP-24 transaction objects carry no mandatory asset field: the code surfaces either in
 * a top-level `asset_code` (widely emitted by anchors, not in the spec) or inside the
 * SEP-38 asset identifiers `amount_in_asset`/`amount_out_asset` ("stellar:USDC:GA...",
 * "iso4217:USD"). A record carrying none of them cannot be judged, so it is reported as
 * inconclusive rather than as a filter violation.
 */
function matchesAssetCode(
  record: Sep24TransactionRecord,
  assetCode: string,
): "match" | "mismatch" | "unknown" {
  const wanted = assetCode.toUpperCase();
  let sawIdentifier = false;

  if (typeof record.asset_code === "string" && record.asset_code.trim().length > 0) {
    sawIdentifier = true;
    if (record.asset_code.toUpperCase() === wanted) {
      return "match";
    }
  }

  for (const field of ["amount_in_asset", "amount_out_asset"] as const) {
    const value = record[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      continue;
    }
    sawIdentifier = true;
    // SEP-38 identifiers are "<scheme>:<code>[:<issuer>]", so the code is the second
    // segment. A bare code with no scheme is non-conformant here but is still matched, so
    // that a merely sloppy anchor is not reported as a filter violation.
    const segments = value.split(":");
    const code = segments.length > 1 ? segments[1] : segments[0];
    if (code && code.toUpperCase() === wanted) {
      return "match";
    }
  }

  return sawIdentifier ? "mismatch" : "unknown";
}

/**
 * Validates GET /transactions (plural) — the endpoint a wallet uses to build a user's
 * transaction history. Covers the response shape, per-record schema, the asset_code
 * filter, the limit parameter, and the two negative cases (missing asset_code, missing
 * JWT).
 *
 * `createdTransactionId` is the id returned by the deposit interactive POST earlier in
 * the run. When present, its appearance in the list is the assertion with real teeth: it
 * proves the list endpoint and the single-transaction lookup agree. When the interactive
 * POST failed there is no id to look for, so that one check degrades to a warn instead of
 * reporting a failure the anchor did not cause.
 *
 * `exclusionAssetCode` is a second enabled asset code from /info, different from
 * `assetCode`, used to assert the filter by absence — see the exclusion check below.
 * Undefined when /info advertised only one enabled asset, or could not be read.
 */
async function checkTransactionList(
  assetCode: string,
  exclusionAssetCode: string | undefined,
  createdTransactionId: string | undefined,
  baseUrl: string,
  authHeader: Record<string, string>,
  timeoutMs: number | undefined,
  results: CheckResult[],
): Promise<void> {
  const derivedIds = [
    "sep24.transactions_list_records",
    "sep24.transactions_list_asset_filter",
    "sep24.transactions_list_contains_created",
  ] as const;
  const listUrl = `${baseUrl}/transactions?asset_code=${encodeURIComponent(assetCode)}`;

  // 1. Primary list request: shape, per-record schema, asset filter, cross-check.
  try {
    const res = await fetchWithTimeout(listUrl, { headers: { ...authHeader } }, timeoutMs);

    if (!res.ok) {
      pushListResults(
        ["sep24.transactions_list", ...derivedIds],
        "fail",
        "error",
        `GET ${listUrl} returned HTTP ${res.status}`,
        results,
      );
    } else {
      const body = (await res.json()) as { transactions?: unknown };
      const transactions = body.transactions;

      if (!Array.isArray(transactions)) {
        pushListResults(
          ["sep24.transactions_list", ...derivedIds],
          "fail",
          "error",
          `Response must be an object with a "transactions" array, got: ${JSON.stringify(transactions)}`,
          results,
        );
      } else {
        const records: unknown[] = transactions;
        results.push({
          id: "sep24.transactions_list",
          description: LIST_CHECK_DESCRIPTIONS["sep24.transactions_list"],
          status: "pass",
          severity: "error",
          message: `GET /transactions?asset_code=${assetCode} returned a transactions array with ${records.length} record(s)`,
        });

        if (records.length === 0) {
          // An anchor with no history for this account is legitimate, so the schema and
          // filter checks have nothing to judge. The cross-check below still fails if a
          // transaction was created this run and is missing from the list.
          pushListResults(
            ["sep24.transactions_list_records", "sep24.transactions_list_asset_filter"],
            "warn",
            "warning",
            "Inconclusive: anchor returned an empty transactions array, so there are no records to validate",
            results,
          );
        } else {
          const defects = records.flatMap((entry, index) => describeRecordDefects(entry, index));
          results.push({
            id: "sep24.transactions_list_records",
            description: LIST_CHECK_DESCRIPTIONS["sep24.transactions_list_records"],
            status: defects.length > 0 ? "fail" : "pass",
            severity: "error",
            message:
              defects.length > 0
                ? `${defects.length} schema defect(s) across ${records.length} record(s): ${defects.join("; ")}`
                : `All ${records.length} record(s) have a non-empty id, a valid status, and a valid kind`,
          });

          const mismatches: string[] = [];
          let unknownCount = 0;
          records.forEach((entry, index) => {
            const record = asRecord(entry);
            if (!record) {
              // A non-object element is already reported by the schema check above, and
              // carries no asset identifier either, so it is inconclusive here.
              unknownCount++;
              return;
            }

            const verdict = matchesAssetCode(record, assetCode);
            if (verdict === "mismatch") {
              mismatches.push(
                `[${index}] id=${String(record.id)} asset_code=${String(record.asset_code)} amount_in_asset=${String(record.amount_in_asset)}`,
              );
            } else if (verdict === "unknown") {
              unknownCount++;
            }
          });

          if (mismatches.length > 0) {
            results.push({
              id: "sep24.transactions_list_asset_filter",
              description: LIST_CHECK_DESCRIPTIONS["sep24.transactions_list_asset_filter"],
              status: "fail",
              severity: "error",
              message: `${mismatches.length} record(s) do not match requested asset_code=${assetCode}: ${mismatches.join("; ")}`,
            });
          } else if (unknownCount === records.length) {
            results.push({
              id: "sep24.transactions_list_asset_filter",
              description: LIST_CHECK_DESCRIPTIONS["sep24.transactions_list_asset_filter"],
              status: "warn",
              severity: "warning",
              message: `Inconclusive: none of the ${records.length} record(s) carry asset_code, amount_in_asset, or amount_out_asset, so the asset_code filter cannot be verified`,
            });
          } else {
            results.push({
              id: "sep24.transactions_list_asset_filter",
              description: LIST_CHECK_DESCRIPTIONS["sep24.transactions_list_asset_filter"],
              status: "pass",
              severity: "error",
              message: `All identifiable record(s) match requested asset_code=${assetCode}${unknownCount > 0 ? ` (${unknownCount} record(s) carried no asset identifier)` : ""}`,
            });
          }
        }

        if (!createdTransactionId) {
          results.push({
            id: "sep24.transactions_list_contains_created",
            description: LIST_CHECK_DESCRIPTIONS["sep24.transactions_list_contains_created"],
            status: "warn",
            severity: "warning",
            message:
              "Skipped: no transaction id was produced by POST /transactions/deposit/interactive this run, so the list could not be cross-checked against the lookup",
          });
        } else {
          const found = records.some((entry) => asRecord(entry)?.id === createdTransactionId);
          results.push({
            id: "sep24.transactions_list_contains_created",
            description: LIST_CHECK_DESCRIPTIONS["sep24.transactions_list_contains_created"],
            status: found ? "pass" : "fail",
            severity: "error",
            message: found
              ? `Transaction ${createdTransactionId} created this run is present in GET /transactions`
              : `Transaction ${createdTransactionId} was created this run and is returned by GET /transaction?id=, but is absent from GET /transactions?asset_code=${assetCode} (${records.length} record(s)); the list and lookup endpoints disagree`,
          });
        }
      }
    }
  } catch (err) {
    pushListResults(
      ["sep24.transactions_list", ...derivedIds],
      "fail",
      "error",
      (err as Error).message,
      results,
    );
  }

  // 2. Asset-filter exclusion. The positive check above can only reach a verdict when the
  // returned records happen to carry an asset identifier, and SEP-24 mandates none: a
  // freshly created transaction has no amounts yet, so it has no amount_in_asset /
  // amount_out_asset either, and top-level asset_code is not in the spec. Against such an
  // anchor the positive check is permanently inconclusive, and an anchor that ignores
  // asset_code entirely goes uncaught.
  //
  // Absence is observable even when every record is anonymous. The transaction created
  // under `assetCode` earlier in this run must not appear when the list is filtered by a
  // different enabled asset; an anchor that ignores the filter returns it anyway.
  //
  // This relies on the transaction being a plain deposit created with a single asset_code
  // and no quote_id, which is how requestInteractive posts it. A SEP-38-quoted transaction
  // legitimately involves two assets (amount_in_asset: iso4217:USD, amount_out_asset:
  // stellar:USDC:GA...) and could reasonably be returned under either code, so that
  // assumption would not hold if this check were ever pointed at a quoted transaction.
  const excludesId = "sep24.transactions_list_asset_filter_excludes";
  const excludesDescription = LIST_CHECK_DESCRIPTIONS[excludesId];

  if (!exclusionAssetCode) {
    results.push({
      id: excludesId,
      description: excludesDescription,
      status: "warn",
      severity: "warning",
      message: `Not exercised: /info advertised no enabled asset other than ${assetCode}, so there is no second asset to filter by (a single-asset anchor is legitimate)`,
    });
  } else if (!createdTransactionId) {
    results.push({
      id: excludesId,
      description: excludesDescription,
      status: "warn",
      severity: "warning",
      message:
        "Skipped: no transaction id was produced by POST /transactions/deposit/interactive this run, so there is no transaction whose exclusion could be asserted",
    });
  } else {
    const excludeUrl = `${baseUrl}/transactions?asset_code=${encodeURIComponent(exclusionAssetCode)}`;
    try {
      const res = await fetchWithTimeout(excludeUrl, { headers: { ...authHeader } }, timeoutMs);

      if (!res.ok) {
        results.push({
          id: excludesId,
          description: excludesDescription,
          status: "fail",
          severity: "error",
          message: `GET ${excludeUrl} returned HTTP ${res.status}`,
        });
      } else {
        const body = (await res.json()) as { transactions?: unknown };

        if (!Array.isArray(body.transactions)) {
          results.push({
            id: excludesId,
            description: excludesDescription,
            status: "fail",
            severity: "error",
            message: `Response must be an object with a "transactions" array, got: ${JSON.stringify(body.transactions)}`,
          });
        } else {
          const leaked = body.transactions.some(
            (entry) => asRecord(entry)?.id === createdTransactionId,
          );
          results.push({
            id: excludesId,
            description: excludesDescription,
            status: leaked ? "fail" : "pass",
            severity: "error",
            message: leaked
              ? `asset_code filter ignored: transaction ${createdTransactionId}, created under asset_code=${assetCode} this run, is returned by GET /transactions?asset_code=${exclusionAssetCode}`
              : `Transaction ${createdTransactionId}, created under asset_code=${assetCode}, is correctly absent from GET /transactions?asset_code=${exclusionAssetCode} (${body.transactions.length} record(s))`,
          });
        }
      }
    } catch (err) {
      results.push({
        id: excludesId,
        description: excludesDescription,
        status: "fail",
        severity: "error",
        message: (err as Error).message,
      });
    }
  }

  // 3. limit=1 must cap the response at a single record.
  try {
    const limitUrl = `${baseUrl}/transactions?asset_code=${encodeURIComponent(assetCode)}&limit=1`;
    const res = await fetchWithTimeout(limitUrl, { headers: { ...authHeader } }, timeoutMs);

    if (!res.ok) {
      results.push({
        id: "sep24.transactions_list_limit",
        description: LIST_CHECK_DESCRIPTIONS["sep24.transactions_list_limit"],
        status: "fail",
        severity: "error",
        message: `GET ${limitUrl} returned HTTP ${res.status}`,
      });
    } else {
      const body = (await res.json()) as { transactions?: unknown };
      if (!Array.isArray(body.transactions)) {
        results.push({
          id: "sep24.transactions_list_limit",
          description: LIST_CHECK_DESCRIPTIONS["sep24.transactions_list_limit"],
          status: "fail",
          severity: "error",
          message: `Response must be an object with a "transactions" array, got: ${JSON.stringify(body.transactions)}`,
        });
      } else if (body.transactions.length > 1) {
        results.push({
          id: "sep24.transactions_list_limit",
          description: LIST_CHECK_DESCRIPTIONS["sep24.transactions_list_limit"],
          status: "fail",
          severity: "error",
          message: `limit=1 was ignored: anchor returned ${body.transactions.length} records`,
        });
      } else {
        results.push({
          id: "sep24.transactions_list_limit",
          description: LIST_CHECK_DESCRIPTIONS["sep24.transactions_list_limit"],
          status: "pass",
          severity: "error",
          message: `limit=1 honoured: anchor returned ${body.transactions.length} record(s)`,
        });
      }
    }
  } catch (err) {
    results.push({
      id: "sep24.transactions_list_limit",
      description: LIST_CHECK_DESCRIPTIONS["sep24.transactions_list_limit"],
      status: "fail",
      severity: "error",
      message: (err as Error).message,
    });
  }

  // 4. Negative: asset_code is a required parameter, so omitting it must be rejected.
  // An anchor that answers 2xx anyway is lenient rather than dangerous — a wallet still
  // gets usable data — so this is reported at warning severity, unlike the auth bypass
  // below.
  try {
    const noAssetUrl = `${baseUrl}/transactions`;
    const res = await fetchWithTimeout(noAssetUrl, { headers: { ...authHeader } }, timeoutMs);

    if (res.ok) {
      results.push({
        id: "sep24.transactions_list_requires_asset_code",
        description: LIST_CHECK_DESCRIPTIONS["sep24.transactions_list_requires_asset_code"],
        status: "fail",
        severity: "warning",
        message: `Anchor accepted GET /transactions with no asset_code (HTTP ${res.status}); SEP-24 lists asset_code as required`,
      });
    } else if (res.status >= 400 && res.status < 500) {
      results.push({
        id: "sep24.transactions_list_requires_asset_code",
        description: LIST_CHECK_DESCRIPTIONS["sep24.transactions_list_requires_asset_code"],
        status: "pass",
        severity: "warning",
        message: `Anchor correctly rejected GET /transactions with no asset_code (HTTP ${res.status})`,
      });
    } else {
      results.push({
        id: "sep24.transactions_list_requires_asset_code",
        description: LIST_CHECK_DESCRIPTIONS["sep24.transactions_list_requires_asset_code"],
        status: "warn",
        severity: "warning",
        message: `Anchor returned HTTP ${res.status} for GET /transactions with no asset_code (expected a 4xx); inconclusive`,
      });
    }
  } catch (err) {
    results.push({
      id: "sep24.transactions_list_requires_asset_code",
      description: LIST_CHECK_DESCRIPTIONS["sep24.transactions_list_requires_asset_code"],
      status: "fail",
      severity: "warning",
      message: (err as Error).message,
    });
  }

  // 5. Negative: /transactions serves user data, so SEP-24 requires the SEP-10 JWT
  // ("/info should be unauthenticated, but all other endpoints will require a token").
  // Serving it without one leaks another account's history.
  try {
    const res = await fetchWithTimeout(listUrl, {}, timeoutMs);

    if (res.status === 401 || res.status === 403) {
      results.push({
        id: "sep24.transactions_list_unauthenticated",
        description: LIST_CHECK_DESCRIPTIONS["sep24.transactions_list_unauthenticated"],
        status: "pass",
        severity: "error",
        message: `Anchor correctly rejected unauthenticated GET /transactions with HTTP ${res.status}`,
      });
    } else if (res.ok) {
      results.push({
        id: "sep24.transactions_list_unauthenticated",
        description: LIST_CHECK_DESCRIPTIONS["sep24.transactions_list_unauthenticated"],
        status: "fail",
        severity: "error",
        message: `AUTHENTICATION BYPASS: Anchor served transaction history from an unauthenticated GET /transactions request (HTTP ${res.status})`,
      });
    } else {
      results.push({
        id: "sep24.transactions_list_unauthenticated",
        description: LIST_CHECK_DESCRIPTIONS["sep24.transactions_list_unauthenticated"],
        status: "warn",
        severity: "warning",
        message: `Anchor returned HTTP ${res.status} for unauthenticated GET /transactions (expected 401 or 403); inconclusive`,
      });
    }
  } catch (err) {
    results.push({
      id: "sep24.transactions_list_unauthenticated",
      description: LIST_CHECK_DESCRIPTIONS["sep24.transactions_list_unauthenticated"],
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
  let exclusionAssetCode: string | undefined;

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

          // Pick a second enabled asset code, different from the one the deposit is
          // created under, for the list-filter exclusion check. Deposit assets come first
          // because they are the more natural pool, but a withdraw-only code is still a
          // valid value to filter /transactions by. Undefined for a single-asset anchor,
          // which the check reports as not exercised rather than as a failure.
          exclusionAssetCode = allAssets
            .filter(([, info]) => info.enabled !== false)
            .map(([code]) => code)
            .find((code) => code.toUpperCase() !== depositAssetCode.toUpperCase());
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

  // 6. GET /transactions (plural) list endpoint. Filtered on the deposit asset code
  // because that is the asset the interactive POST above created a transaction for, which
  // is what makes the list/lookup cross-check meaningful.
  await checkTransactionList(
    depositAssetCode,
    exclusionAssetCode,
    deposit.transactionId,
    baseUrl,
    authHeader,
    opts.timeoutMs,
    results,
  );

  return results;
}
