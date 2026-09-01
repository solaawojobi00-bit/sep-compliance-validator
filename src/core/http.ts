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
    if (verboseLogging) {
      const elapsed = Date.now() - start;
      process.stderr.write(`[http] ! error: ${(err as Error).message} (${elapsed}ms)\n`);
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new HttpError(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw new HttpError(`Request to ${url} failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }
}
