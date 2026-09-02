export class HttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpError";
  }
}

let verboseLogging = false;

export function setVerbose(enabled: boolean): void {
  verboseLogging = enabled;
}

export function isVerbose(): boolean {
  return verboseLogging;
}

export const CAUSE_EXPLANATIONS: Record<string, string> = {
  ENOTFOUND: "DNS lookup failed; the domain does not resolve",
  EAI_AGAIN: "DNS lookup failed; the domain does not resolve",
  ECONNREFUSED: "connection refused",
  ECONNRESET: "connection reset by peer",
  CERT_HAS_EXPIRED: "certificate has expired",
  DEPTH_ZERO_SELF_SIGNED_CERT: "self-signed certificate in certificate chain",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "unable to verify leaf signature",
  ERR_TLS_CERT_ALTNAME_INVALID: "certificate host name mismatch (ALTNAME_INVALID)",
};

export function formatErrorDetail(err: unknown): string {
  if (err && typeof err === "object") {
    const cause = (err as { cause?: unknown }).cause;

    if (typeof cause === "string") {
      return cause;
    }

    if (cause && typeof cause === "object") {
      const candidate =
        Array.isArray((cause as { errors?: unknown[] }).errors) &&
        (cause as { errors: unknown[] }).errors.length > 0
          ? (cause as { errors: unknown[] }).errors[0]
          : cause;

      if (typeof candidate === "string") {
        return candidate;
      }

      if (candidate && typeof candidate === "object") {
        const c = candidate as { code?: unknown; name?: unknown; message?: unknown };
        const code =
          typeof c.code === "string"
            ? c.code
            : typeof c.name === "string" && c.name !== "Error"
            ? c.name
            : undefined;

        const message = typeof c.message === "string" ? c.message : undefined;
        const explanation = code ? CAUSE_EXPLANATIONS[code] : undefined;

        if (explanation) {
          if (code && message) {
            if (message.toLowerCase() === explanation.toLowerCase()) {
              return `${explanation} (${code})`;
            }
            if (message.includes(code)) {
              return `${explanation} (${message})`;
            }
            return `${explanation} (${code}: ${message})`;
          }
          if (code) {
            return `${explanation} (${code})`;
          }
          return explanation;
        }

        if (code && message) {
          return message.includes(code) ? message : `${code}: ${message}`;
        }
        if (code) {
          return code;
        }
        if (message) {
          return message;
        }
      }
    }
  }

  if (err instanceof Error && err.message && err.message !== "fetch failed") {
    return err.message;
  }

  return "fetch failed";
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<Response> {
  const method = init.method ?? "GET";
  const start = Date.now();
  if (verboseLogging) {
    process.stderr.write(`[http] > ${method} ${url}\n`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (verboseLogging) {
      const elapsed = Date.now() - start;
      process.stderr.write(`[http] < ${res.status} ${res.statusText || ""} (${elapsed}ms)\n`);
    }
    return res;
  } catch (err) {
    const detail = formatErrorDetail(err);
    if (verboseLogging) {
      const elapsed = Date.now() - start;
      process.stderr.write(`[http] ! error: ${detail} (${elapsed}ms)\n`);
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new HttpError(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw new HttpError(`Request to ${url} failed: ${detail}`);
  } finally {
    clearTimeout(timeout);
  }
}
