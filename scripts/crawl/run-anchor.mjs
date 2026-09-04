/**
 * Runs one anchor's legs by spawning the built CLI, with the one retry §5.2 requires.
 *
 * Failure containment is per leg: a leg that cannot produce a usable report returns a
 * reason, never throws, so the other leg's results still publish and the batch keeps
 * moving to the next anchor.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

export const RETRY_DELAY_MS = 10_000;

/**
 * Exit codes the CLI defines: 0 all checks passed, 1 one or more failed, 2 the
 * invocation itself was rejected. 0 and 1 are both legitimate outcomes that produce a
 * report; 2 means the crawler built a bad command line, which is our bug and is not
 * retried because it would fail identically.
 */
const EXIT_OK = 0;
const EXIT_CHECKS_FAILED = 1;
const EXIT_USAGE = 2;

/**
 * Failure signatures worth one retry. §5.2 asks for a retry on a timeout or a 5xx, but
 * the CLI absorbs those into failed *checks* rather than a failed process, so this is
 * where they have to be recognised: if the run could not reach the anchor at all, a blip
 * would otherwise be published as a total failure.
 */
const TRANSIENT = /timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|HTTP 5\d\d|DNS lookup failed/i;

/** True when a report's failures look like a transport hiccup rather than a verdict. */
export function looksTransient(report) {
  const results = report?.results ?? [];
  const fetchFailed = results.some(
    (r) => r.id === "sep1.fetch" && r.status === "fail" && TRANSIENT.test(r.message ?? ""),
  );
  if (fetchFailed) {
    return true;
  }
  // A single flaky endpoint is not worth a re-run; the whole anchor being unreachable is.
  const failures = results.filter((r) => r.status === "fail");
  return failures.length > 0 && failures.every((r) => TRANSIENT.test(r.message ?? ""));
}

function spawnCli(cliPath, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stdout.on("data", () => {});
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (err) => resolve({ code: null, stderr: err.message }));
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

async function attemptLeg({ cliPath, args, outputPath, env }) {
  const { code, stderr } = await spawnCli(cliPath, args, env);

  if (code === EXIT_USAGE) {
    return { ok: false, retryable: false, reason: `the validator rejected the invocation (exit 2): ${stderr.trim().split("\n")[0] ?? ""}` };
  }
  if (code !== EXIT_OK && code !== EXIT_CHECKS_FAILED) {
    return { ok: false, retryable: true, reason: `the validator exited with code ${code}` };
  }

  let report;
  try {
    report = JSON.parse(await readFile(outputPath, "utf-8"));
  } catch (err) {
    return { ok: false, retryable: true, reason: `report was not written or is unreadable (${err.message})` };
  }

  return { ok: true, report };
}

/**
 * Runs one leg, retrying once on a retryable failure or a report that looks like a
 * transient outage. Returns `{ report }` or `{ reason }` - never throws.
 */
export async function runLeg({ cliPath, args, outputPath, env = process.env, retryDelayMs = RETRY_DELAY_MS, log = () => {} }) {
  const first = await attemptLeg({ cliPath, args, outputPath, env });

  if (first.ok && !looksTransient(first.report)) {
    return { report: first.report };
  }
  if (!first.ok && !first.retryable) {
    return { reason: first.reason };
  }

  const why = first.ok ? "the anchor looked unreachable" : first.reason;
  log(`retrying in ${retryDelayMs / 1000}s: ${why}`);
  await new Promise((resolve) => setTimeout(resolve, retryDelayMs));

  const second = await attemptLeg({ cliPath, args, outputPath, env });
  if (second.ok) {
    // Published even if it still looks transient: two failed attempts is a finding, and
    // the report's own messages say what went wrong.
    return { report: second.report };
  }
  return { reason: `${second.reason} (after one retry)` };
}
