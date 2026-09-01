import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout, HttpError, isVerbose, setVerbose } from "../src/core/http.js";

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
    const data = await res.json();
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

  it("logs error to stderr when verbose is true and fetch fails", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    setVerbose(true);

    global.fetch = vi.fn(async () => {
      throw new Error("Connection refused");
    });

    try {
      await fetchWithTimeout("https://example.com/error-test");
    } catch {
      // Expected
    }

    const calls = stderrSpy.mock.calls.map((c) => c[0].toString()).join("");
    expect(calls).toContain("[http] > GET https://example.com/error-test");
    expect(calls).toContain("[http] ! error: Connection refused");
  });
});
