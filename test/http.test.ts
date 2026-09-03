import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchWithTimeout,
  formatErrorDetail,
  HttpError,
  isVerbose,
  setVerbose,
} from "../src/core/http.js";

describe("core/http", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setVerbose(false);
  });

  it("successfully returns response on HTTP success", async () => {
    global.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const res = await fetchWithTimeout("https://example.com/api");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(true);
  });

  it("converts AbortError to HttpError with timeout message", async () => {
    global.fetch = vi.fn(async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = (init as RequestInit)?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    });

    await expect(fetchWithTimeout("https://example.com/timeout", {}, 20)).rejects.toThrow(
      "Request to https://example.com/timeout timed out after 20ms",
    );
  });

  it("converts generic network errors to HttpError", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("DNS resolution failed");
    });

    await expect(fetchWithTimeout("https://example.com/network-failure")).rejects.toThrow(
      "Request to https://example.com/network-failure failed: DNS resolution failed",
    );
  });

  it("surfaces mapped cause ENOTFOUND with explanation and details", async () => {
    global.fetch = vi.fn(async () => {
      const cause = new Error("getaddrinfo ENOTFOUND bad.domain");
      (cause as any).code = "ENOTFOUND";
      const err = new TypeError("fetch failed");
      (err as any).cause = cause;
      throw err;
    });

    await expect(fetchWithTimeout("https://bad.domain/stellar.toml")).rejects.toThrow(
      "Request to https://bad.domain/stellar.toml failed: DNS lookup failed; the domain does not resolve (getaddrinfo ENOTFOUND bad.domain)",
    );
  });

  it("surfaces mapped cause ECONNREFUSED with explanation and code", async () => {
    global.fetch = vi.fn(async () => {
      const cause = new Error("connect ECONNREFUSED 127.0.0.1:80");
      (cause as any).code = "ECONNREFUSED";
      const err = new TypeError("fetch failed");
      (err as any).cause = cause;
      throw err;
    });

    await expect(fetchWithTimeout("https://localhost/api")).rejects.toThrow(
      "Request to https://localhost/api failed: connection refused (connect ECONNREFUSED 127.0.0.1:80)",
    );
  });

  it("surfaces TLS certificate cause CERT_HAS_EXPIRED with explanation and code", async () => {
    global.fetch = vi.fn(async () => {
      const cause = new Error("certificate has expired");
      (cause as any).code = "CERT_HAS_EXPIRED";
      const err = new TypeError("fetch failed");
      (err as any).cause = cause;
      throw err;
    });

    await expect(fetchWithTimeout("https://expired.example.com/stellar.toml")).rejects.toThrow(
      "Request to https://expired.example.com/stellar.toml failed: certificate has expired (CERT_HAS_EXPIRED)",
    );
  });

  it("surfaces unmapped cause retaining raw code and message rather than bare fetch failed", async () => {
    global.fetch = vi.fn(async () => {
      const cause = new Error("No route to host");
      (cause as any).code = "EHOSTUNREACH";
      const err = new TypeError("fetch failed");
      (err as any).cause = cause;
      throw err;
    });

    await expect(fetchWithTimeout("https://unreachable.example.com")).rejects.toThrow(
      "Request to https://unreachable.example.com failed: EHOSTUNREACH: No route to host",
    );
  });

  it("inspects AggregateError cause and surfaces first error", async () => {
    global.fetch = vi.fn(async () => {
      const causeErr = new Error("getaddrinfo ENOTFOUND fail.org");
      (causeErr as any).code = "ENOTFOUND";
      const aggErr = new AggregateError([causeErr], "Multiple connection failures");
      const err = new TypeError("fetch failed");
      (err as any).cause = aggErr;
      throw err;
    });

    await expect(fetchWithTimeout("https://fail.org")).rejects.toThrow(
      "Request to https://fail.org failed: DNS lookup failed; the domain does not resolve (getaddrinfo ENOTFOUND fail.org)",
    );
  });

  it("formats string cause correctly", () => {
    const err = { cause: "Socket closed abruptly" };
    expect(formatErrorDetail(err)).toBe("Socket closed abruptly");
  });

  it("HttpError has correct name and message", () => {
    const error = new HttpError("Custom HTTP error");
    expect(error.name).toBe("HttpError");
    expect(error.message).toBe("Custom HTTP error");
    expect(error instanceof Error).toBe(true);
  });

  it("logs request and response to stderr when verbose is true", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    setVerbose(true);
    expect(isVerbose()).toBe(true);

    global.fetch = vi.fn(async () => {
      return new Response("ok", { status: 200, statusText: "OK" });
    });

    await fetchWithTimeout("https://example.com/verbose-test", { method: "POST" });

    expect(stderrSpy).toHaveBeenCalled();
    const calls = stderrSpy.mock.calls.map((c) => c[0].toString()).join("");
    expect(calls).toContain("[http] > POST https://example.com/verbose-test");
    expect(calls).toContain("[http] < 200 OK");
  });

  it("logs error with cause to stderr when verbose is true and fetch fails", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    setVerbose(true);

    global.fetch = vi.fn(async () => {
      const cause = new Error("connect ECONNREFUSED 127.0.0.1:80");
      (cause as any).code = "ECONNREFUSED";
      const err = new TypeError("fetch failed");
      (err as any).cause = cause;
      throw err;
    });

    try {
      await fetchWithTimeout("https://example.com/error-test");
    } catch {
      // Expected
    }

    const calls = stderrSpy.mock.calls.map((c) => c[0].toString()).join("");
    expect(calls).toContain("[http] > GET https://example.com/error-test");
    expect(calls).toContain("[http] ! error: connection refused (connect ECONNREFUSED 127.0.0.1:80)");
  });
});
