import { fetchWithTimeout } from "../core/http.js";
import type { CheckResult } from "../core/report.js";
import type { StellarToml } from "./sep1.js";

export interface Sep38Options {
  domain: string;
  toml: StellarToml;
  network: "testnet" | "mainnet";
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
    const res = await fetchWithTimeout(`${baseUrl}/info`);
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
          sellAsset = validAssets[0];
          buyAsset = validAssets.length > 1 ? validAssets[1] : validAssets[0];
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
    const res = await fetchWithTimeout(`${baseUrl}/prices`);
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
    const res = await fetchWithTimeout(
      `${baseUrl}/prices?sell_asset=${encodeURIComponent(sellAsset)}`,
    );
    if (!res.ok) {
      results.push({
        id: "sep38.prices_schema",
        description: "GET /prices returns well-formed JSON matching SEP-38 schema",
        status: "fail",
        severity: "error",
        message: `GET /prices returned HTTP ${res.status}`,
      });
      results.push({
        id: "sep38.prices_positive",
        description: "GET /prices returned prices are positive numbers",
        status: "fail",
        severity: "error",
        message: "Cannot validate prices because GET /prices failed",
      });
    } else {
      const body = (await res.json()) as {
        buy_tokens?: Array<{ asset?: string; price?: string; decimals?: number }>;
      };

      if (!Array.isArray(body.buy_tokens)) {
        results.push({
          id: "sep38.prices_schema",
          description: "GET /prices returns well-formed JSON matching SEP-38 schema",
          status: "fail",
          severity: "error",
          message: 'Response JSON is missing the "buy_tokens" array',
        });
        results.push({
          id: "sep38.prices_positive",
          description: "GET /prices returned prices are positive numbers",
          status: "fail",
          severity: "error",
          message: 'Cannot validate prices: "buy_tokens" array is missing',
        });
      } else {
        const invalidTokens = body.buy_tokens.filter(
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
            message: `buy_tokens contains ${invalidTokens.length} item(s) missing required fields (asset, price, decimals)`,
          });
        } else {
          results.push({
            id: "sep38.prices_schema",
            description: "GET /prices returns well-formed JSON matching SEP-38 schema",
            status: "pass",
            severity: "error",
            message: `GET /prices returned valid schema with ${body.buy_tokens.length} token(s)`,
          });
        }

        const nonPositive = body.buy_tokens.filter((t) => {
          const p = parseFloat(t.price ?? "");
          return isNaN(p) || p <= 0;
        });

        if (nonPositive.length > 0) {
          results.push({
            id: "sep38.prices_positive",
            description: "GET /prices returned prices are positive numbers",
            status: "fail",
            severity: "error",
            message: `Found ${nonPositive.length} non-positive or invalid price(s) in buy_tokens`,
          });
        } else {
          results.push({
            id: "sep38.prices_positive",
            description: "GET /prices returned prices are positive numbers",
            status: "pass",
            severity: "error",
            message: "All returned prices in buy_tokens are positive numbers",
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
  try {
    const priceUrl = `${baseUrl}/price?sell_asset=${encodeURIComponent(
      sellAsset,
    )}&buy_asset=${encodeURIComponent(buyAsset)}&sell_amount=100`;

    const res = await fetchWithTimeout(priceUrl);
    if (!res.ok) {
      results.push({
        id: "sep38.price_schema",
        description: "GET /price returns well-formed JSON matching SEP-38 schema",
        status: "fail",
        severity: "error",
        message: `GET /price returned HTTP ${res.status}`,
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

  return results;
}
