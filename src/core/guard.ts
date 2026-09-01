import type { CheckResult } from "./report.js";

export async function guardChecker<T extends CheckResult[]>(
  sepId: string,
  description: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const fallback: CheckResult[] = [
      {
        id: `${sepId}.unexpected_error`,
        description,
        status: "fail",
        severity: "error",
        message: `Unexpected error during ${sepId} checks: ${(err as Error).message || String(err)}`,
      },
    ];
    return fallback as unknown as T;
  }
}
