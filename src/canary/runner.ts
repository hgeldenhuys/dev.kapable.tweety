/**
 * Check Runner -- registry of canary checks, sequential execution, and report generation.
 */
import type { CanaryReport, CheckResult } from "./types";
import { type HttpClient, createHttpClient } from "./http";
import { healthCheck } from "./checks/health";
import { dataCrudCheck } from "./checks/data-crud";
import { togglesCheck } from "./checks/toggles";
import { tokensCheck } from "./checks/tokens";
import { secretsCheck } from "./checks/secrets";
import { documentsCheck } from "./checks/documents";
import { webhooksCheck } from "./checks/webhooks";
import { schedulesCheck } from "./checks/schedules";

/**
 * A registered check: name + function that produces a CheckResult.
 */
interface RegisteredCheck {
  name: string;
  fn: (http: HttpClient) => Promise<CheckResult>;
}

/**
 * The global check registry. Order matters -- checks run sequentially.
 */
const registry: RegisteredCheck[] = [
  { name: "health", fn: healthCheck },
  { name: "data-crud", fn: dataCrudCheck },
  { name: "toggles", fn: togglesCheck },
  { name: "tokens", fn: tokensCheck },
  { name: "secrets", fn: secretsCheck },
  { name: "documents", fn: documentsCheck },
  { name: "webhooks", fn: webhooksCheck },
  { name: "schedules", fn: schedulesCheck },
];

/**
 * Run all registered checks sequentially and produce a CanaryReport.
 */
export async function runAllChecks(): Promise<CanaryReport> {
  const http = createHttpClient();
  const reportStart = performance.now();
  const checks: CheckResult[] = [];

  for (const entry of registry) {
    let result: CheckResult;
    try {
      result = await entry.fn(http);
    } catch (err: unknown) {
      // If a check throws completely unexpectedly, wrap it
      result = {
        name: entry.name,
        status: "fail",
        durationMs: 0,
        steps: [],
        error: `Unhandled: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    checks.push(result);
  }

  const totalDurationMs = Math.round(performance.now() - reportStart);

  let pass = 0;
  let fail = 0;
  let skip = 0;
  for (const check of checks) {
    if (check.status === "pass") pass++;
    else if (check.status === "fail") fail++;
    else skip++;
  }

  return {
    timestamp: new Date().toISOString(),
    totalDurationMs,
    summary: { pass, fail, skip, total: checks.length },
    checks,
  };
}

/**
 * Run a single check by name.
 * Returns null if the check name is not found.
 */
export async function runCheck(name: string): Promise<CheckResult | null> {
  let target: RegisteredCheck | null = null;
  for (const entry of registry) {
    if (entry.name === name) {
      target = entry;
      break;
    }
  }

  if (!target) {
    return null;
  }

  const http = createHttpClient();

  try {
    return await target.fn(http);
  } catch (err: unknown) {
    return {
      name: target.name,
      status: "fail",
      durationMs: 0,
      steps: [],
      error: `Unhandled: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Get list of all registered check names.
 */
export function getCheckNames(): string[] {
  const names: string[] = [];
  for (const entry of registry) {
    names.push(entry.name);
  }
  return names;
}
