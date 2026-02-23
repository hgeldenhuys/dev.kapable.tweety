/**
 * Health Check -- verifies the Kapable API /health endpoint responds correctly.
 * No auth required.
 */
import type { HttpClient } from "../http";
import type { CheckResult, StepResult } from "../types";

interface HealthResponse {
  status: string;
  db?: string;
  [key: string]: unknown;
}

export async function healthCheck(http: HttpClient): Promise<CheckResult> {
  const steps: StepResult[] = [];
  const checkStart = performance.now();

  // Step 1: GET /health
  const resp = await http.get<HealthResponse>("/health", "none");
  const step: StepResult = {
    name: "GET /health",
    status: "pass",
    durationMs: resp.durationMs,
  };

  if (resp.error) {
    step.status = "fail";
    step.error = resp.error;
  } else if (resp.status !== 200) {
    step.status = "fail";
    step.error = `Expected status 200, got ${resp.status}`;
    step.detail = resp.rawText.slice(0, 200);
  } else if (!resp.data) {
    step.status = "fail";
    step.error = "Response was not valid JSON";
    step.detail = resp.rawText.slice(0, 200);
  } else {
    // Verify expected fields
    const errors: string[] = [];

    if (resp.data.status !== "ok") {
      errors.push(`status="${resp.data.status}" (expected "ok")`);
    }
    if (resp.data.db !== undefined && resp.data.db !== "connected") {
      errors.push(`db="${resp.data.db}" (expected "connected")`);
    }

    if (errors.length > 0) {
      step.status = "fail";
      step.error = errors.join("; ");
    } else {
      step.detail = `status=${resp.data.status}, db=${resp.data.db ?? "not reported"}`;
    }
  }

  steps.push(step);

  const totalDuration = Math.round(performance.now() - checkStart);
  const hasFail = steps.some((s) => s.status === "fail");

  return {
    name: "health",
    status: hasFail ? "fail" : "pass",
    durationMs: totalDuration,
    steps,
  };
}
