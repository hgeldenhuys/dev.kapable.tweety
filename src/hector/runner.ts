/**
 * Hector Runner -- registry of AI Flows checks, sequential execution, and report generation.
 * Follows the same pattern as canary/runner.ts.
 */
import type { CanaryReport, CheckResult } from "../canary/types";
import { type HttpClient, createHttpClient } from "../canary/http";
import { flowCrudCheck } from "./checks/flow-crud";
import { flowExecutionCheck } from "./checks/flow-execution";
import { flowGateCheck } from "./checks/flow-gate";
import { flowScoringCheck } from "./checks/flow-scoring";

/**
 * A registered check: name + function that produces a CheckResult.
 */
interface RegisteredCheck {
  name: string;
  fn: (http: HttpClient) => Promise<CheckResult>;
}

/**
 * The global check registry. Order matters -- checks run sequentially.
 * CRUD first (smoke test), then execution, gate routing, and scoring.
 */
const registry: RegisteredCheck[] = [
  { name: "flow-crud", fn: flowCrudCheck },
  { name: "flow-execution", fn: flowExecutionCheck },
  { name: "flow-gate", fn: flowGateCheck },
  { name: "flow-scoring", fn: flowScoringCheck },
];

/**
 * Run all registered checks sequentially and produce a CanaryReport.
 */
export async function runAllHectorChecks(): Promise<CanaryReport> {
  const http = createHttpClient();
  const reportStart = performance.now();
  const checks: CheckResult[] = [];

  for (const entry of registry) {
    let result: CheckResult;
    try {
      result = await entry.fn(http);
    } catch (err: unknown) {
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
  let warn = 0;
  let skip = 0;
  for (const check of checks) {
    if (check.status === "pass") pass++;
    else if (check.status === "fail") fail++;
    else if (check.status === "warn") warn++;
    else skip++;
  }

  return {
    timestamp: new Date().toISOString(),
    totalDurationMs,
    summary: { pass, fail, warn, skip, total: checks.length },
    checks,
  };
}

/**
 * Run a single check by name.
 * Returns null if the check name is not found.
 */
export async function runHectorCheck(name: string): Promise<CheckResult | null> {
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
export function getHectorCheckNames(): string[] {
  const names: string[] = [];
  for (const entry of registry) {
    names.push(entry.name);
  }
  return names;
}
