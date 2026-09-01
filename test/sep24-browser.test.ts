import { describe, expect, it, vi } from "vitest";
import type { Browser, Page, Response as PlaywrightResponse } from "playwright";
import { runSep24BrowserChecks } from "../src/checks/sep24-browser.js";

describe("runSep24BrowserChecks", () => {
  it("returns a warning check if Playwright browser binary is missing", async () => {
    const customLauncher = vi.fn(async () => {
      throw new Error(
        "Executable doesn't exist at /path/to/chromium. Run 'npx playwright install'",
      );
    });

    const { results } = await runSep24BrowserChecks({
      interactiveUrl: "https://anchor.example.com/interactive/flow",
      browserLauncher: customLauncher as unknown as () => Promise<Browser>,
    });

    const launchCheck = results.find(
      (r) => r.id === "sep24.interactive_browser_launch",
    );
    expect(launchCheck?.status).toBe("warn");
    expect(launchCheck?.message).toContain("Playwright Chromium binary not installed");
  });

  it("returns an actionable warning check if Playwright package is missing", async () => {
    const customLauncher = vi.fn(async () => {
      throw new Error("Cannot find package 'playwright' imported from sep24-browser.js");
    });

    const { results } = await runSep24BrowserChecks({
      interactiveUrl: "https://anchor.example.com/interactive/flow",
      browserLauncher: customLauncher as unknown as () => Promise<Browser>,
    });

    const launchCheck = results.find(
      (r) => r.id === "sep24.interactive_browser_launch",
    );
    expect(launchCheck?.status).toBe("warn");
    expect(launchCheck?.severity).toBe("warning");
    expect(launchCheck?.message).toContain("npm install playwright");
  });

  it("passes when navigation, form detection, and postMessage succeed", async () => {
    let postMessageCallback: ((data: unknown) => void) | null = null;

    const mockPage = {
      setDefaultTimeout: vi.fn(),
      exposeFunction: vi.fn(async (_name: string, fn: (data: unknown) => void) => {
        postMessageCallback = fn;
      }),
      addInitScript: vi.fn(async () => {}),
      goto: vi.fn(async () => {
        // Trigger postMessage callback as if from the webapp
        if (postMessageCallback) {
          postMessageCallback({
            type: "stellar-sep24",
            status: "success",
            transaction: { id: "tx-123" },
          });
        }
        return {
          ok: () => true,
          status: () => 200,
        } as unknown as PlaywrightResponse;
      }),
      locator: vi.fn((selector: string) => {
        if (selector === "form") {
          return { count: async () => 1 };
        }
        if (selector === "input:not([type=hidden])") {
          return { count: async () => 2 };
        }
        if (selector === "input:not([type=hidden]):visible") {
          return {
            count: async () => 2,
            nth: (i: number) => ({
              getAttribute: async (attr: string) => (attr === "name" ? (i === 0 ? "amount" : "email") : "text"),
              fill: vi.fn(async () => {}),
            }),
          };
        }
        // submit button
        return {
          first: () => ({
            count: async () => 1,
            click: vi.fn(async () => {}),
          }),
        };
      }),
      url: vi.fn(() => "https://anchor.example.com/interactive/flow"),
      waitForTimeout: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as unknown as Page;

    const mockBrowser = {
      newPage: vi.fn(async () => mockPage),
      close: vi.fn(async () => {}),
    } as unknown as Browser;

    const { results, postMessageReceived, formDetected } =
      await runSep24BrowserChecks({
        interactiveUrl: "https://anchor.example.com/interactive/flow",
        browserLauncher: async () => mockBrowser,
      });

    expect(postMessageReceived).toBe(true);
    expect(formDetected).toBe(true);

    const launchCheck = results.find(
      (r) => r.id === "sep24.interactive_browser_launch",
    );
    const formCheck = results.find(
      (r) => r.id === "sep24.interactive_form_detected",
    );
    const callbackCheck = results.find(
      (r) => r.id === "sep24.interactive_completion_callback",
    );

    expect(launchCheck?.status).toBe("pass");
    expect(formCheck?.status).toBe("pass");
    expect(callbackCheck?.status).toBe("pass");
    expect(callbackCheck?.message).toContain("Received completion postMessage");
  });

  it("passes completion callback when page redirects to callback URL", async () => {
    const mockPage = {
      setDefaultTimeout: vi.fn(),
      exposeFunction: vi.fn(async () => {}),
      addInitScript: vi.fn(async () => {}),
      goto: vi.fn(async () => {
        return {
          ok: () => true,
          status: () => 200,
        } as unknown as PlaywrightResponse;
      }),
      locator: vi.fn(() => ({
        count: async () => 0,
        first: () => ({ count: async () => 0, click: vi.fn(async () => {}) }),
        nth: () => ({
          getAttribute: async () => "text",
          fill: vi.fn(async () => {}),
        }),
      })),
      url: vi.fn(() => "https://anchor.example.com/callback?status=completed&transaction_id=tx-123"),
      waitForTimeout: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as unknown as Page;

    const mockBrowser = {
      newPage: vi.fn(async () => mockPage),
      close: vi.fn(async () => {}),
    } as unknown as Browser;

    const { results, redirectUrl } = await runSep24BrowserChecks({
      interactiveUrl: "https://anchor.example.com/interactive/flow",
      browserLauncher: async () => mockBrowser,
    });

    expect(redirectUrl).toContain("callback?status=completed");
    const callbackCheck = results.find(
      (r) => r.id === "sep24.interactive_completion_callback",
    );
    expect(callbackCheck?.status).toBe("pass");
    expect(callbackCheck?.message).toContain("Redirected to completion URL");
  });

  it("fails when interactive URL returns non-2xx status", async () => {
    const mockPage = {
      setDefaultTimeout: vi.fn(),
      exposeFunction: vi.fn(async () => {}),
      addInitScript: vi.fn(async () => {}),
      goto: vi.fn(async () => {
        return {
          ok: () => false,
          status: () => 500,
        } as unknown as PlaywrightResponse;
      }),
      close: vi.fn(async () => {}),
    } as unknown as Page;

    const mockBrowser = {
      newPage: vi.fn(async () => mockPage),
      close: vi.fn(async () => {}),
    } as unknown as Browser;

    const { results } = await runSep24BrowserChecks({
      interactiveUrl: "https://anchor.example.com/interactive/flow",
      browserLauncher: async () => mockBrowser,
    });

    const launchCheck = results.find(
      (r) => r.id === "sep24.interactive_browser_launch",
    );
    expect(launchCheck?.status).toBe("fail");
    expect(launchCheck?.message).toContain("HTTP 500");
  });

  it("warns when no forms or inputs are detected on page", async () => {
    const mockPage = {
      setDefaultTimeout: vi.fn(),
      exposeFunction: vi.fn(async () => {}),
      addInitScript: vi.fn(async () => {}),
      goto: vi.fn(async () => {
        return {
          ok: () => true,
          status: () => 200,
        } as unknown as PlaywrightResponse;
      }),
      locator: vi.fn(() => ({
        count: async () => 0,
      })),
      url: vi.fn(() => "https://anchor.example.com/interactive/flow"),
      waitForTimeout: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as unknown as Page;

    const mockBrowser = {
      newPage: vi.fn(async () => mockPage),
      close: vi.fn(async () => {}),
    } as unknown as Browser;

    const { results, formDetected } = await runSep24BrowserChecks({
      interactiveUrl: "https://anchor.example.com/interactive/flow",
      browserLauncher: async () => mockBrowser,
    });

    expect(formDetected).toBe(false);
    const formCheck = results.find(
      (r) => r.id === "sep24.interactive_form_detected",
    );
    const callbackCheck = results.find(
      (r) => r.id === "sep24.interactive_completion_callback",
    );

    expect(formCheck?.status).toBe("warn");
    expect(callbackCheck?.status).toBe("warn");
  });
});
