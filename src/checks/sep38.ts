import { fetchWithTimeout } from "../core/http.js";
import type { CheckResult } from "../core/report.js";
import type { StellarToml } from "./sep1.js";

export interface Sep38Options {
  domain: string;
  toml: StellarToml;
  network: "testnet" | "mainnet";
  timeoutMs?: number;
  jwt?: string;
  noWrite?: boolean;
}

// Tolerance used to compare the price formulas below: anchors round sell_amount/
// buy_amount to the decimals required by each asset, so exact equality would be
// too brittle.
const PRICE_CONSISTENCY_TOLERANCE = 0.01;

function approxEqual(a: number, b: number, tolerance = PRICE_CONSISTENCY_TOLERANCE): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / scale <= tolerance;
}

export async function runSep38Checks(opts: Sep38Options): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const quoteServer =
    opts.toml.anchorQuoteServer ??
    (typeof opts.toml.raw.ANCHOR_QUOTE_SERVER === "string"
      ? opts.toml.raw.ANCHOR_QUOTE_SERVER
      : undefined);

  if (!quoteServer) {
    results.push({
      id: "sep38.skipped",
      description: "Run SEP-38 quote endpoint checks",
      status: "warn",
      severity: "warning",
      message: "Skipped: ANCHOR_QUOTE_SERVER missing from stellar.toml",
    });
    return results;
  }

  const baseUrl = quoteServer.replace(/\/+$/, "");
  let sellAsset = "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  let buyAsset = "iso4217:USD";

  // 1. GET /info (discover supported assets)
  try {
    const res = await fetchWithTimeout(`${baseUrl}/info`, {}, opts.timeoutMs);
    if (!res.ok) {
      results.push({
        id: "sep38.info",
        description: "Fetch SEP-38 /info to discover supported assets",
        status: "fail",
        severity: "error",
        message: `GET ${baseUrl}/info returned HTTP ${res.status}`,
      });
    } else {
      const data = (await res.json()) as { assets?: Array<{ asset?: string }> };
      if (!Array.isArray(data.assets) || data.assets.length === 0) {
        results.push({
          id: "sep38.info",
          description: "Fetch SEP-38 /info to discover supported assets",
          status: "fail",
          severity: "error",
          message: 'Response JSON is missing or has empty "assets" array',
        });
      } else {
        results.push({
          id: "sep38.info",
          description: "Fetch SEP-38 /info to discover supported assets",
          status: "pass",
          severity: "error",
          message: `Discovered ${data.assets.length} supported asset(s) from ${baseUrl}/info`,
        });

        const validAssets = data.assets
          .map((a) => a.asset)
          .filter((a): a is string => typeof a === "string" && a.length > 0);

        if (validAssets.length > 0) {
          const fiatAsset = validAssets.find((a) => a.startsWith("iso4217:"));
          const stellarAsset = validAssets.find((a) => a.startsWith("stellar:"));

          if (fiatAsset && stellarAsset && fiatAsset !== stellarAsset) {
            sellAsset = fiatAsset;
            buyAsset = stellarAsset;
          } else if (validAssets.length > 1) {
            sellAsset = validAssets[0];
            buyAsset = validAssets[1];
          } else {
            sellAsset = validAssets[0];
            buyAsset = "";
          }
        }
      }
    }
  } catch (err) {
    results.push({
      id: "sep38.info",
      description: "Fetch SEP-38 /info to discover supported assets",
      status: "fail",
      severity: "error",
      message: (err as Error).message,
    });
  }

  // 2. Negative check: GET /prices requires either sell_asset or buy_asset
  try {
    const res = await fetchWithTimeout(`${baseUrl}/prices`, {}, opts.timeoutMs);
    if (res.status === 400 || (res.status >= 400 && res.status < 500)) {
      results.push({
        id: "sep38.prices_missing_assets",
        description: "GET /prices requires either sell_asset or buy_asset",
        status: "pass",
        severity: "error",
        message: `GET /prices correctly rejected missing assets with HTTP ${res.status}`,
      });
    } else {
      results.push({
        id: "sep38.prices_missing_assets",
        description: "GET /prices requires either sell_asset or buy_asset",
        status: "fail",
        severity: "error",
        message: `GET /prices returned HTTP ${res.status} when neither sell_asset nor buy_asset was provided; expected HTTP 400`,
      });
    }
  } catch (err) {
    results.push({
      id: "sep38.prices_missing_assets",
      description: "GET /prices requires either sell_asset or buy_asset",
      status: "fail",
      severity: "error",
      message: (err as Error).message,
    });
  }

  // 3. Negative check: GET /prices rejects malformed asset identifier
  try {
    const malformedAsset = "not-a-valid-asset";
    const res = await fetchWithTimeout(
      `${baseUrl}/prices?sell_asset=${encodeURIComponent(malformedAsset)}`,
      {},
      opts.timeoutMs,
    );
    if (res.status === 400 || (res.status >= 400 && res.status < 500)) {
      results.push({
        id: "sep38.prices_malformed_asset",
        description: "GET /prices rejects malformed asset identifiers",
        status: "pass",
        severity: "error",
        message: `GET /prices correctly rejected malformed asset identifier with HTTP ${res.status}`,
      });
    } else {
      results.push({
        id: "sep38.prices_malformed_asset",
        description: "GET /prices rejects malformed asset identifiers",
        status: "fail",
        severity: "error",
        message: `GET /prices returned HTTP ${res.status} for malformed asset identifier; expected HTTP 400`,
      });
    }
  } catch (err) {
    results.push({
      id: "sep38.prices_malformed_asset",
      description: "GET /prices rejects malformed asset identifiers",
      status: "fail",
      severity: "error",
      message: (err as Error).message,
    });
  }

  // 4. Positive check: GET /prices schema & positive price values
  try {
    const pricesUrl = `${baseUrl}/prices?sell_asset=${encodeURIComponent(
      sellAsset,
    )}&sell_amount=100`;
    const res = await fetchWithTimeout(pricesUrl, {}, opts.timeoutMs);
    if (!res.ok) {
      let errorBody: any;
      try {
        errorBody = await res.json();
      } catch {
        // ignore parse error if response is not JSON
      }

      const isClientParamError =
        res.status === 400 &&
        typeof errorBody?.error === "string" &&
        /missing|required|invalid|unsupported|parameter/i.test(errorBody.error);

      if (isClientParamError) {
        results.push({
          id: "sep38.prices_request_error",
          description: "GET /prices request parameters accepted by anchor",
          status: "warn",
          severity: "warning",
          message: `Anchor rejected request parameters with HTTP 400: "${errorBody.error}" (client request error, not anchor schema defect)`,
        });
        results.push({
          id: "sep38.prices_schema",
          description: "GET /prices returns well-formed JSON matching SEP-38 schema",
          status: "warn",
          severity: "warning",
          message: `Skipped schema check: GET /prices was rejected due to client request parameter: "${errorBody.error}"`,
        });
        results.push({
          id: "sep38.prices_positive",
          description: "GET /prices returned prices are positive numbers",
          status: "warn",
          severity: "warning",
          message: `Skipped prices check: GET /prices was rejected due to client request parameter: "${errorBody.error}"`,
        });
      } else if (res.status >= 500) {
        results.push({
          id: "sep38.prices_schema",
          description: "GET /prices returns well-formed JSON matching SEP-38 schema",
          status: "warn",
          severity: "warning",
          message: `GET /prices returned HTTP ${res.status} (upstream server/gateway error; anchor quote server may be unavailable)`,
        });
        results.push({
          id: "sep38.prices_positive",
          description: "GET /prices returned prices are positive numbers",
          status: "warn",
          severity: "warning",
          message: "Cannot validate prices because GET /prices returned upstream server error",
        });
      } else {
        results.push({
          id: "sep38.prices_schema",
          description: "GET /prices returns well-formed JSON matching SEP-38 schema",
          status: "fail",
          severity: "error",
          message: `GET /prices returned HTTP ${res.status}${errorBody?.error ? `: ${errorBody.error}` : ""}`,
        });
        results.push({
          id: "sep38.prices_positive",
          description: "GET /prices returned prices are positive numbers",
          status: "fail",
          severity: "error",
          message: "Cannot validate prices because GET /prices failed",
        });
      }
    } else {
      const body = (await res.json()) as {
        buy_tokens?: Array<{ asset?: string; price?: string; decimals?: number }>;
        buy_assets?: Array<{ asset?: string; price?: string; decimals?: number }>;
      };
      const buyAssets = body.buy_assets ?? body.buy_tokens;

      if (!Array.isArray(buyAssets)) {
        results.push({
          id: "sep38.prices_schema",
          description: "GET /prices returns well-formed JSON matching SEP-38 schema",
          status: "fail",
          severity: "error",
          message: 'Response JSON is missing the "buy_assets" / "buy_tokens" array',
        });
        results.push({
          id: "sep38.prices_positive",
          description: "GET /prices returned prices are positive numbers",
          status: "fail",
          severity: "error",
          message: 'Cannot validate prices: "buy_assets" array is missing',
        });
      } else {
        const invalidTokens = buyAssets.filter(
          (t) =>
            typeof t.asset !== "string" ||
            typeof t.price !== "string" ||
            typeof t.decimals !== "number",
        );

        if (invalidTokens.length > 0) {
          results.push({
            id: "sep38.prices_schema",
            description: "GET /prices returns well-formed JSON matching SEP-38 schema",
            status: "fail",
            severity: "error",
            message: `buy_assets contains ${invalidTokens.length} item(s) missing required fields (asset, price, decimals)`,
          });
        } else {
          results.push({
            id: "sep38.prices_schema",
            description: "GET /prices returns well-formed JSON matching SEP-38 schema",
            status: "pass",
            severity: "error",
            message: `GET /prices returned valid schema with ${buyAssets.length} asset(s)`,
          });
        }

        const nonPositive = buyAssets.filter((t) => {
          const p = parseFloat(t.price ?? "");
          return isNaN(p) || p <= 0;
        });

        if (nonPositive.length > 0) {
          results.push({
            id: "sep38.prices_positive",
            description: "GET /prices returned prices are positive numbers",
            status: "fail",
            severity: "error",
            message: `buy_assets contains ${nonPositive.length} non-positive or invalid price(s)`,
          });
        } else {
          results.push({
            id: "sep38.prices_positive",
            description: "GET /prices returned prices are positive numbers",
            status: "pass",
            severity: "error",
            message: `All ${buyAssets.length} price(s) in buy_assets are positive numbers`,
          });
        }
      }
    }
  } catch (err) {
    results.push({
      id: "sep38.prices_schema",
      description: "GET /prices returns well-formed JSON matching SEP-38 schema",
      status: "fail",
      severity: "error",
      message: (err as Error).message,
    });
    results.push({
      id: "sep38.prices_positive",
      description: "GET /prices returned prices are positive numbers",
      status: "fail",
      severity: "error",
      message: (err as Error).message,
    });
  }

  // 5. Positive check: GET /price schema, positive price, and expires_at
  const hasAssetPair = Boolean(buyAsset) && buyAsset !== sellAsset;

  if (!hasAssetPair) {
    const noPairMessage = "Skipped: at least two distinct assets are required to query GET /price";
    const noPairQuoteMessage =
      "Skipped: at least two distinct assets are required to request a quote";
    results.push({
      id: "sep38.price_schema",
      description: "GET /price returns well-formed JSON matching SEP-38 schema",
      status: "warn",
      severity: "warning",
      message: noPairMessage,
    });
    results.push({
      id: "sep38.price_positive",
      description: "GET /price returned price is a positive number",
      status: "warn",
      severity: "warning",
      message: noPairMessage,
    });
    results.push({
      id: "sep38.price_expires_at",
      description: "GET /price expires_at (when present) is a valid, future timestamp",
      status: "warn",
      severity: "warning",
      message: noPairMessage,
    });
    results.push({
      id: "sep38.quote_unauthenticated",
      description: "POST /quote without authentication is rejected",
      status: "warn",
      severity: "warning",
      message: noPairQuoteMessage,
    });
    results.push({
      id: "sep38.quote_schema",
      description: "POST /quote returns well-formed JSON matching SEP-38 firm quote schema",
      status: "warn",
      severity: "warning",
      message: noPairQuoteMessage,
    });
    results.push({
      id: "sep38.quote_positive",
      description: "POST /quote price and total_price are positive and consistent with amounts",
      status: "warn",
      severity: "warning",
      message: noPairQuoteMessage,
    });
    results.push({
      id: "sep38.quote_expires_at",
      description: "POST /quote expires_at is a valid, future timestamp",
      status: "warn",
      severity: "warning",
      message: noPairQuoteMessage,
    });
    results.push({
      id: "sep38.quote_get_matches",
      description: "GET /quote/{id} returns the same quote created by POST /quote",
      status: "warn",
      severity: "warning",
      message: noPairQuoteMessage,
    });
    results.push({
      id: "sep38.quote_get_nonexistent",
      description: "GET /quote/{id} with a nonexistent id returns HTTP 404",
      status: "warn",
      severity: "warning",
      message: noPairQuoteMessage,
    });
    return results;
  }

  try {
    let priceUrl = `${baseUrl}/price?sell_asset=${encodeURIComponent(
      sellAsset,
    )}&buy_asset=${encodeURIComponent(buyAsset)}&sell_amount=100`;

    let res = await fetchWithTimeout(priceUrl, {}, opts.timeoutMs);

    if (res.status === 400) {
      let errorBody: any;
      try {
        errorBody = await res.json();
      } catch {}
      if (typeof errorBody?.error === "string" && /context/i.test(errorBody.error)) {
        priceUrl = `${priceUrl}&context=sep6`;
        res = await fetchWithTimeout(priceUrl, {}, opts.timeoutMs);
      }
    }

    if (!res.ok) {
      let errorBody: any;
      try {
        errorBody = await res.json();
      } catch {
        // ignore parse error if response is not JSON
      }

      const isClientParamError =
        res.status === 400 &&
        typeof errorBody?.error === "string" &&
        /missing|required|invalid|unsupported|parameter/i.test(errorBody.error);

      if (isClientParamError) {
        results.push({
          id: "sep38.price_request_error",
          description: "GET /price request parameters accepted by anchor",
          status: "warn",
          severity: "warning",
          message: `Anchor rejected request parameters with HTTP 400: "${errorBody.error}" (client request error or unsupported pair, not anchor schema defect)`,
        });
        results.push({
          id: "sep38.price_schema",
          description: "GET /price returns well-formed JSON matching SEP-38 schema",
          status: "warn",
          severity: "warning",
          message: `Skipped schema check: GET /price was rejected due to client request parameter: "${errorBody.error}"`,
        });
        results.push({
          id: "sep38.price_positive",
          description: "GET /price returned price is a positive number",
          status: "warn",
          severity: "warning",
          message: `Skipped price check: GET /price was rejected due to client request parameter: "${errorBody.error}"`,
        });
        results.push({
          id: "sep38.price_expires_at",
          description: "GET /price expires_at (when present) is a valid, future timestamp",
          status: "warn",
          severity: "warning",
          message: `Skipped expires_at check: GET /price was rejected due to client request parameter: "${errorBody.error}"`,
        });
      } else if (res.status >= 500) {
        results.push({
          id: "sep38.price_schema",
          description: "GET /price returns well-formed JSON matching SEP-38 schema",
          status: "warn",
          severity: "warning",
          message: `GET /price returned HTTP ${res.status} (upstream server/gateway error; anchor quote server may be unavailable)`,
        });
        results.push({
          id: "sep38.price_positive",
          description: "GET /price returned price is a positive number",
          status: "warn",
          severity: "warning",
          message: "Cannot validate price because GET /price returned upstream server error",
        });
        results.push({
          id: "sep38.price_expires_at",
          description: "GET /price expires_at (when present) is a valid, future timestamp",
          status: "warn",
          severity: "warning",
          message: "Cannot validate expires_at because GET /price returned upstream server error",
        });
      } else {
        results.push({
          id: "sep38.price_schema",
          description: "GET /price returns well-formed JSON matching SEP-38 schema",
          status: "fail",
          severity: "error",
          message: `GET /price returned HTTP ${res.status}${errorBody?.error ? `: ${errorBody.error}` : ""}`,
        });
        results.push({
          id: "sep38.price_positive",
          description: "GET /price returned price is a positive number",
          status: "fail",
          severity: "error",
          message: "Cannot validate price because GET /price failed",
        });
        results.push({
          id: "sep38.price_expires_at",
          description: "GET /price expires_at (when present) is a valid, future timestamp",
          status: "fail",
          severity: "error",
          message: "Cannot validate expires_at because GET /price failed",
        });
      }
    } else {
      const body = (await res.json()) as {
        total_price?: string;
        price?: string;
        sell_amount?: string;
        buy_amount?: string;
        fee?: { total?: string; asset?: string };
        expires_at?: string;
      };

      const hasRequiredFields =
        typeof body.total_price === "string" &&
        typeof body.price === "string" &&
        typeof body.sell_amount === "string" &&
        typeof body.buy_amount === "string" &&
        typeof body.fee === "object" &&
        body.fee !== null &&
        typeof body.fee.total === "string" &&
        typeof body.fee.asset === "string";

      if (!hasRequiredFields) {
        results.push({
          id: "sep38.price_schema",
          description: "GET /price returns well-formed JSON matching SEP-38 schema",
          status: "fail",
          severity: "error",
          message:
            "Response JSON is missing required fields (total_price, price, sell_amount, buy_amount, or fee object)",
        });
      } else {
        results.push({
          id: "sep38.price_schema",
          description: "GET /price returns well-formed JSON matching SEP-38 schema",
          status: "pass",
          severity: "error",
          message: "GET /price returned valid schema with all required fields",
        });
      }

      const p = parseFloat(body.price ?? "");
      const tp = parseFloat(body.total_price ?? "");
      if (isNaN(p) || p <= 0 || isNaN(tp) || tp <= 0) {
        results.push({
          id: "sep38.price_positive",
          description: "GET /price returned price is a positive number",
          status: "fail",
          severity: "error",
          message: `Returned price (${body.price}) and total_price (${body.total_price}) must be positive numbers`,
        });
      } else {
        results.push({
          id: "sep38.price_positive",
          description: "GET /price returned price is a positive number",
          status: "pass",
          severity: "error",
          message: `Returned price is positive (price = ${body.price}, total_price = ${body.total_price})`,
        });
      }

      if (body.expires_at !== undefined && body.expires_at !== null) {
        const expTime = Date.parse(body.expires_at);
        if (isNaN(expTime)) {
          results.push({
            id: "sep38.price_expires_at",
            description:
              "GET /price expires_at (when present) is a valid, future timestamp",
            status: "fail",
            severity: "error",
            message: `expires_at is not a valid ISO 8601 date string: ${body.expires_at}`,
          });
        } else if (expTime <= Date.now()) {
          results.push({
            id: "sep38.price_expires_at",
            description:
              "GET /price expires_at (when present) is a valid, future timestamp",
            status: "fail",
            severity: "error",
            message: `expires_at must be in the future, but got timestamp in past/present: ${body.expires_at}`,
          });
        } else {
          results.push({
            id: "sep38.price_expires_at",
            description:
              "GET /price expires_at (when present) is a valid, future timestamp",
            status: "pass",
            severity: "error",
            message: `expires_at is a valid future timestamp: ${body.expires_at}`,
          });
        }
      } else {
        results.push({
          id: "sep38.price_expires_at",
          description:
            "GET /price expires_at (when present) is a valid, future timestamp",
          status: "pass",
          severity: "error",
          message: "expires_at not present (optional per SEP-38 for indicative quotes)",
        });
      }
    }
  } catch (err) {
    results.push({
      id: "sep38.price_schema",
      description: "GET /price returns well-formed JSON matching SEP-38 schema",
      status: "fail",
      severity: "error",
      message: (err as Error).message,
    });
    results.push({
      id: "sep38.price_positive",
      description: "GET /price returned price is a positive number",
      status: "fail",
      severity: "error",
      message: (err as Error).message,
    });
    results.push({
      id: "sep38.price_expires_at",
      description: "GET /price expires_at (when present) is a valid, future timestamp",
      status: "fail",
      severity: "error",
      message: (err as Error).message,
    });
  }

  // 6. Negative check: POST /quote without authentication is rejected
  if (opts.noWrite) {
    results.push({
      id: "sep38.quote_unauthenticated",
      description: "POST /quote without authentication is rejected",
      status: "warn",
      severity: "warning",
      message: "Skipped: --no-write mode enabled; mutating POST /quote request omitted",
    });
  } else {
    try {
      const res = await fetchWithTimeout(
        `${baseUrl}/quote`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sell_asset: sellAsset,
            buy_asset: buyAsset,
            sell_amount: "100",
            context: "sep6",
          }),
        },
        opts.timeoutMs,
      );

      if (res.status === 401 || res.status === 403) {
        results.push({
          id: "sep38.quote_unauthenticated",
          description: "POST /quote without authentication is rejected",
          status: "pass",
          severity: "error",
          message: `Anchor correctly rejected unauthenticated POST /quote with HTTP ${res.status}`,
        });
      } else if (res.ok) {
        results.push({
          id: "sep38.quote_unauthenticated",
          description: "POST /quote without authentication is rejected",
          status: "fail",
          severity: "error",
          message: `AUTHENTICATION BYPASS: Anchor created a firm quote from an unauthenticated POST /quote request (HTTP ${res.status})`,
        });
      } else {
        results.push({
          id: "sep38.quote_unauthenticated",
          description: "POST /quote without authentication is rejected",
          status: "warn",
          severity: "warning",
          message: `Anchor returned HTTP ${res.status} for unauthenticated POST /quote (expected 401 or 403); inconclusive`,
        });
      }
    } catch (err) {
      results.push({
        id: "sep38.quote_unauthenticated",
        description: "POST /quote without authentication is rejected",
        status: "fail",
        severity: "error",
        message: (err as Error).message,
      });
    }
  }

  // 7. Positive check: POST /quote creates a firm quote (schema, positive/consistent
  // amounts, expires_at)
  const quoteCheckIds = [
    "sep38.quote_schema",
    "sep38.quote_positive",
    "sep38.quote_expires_at",
  ] as const;
  const quoteCheckDescriptions: Record<(typeof quoteCheckIds)[number], string> = {
    "sep38.quote_schema": "POST /quote returns well-formed JSON matching SEP-38 firm quote schema",
    "sep38.quote_positive": "POST /quote price and total_price are positive and consistent with amounts",
    "sep38.quote_expires_at": "POST /quote expires_at is a valid, future timestamp",
  };

  let createdQuote: {
    id?: string;
    price?: string;
    expires_at?: string;
  } | undefined;

  if (!opts.jwt) {
    for (const id of quoteCheckIds) {
      results.push({
        id,
        description: quoteCheckDescriptions[id],
        status: "warn",
        severity: "warning",
        message: "Skipped: SEP-10 JWT required to create a firm quote",
      });
    }
  } else if (opts.noWrite) {
    for (const id of quoteCheckIds) {
      results.push({
        id,
        description: quoteCheckDescriptions[id],
        status: "warn",
        severity: "warning",
        message: "Skipped: --no-write mode enabled; mutating POST /quote request omitted",
      });
    }
  } else {
    try {
      const res = await fetchWithTimeout(
        `${baseUrl}/quote`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.jwt}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sell_asset: sellAsset,
            buy_asset: buyAsset,
            sell_amount: "100",
            context: "sep6",
          }),
        },
        opts.timeoutMs,
      );

      if (!res.ok) {
        let errorBody: any;
        try {
          errorBody = await res.json();
        } catch {
          // ignore parse error if response is not JSON
        }

        const isClientParamError =
          res.status === 400 &&
          typeof errorBody?.error === "string" &&
          /missing|required|invalid|unsupported|parameter|delivery/i.test(errorBody.error);

        if (isClientParamError) {
          for (const id of quoteCheckIds) {
            results.push({
              id,
              description: quoteCheckDescriptions[id],
              status: "warn",
              severity: "warning",
              message: `Skipped: POST /quote was rejected due to client request parameter: "${errorBody.error}"`,
            });
          }
        } else if (res.status >= 500) {
          for (const id of quoteCheckIds) {
            results.push({
              id,
              description: quoteCheckDescriptions[id],
              status: "warn",
              severity: "warning",
              message: `Cannot validate: POST /quote returned HTTP ${res.status} (upstream server/gateway error; anchor quote server may be unavailable)`,
            });
          }
        } else {
          for (const id of quoteCheckIds) {
            results.push({
              id,
              description: quoteCheckDescriptions[id],
              status: "fail",
              severity: "error",
              message: `POST /quote returned HTTP ${res.status}${errorBody?.error ? `: ${errorBody.error}` : ""}`,
            });
          }
        }
      } else {
        const body = (await res.json()) as {
          id?: string;
          expires_at?: string;
          total_price?: string;
          price?: string;
          sell_asset?: string;
          sell_amount?: string;
          buy_asset?: string;
          buy_amount?: string;
          fee?: { total?: string; asset?: string };
        };

        const hasRequiredFields =
          typeof body.id === "string" &&
          body.id.trim().length > 0 &&
          typeof body.expires_at === "string" &&
          typeof body.total_price === "string" &&
          typeof body.price === "string" &&
          typeof body.sell_asset === "string" &&
          typeof body.sell_amount === "string" &&
          typeof body.buy_asset === "string" &&
          typeof body.buy_amount === "string" &&
          typeof body.fee === "object" &&
          body.fee !== null &&
          typeof body.fee.total === "string" &&
          typeof body.fee.asset === "string";

        if (!hasRequiredFields) {
          results.push({
            id: "sep38.quote_schema",
            description: quoteCheckDescriptions["sep38.quote_schema"],
            status: "fail",
            severity: "error",
            message:
              "Response JSON is missing required fields (id, expires_at, total_price, price, sell_asset, sell_amount, buy_asset, buy_amount, or fee object)",
          });
        } else {
          results.push({
            id: "sep38.quote_schema",
            description: quoteCheckDescriptions["sep38.quote_schema"],
            status: "pass",
            severity: "error",
            message: `POST /quote returned valid schema with id ${body.id}`,
          });
          createdQuote = { id: body.id, price: body.price, expires_at: body.expires_at };
        }

        const price = parseFloat(body.price ?? "");
        const totalPrice = parseFloat(body.total_price ?? "");
        const sellAmt = parseFloat(body.sell_amount ?? "");
        const buyAmt = parseFloat(body.buy_amount ?? "");
        const positivityOk = [price, totalPrice, sellAmt, buyAmt].every(
          (n) => !isNaN(n) && n > 0,
        );

        if (!positivityOk) {
          results.push({
            id: "sep38.quote_positive",
            description: quoteCheckDescriptions["sep38.quote_positive"],
            status: "fail",
            severity: "error",
            message: `price, total_price, sell_amount, and buy_amount must all be positive numbers (got price=${body.price}, total_price=${body.total_price}, sell_amount=${body.sell_amount}, buy_amount=${body.buy_amount})`,
          });
        } else {
          const totalPriceConsistent = approxEqual(sellAmt, totalPrice * buyAmt);

          let feeConsistent = true;
          const feeTotal = parseFloat(body.fee?.total ?? "");
          if (!isNaN(feeTotal) && typeof body.fee?.asset === "string") {
            if (body.fee.asset === sellAsset) {
              feeConsistent = approxEqual(sellAmt - feeTotal, price * buyAmt);
            } else if (body.fee.asset === buyAsset) {
              feeConsistent = approxEqual(sellAmt, price * (buyAmt + feeTotal));
            }
          }

          if (!totalPriceConsistent || !feeConsistent) {
            results.push({
              id: "sep38.quote_positive",
              description: quoteCheckDescriptions["sep38.quote_positive"],
              status: "fail",
              severity: "error",
              message: `Returned amounts are inconsistent with the quoted price per SEP-38's price formulas (sell_amount=${body.sell_amount}, total_price=${body.total_price}, price=${body.price}, buy_amount=${body.buy_amount}, fee=${body.fee?.total} ${body.fee?.asset})`,
            });
          } else {
            results.push({
              id: "sep38.quote_positive",
              description: quoteCheckDescriptions["sep38.quote_positive"],
              status: "pass",
              severity: "error",
              message: `price and total_price are positive and consistent with sell_amount=${body.sell_amount}, buy_amount=${body.buy_amount}`,
            });
          }
        }

        if (typeof body.expires_at !== "string") {
          results.push({
            id: "sep38.quote_expires_at",
            description: quoteCheckDescriptions["sep38.quote_expires_at"],
            status: "fail",
            severity: "error",
            message: "expires_at is required in the POST /quote response but was missing",
          });
        } else {
          const expTime = Date.parse(body.expires_at);
          if (isNaN(expTime)) {
            results.push({
              id: "sep38.quote_expires_at",
              description: quoteCheckDescriptions["sep38.quote_expires_at"],
              status: "fail",
              severity: "error",
              message: `expires_at is not a valid ISO 8601 date string: ${body.expires_at}`,
            });
          } else if (expTime <= Date.now()) {
            results.push({
              id: "sep38.quote_expires_at",
              description: quoteCheckDescriptions["sep38.quote_expires_at"],
              status: "fail",
              severity: "error",
              message: `expires_at must be in the future, but got timestamp in past/present: ${body.expires_at}`,
            });
          } else {
            results.push({
              id: "sep38.quote_expires_at",
              description: quoteCheckDescriptions["sep38.quote_expires_at"],
              status: "pass",
              severity: "error",
              message: `expires_at is a valid future timestamp: ${body.expires_at}`,
            });
          }
        }
      }
    } catch (err) {
      for (const id of quoteCheckIds) {
        results.push({
          id,
          description: quoteCheckDescriptions[id],
          status: "fail",
          severity: "error",
          message: (err as Error).message,
        });
      }
    }
  }

  // 8. GET /quote/{id} returns the same quote created by POST /quote
  if (!opts.jwt) {
    results.push({
      id: "sep38.quote_get_matches",
      description: "GET /quote/{id} returns the same quote created by POST /quote",
      status: "warn",
      severity: "warning",
      message: "Skipped: SEP-10 JWT required to fetch a firm quote",
    });
  } else if (opts.noWrite) {
    results.push({
      id: "sep38.quote_get_matches",
      description: "GET /quote/{id} returns the same quote created by POST /quote",
      status: "warn",
      severity: "warning",
      message: "Skipped: --no-write mode enabled; no quote created to fetch by id",
    });
  } else if (!createdQuote?.id) {
    results.push({
      id: "sep38.quote_get_matches",
      description: "GET /quote/{id} returns the same quote created by POST /quote",
      status: "warn",
      severity: "warning",
      message: "Skipped: POST /quote did not return a usable id",
    });
  } else {
    try {
      const getUrl = `${baseUrl}/quote/${encodeURIComponent(createdQuote.id)}`;
      const res = await fetchWithTimeout(
        getUrl,
        { headers: { Authorization: `Bearer ${opts.jwt}` } },
        opts.timeoutMs,
      );

      if (!res.ok) {
        results.push({
          id: "sep38.quote_get_matches",
          description: "GET /quote/{id} returns the same quote created by POST /quote",
          status: "fail",
          severity: "error",
          message: `GET ${getUrl} returned HTTP ${res.status}`,
        });
      } else {
        const body = (await res.json()) as { id?: string; price?: string; expires_at?: string };
        const mismatches: string[] = [];
        if (body.id !== createdQuote.id) {
          mismatches.push(`id (expected ${createdQuote.id}, got ${body.id})`);
        }
        if (body.price !== createdQuote.price) {
          mismatches.push(`price (expected ${createdQuote.price}, got ${body.price})`);
        }
        if (body.expires_at !== createdQuote.expires_at) {
          mismatches.push(
            `expires_at (expected ${createdQuote.expires_at}, got ${body.expires_at})`,
          );
        }

        if (mismatches.length > 0) {
          results.push({
            id: "sep38.quote_get_matches",
            description: "GET /quote/{id} returns the same quote created by POST /quote",
            status: "fail",
            severity: "error",
            message: `GET /quote/{id} does not match the quote created by POST /quote: ${mismatches.join(", ")}`,
          });
        } else {
          results.push({
            id: "sep38.quote_get_matches",
            description: "GET /quote/{id} returns the same quote created by POST /quote",
            status: "pass",
            severity: "error",
            message: `GET /quote/{id} returned a consistent quote with id ${body.id}`,
          });
        }
      }
    } catch (err) {
      results.push({
        id: "sep38.quote_get_matches",
        description: "GET /quote/{id} returns the same quote created by POST /quote",
        status: "fail",
        severity: "error",
        message: (err as Error).message,
      });
    }
  }

  // 9. Negative check: GET /quote/{id} with a nonexistent id returns 404. Read-only,
  // so this runs regardless of --no-write.
  if (!opts.jwt) {
    results.push({
      id: "sep38.quote_get_nonexistent",
      description: "GET /quote/{id} with a nonexistent id returns HTTP 404",
      status: "warn",
      severity: "warning",
      message: "Skipped: SEP-10 JWT required to query GET /quote/{id}",
    });
  } else {
    try {
      const bogusId = "00000000-0000-4000-8000-000000000000";
      const getUrl = `${baseUrl}/quote/${encodeURIComponent(bogusId)}`;
      const res = await fetchWithTimeout(
        getUrl,
        { headers: { Authorization: `Bearer ${opts.jwt}` } },
        opts.timeoutMs,
      );

      if (res.status === 404) {
        results.push({
          id: "sep38.quote_get_nonexistent",
          description: "GET /quote/{id} with a nonexistent id returns HTTP 404",
          status: "pass",
          severity: "error",
          message: `Anchor correctly returned HTTP 404 for nonexistent quote id ${bogusId}`,
        });
      } else if (res.ok) {
        results.push({
          id: "sep38.quote_get_nonexistent",
          description: "GET /quote/{id} with a nonexistent id returns HTTP 404",
          status: "fail",
          severity: "error",
          message: `Anchor returned HTTP ${res.status} and a quote body for nonexistent quote id ${bogusId}; expected HTTP 404`,
        });
      } else {
        results.push({
          id: "sep38.quote_get_nonexistent",
          description: "GET /quote/{id} with a nonexistent id returns HTTP 404",
          status: "warn",
          severity: "warning",
          message: `Anchor returned HTTP ${res.status} for nonexistent quote id ${bogusId} (expected 404); inconclusive`,
        });
      }
    } catch (err) {
      results.push({
        id: "sep38.quote_get_nonexistent",
        description: "GET /quote/{id} with a nonexistent id returns HTTP 404",
        status: "fail",
        severity: "error",
        message: (err as Error).message,
      });
    }
  }

  return results;
}
