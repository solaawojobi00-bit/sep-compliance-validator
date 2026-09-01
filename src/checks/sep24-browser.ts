import { chromium, Browser, Page } from "playwright";
import type { CheckResult } from "../core/report.js";

export interface Sep24BrowserOptions {
  interactiveUrl: string;
  timeoutMs?: number;
  browserLauncher?: () => Promise<Browser>;
}

export interface Sep24BrowserResult {
  results: CheckResult[];
  postMessageReceived?: boolean;
  redirectUrl?: string;
  formDetected?: boolean;
}

export async function runSep24BrowserChecks(
  opts: Sep24BrowserOptions,
): Promise<Sep24BrowserResult> {
  const results: CheckResult[] = [];
  const timeoutMs = opts.timeoutMs ?? 10_000;

  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    if (opts.browserLauncher) {
      browser = await opts.browserLauncher();
    } else {
      browser = await chromium.launch({ headless: true });
    }
  } catch (err) {
    const msg = (err as Error).message;
    const isMissingBinary =
      msg.includes("Executable doesn't exist") ||
      msg.includes("playwright install") ||
      msg.includes("browserType.launch");
    results.push({
      id: "sep24.interactive_browser_launch",
      description: "Launch headless browser and navigate to interactive URL",
      status: isMissingBinary ? "warn" : "fail",
      severity: isMissingBinary ? "warning" : "error",
      message: isMissingBinary
        ? `Browser launch skipped: Playwright Chromium binary not installed. Run "npx playwright install chromium" to enable.`
        : `Failed to launch headless browser: ${msg}`,
    });
    return { results };
  }

  try {
    page = await browser.newPage();
    page.setDefaultTimeout(timeoutMs);

    let postMessageData: unknown = null;
    let postMessageReceived = false;

    // Listen for postMessage from the interactive webapp
    await page.exposeFunction("__sep24OnPostMessage", (data: unknown) => {
      postMessageReceived = true;
      postMessageData = data;
    });

    await page.addInitScript(`
      window.addEventListener("message", function(event) {
        if (typeof window.__sep24OnPostMessage === "function") {
          window.__sep24OnPostMessage(event.data);
        }
      });
    `);

    // 1. Navigate to interactive URL
    const response = await page.goto(opts.interactiveUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    if (!response || !response.ok()) {
      const status = response ? response.status() : "no response";
      results.push({
        id: "sep24.interactive_browser_launch",
        description: "Launch headless browser and navigate to interactive URL",
        status: "fail",
        severity: "error",
        message: `Interactive URL returned HTTP ${status}`,
      });
      return { results };
    }

    results.push({
      id: "sep24.interactive_browser_launch",
      description: "Launch headless browser and navigate to interactive URL",
      status: "pass",
      severity: "error",
      message: `Successfully navigated to interactive URL (HTTP ${response.status()})`,
    });

    // 2. Detect form elements
    const formCount = await page.locator("form").count();
    const inputCount = await page.locator("input:not([type=hidden])").count();

    const formDetected = formCount > 0 || inputCount > 0;
    if (formDetected) {
      results.push({
        id: "sep24.interactive_form_detected",
        description: "Detect interactive deposit/withdraw form inputs",
        status: "pass",
        severity: "error",
        message: `Detected ${formCount} form(s) and ${inputCount} interactive input(s)`,
      });

      // Fill mock data into visible inputs if present
      const inputs = page.locator("input:not([type=hidden]):visible");
      const visibleInputCount = await inputs.count();
      for (let i = 0; i < visibleInputCount; i++) {
        const input = inputs.nth(i);
        const type = (await input.getAttribute("type")) ?? "text";
        const name = (await input.getAttribute("name")) ?? "";
        try {
          if (type === "number" || name.toLowerCase().includes("amount")) {
            await input.fill("10.00");
          } else if (type === "email" || name.toLowerCase().includes("email")) {
            await input.fill("user@example.com");
          } else if (type === "text") {
            await input.fill("Test User");
          }
        } catch {
          // Non-fatal if specific input fill fails
        }
      }

      // If a submit button is present, attempt submission
      const submitBtn = page
        .locator(
          "button[type=submit], input[type=submit], button:has-text('Submit'), button:has-text('Continue'), button:has-text('Next')",
        )
        .first();
      if ((await submitBtn.count()) > 0) {
        try {
          await submitBtn.click({ timeout: 2000 });
        } catch {
          // Submission click optional
        }
      }
    } else {
      results.push({
        id: "sep24.interactive_form_detected",
        description: "Detect interactive deposit/withdraw form inputs",
        status: "warn",
        severity: "warning",
        message: "No interactive form or visible input elements detected on initial page",
      });
    }

    // 3. Check for completion callback (postMessage or redirect)
    await page.waitForTimeout(500);

    const currentUrl = page.url();
    const redirected =
      currentUrl !== opts.interactiveUrl &&
      (currentUrl.includes("callback") || currentUrl.includes("status="));

    if (postMessageReceived || redirected) {
      results.push({
        id: "sep24.interactive_completion_callback",
        description:
          "Verify interactive flow completion callback (postMessage or redirect)",
        status: "pass",
        severity: "error",
        message: postMessageReceived
          ? `Received completion postMessage from interactive webapp: ${JSON.stringify(postMessageData)}`
          : `Redirected to completion URL: ${currentUrl}`,
      });
    } else {
      results.push({
        id: "sep24.interactive_completion_callback",
        description:
          "Verify interactive flow completion callback (postMessage or redirect)",
        status: "warn",
        severity: "warning",
        message:
          "No completion postMessage or redirect callback observed during automated session",
      });
    }

    return {
      results,
      postMessageReceived,
      redirectUrl: redirected ? currentUrl : undefined,
      formDetected,
    };
  } catch (err) {
    results.push({
      id: "sep24.interactive_browser_flow",
      description: "Automate interactive browser session",
      status: "fail",
      severity: "error",
      message: (err as Error).message,
    });
    return { results };
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
