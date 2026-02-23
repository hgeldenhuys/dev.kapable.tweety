/**
 * Usage Check -- queries the org usage endpoint and verifies the response
 * contains expected fields with valid values.
 */
import type { HttpClient } from "../http";
import type { CheckResult, StepResult } from "../types";

function stepFromResponse(
  name: string,
  resp: { status: number; durationMs: number; error?: string; rawText: string; data: unknown },
  expectedStatus: number | number[],
  validate?: (data: unknown) => string | null,
): StepResult {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const step: StepResult = {
    name,
    status: "pass",
    durationMs: resp.durationMs,
  };

  if (resp.error) {
    step.status = "fail";
    step.error = resp.error;
    return step;
  }

  if (!expected.includes(resp.status)) {
    step.status = "fail";
    step.error = `Expected status ${expected.join("|")}, got ${resp.status}`;
    step.detail = resp.rawText.slice(0, 300);
    return step;
  }

  if (validate) {
    const validationError = validate(resp.data);
    if (validationError) {
      step.status = "fail";
      step.error = validationError;
    }
  }

  return step;
}

export async function usageCheck(http: HttpClient): Promise<CheckResult> {
  const steps: StepResult[] = [];
  const checkStart = performance.now();

  const orgId = process.env.KAPABLE_ORG_ID ?? "";

  // If KAPABLE_ORG_ID is not set, skip the check entirely
  if (!orgId) {
    return {
      name: "usage",
      status: "skip",
      durationMs: Math.round(performance.now() - checkStart),
      steps: [
        {
          name: "Check KAPABLE_ORG_ID env var",
          status: "skip",
          durationMs: 0,
          detail: "KAPABLE_ORG_ID is not set -- skipping usage check",
        },
      ],
    };
  }

  try {
    // Step 1: Get org usage
    const usagePath = `/v1/management/orgs/${orgId}/usage`;
    const usageResp = await http.get(usagePath, "admin-key");
    steps.push(
      stepFromResponse(`GET /v1/management/orgs/{org_id}/usage (get usage)`, usageResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;

        // Verify org_id matches
        if (obj.org_id !== orgId) {
          return `org_id mismatch: expected "${orgId}", got "${obj.org_id}"`;
        }

        return null;
      }),
    );

    // Step 2: Verify period dates are ISO strings
    const usageData = usageResp.data as Record<string, unknown> | null;
    if (usageData && usageResp.status === 200) {
      const dateStep: StepResult = {
        name: "Verify period_start and period_end are ISO dates",
        status: "pass",
        durationMs: 0,
      };

      const periodStart = usageData.period_start;
      const periodEnd = usageData.period_end;

      if (typeof periodStart !== "string" || !periodStart) {
        dateStep.status = "fail";
        dateStep.error = `period_start is not a string: got ${typeof periodStart}`;
      } else if (Number.isNaN(Date.parse(periodStart))) {
        dateStep.status = "fail";
        dateStep.error = `period_start is not a valid ISO date: "${periodStart}"`;
      } else if (typeof periodEnd !== "string" || !periodEnd) {
        dateStep.status = "fail";
        dateStep.error = `period_end is not a string: got ${typeof periodEnd}`;
      } else if (Number.isNaN(Date.parse(periodEnd))) {
        dateStep.status = "fail";
        dateStep.error = `period_end is not a valid ISO date: "${periodEnd}"`;
      } else {
        dateStep.detail = `period: ${periodStart} to ${periodEnd}`;
      }

      steps.push(dateStep);

      // Step 3: Verify projects_count >= 1
      const countStep: StepResult = {
        name: "Verify projects_count >= 1",
        status: "pass",
        durationMs: 0,
      };

      const projectsCount = usageData.projects_count;
      if (typeof projectsCount !== "number") {
        countStep.status = "fail";
        countStep.error = `projects_count is not a number: got ${typeof projectsCount} (${projectsCount})`;
      } else if (projectsCount < 1) {
        countStep.status = "fail";
        countStep.error = `projects_count expected >= 1, got ${projectsCount}`;
      } else {
        countStep.detail = `projects_count=${projectsCount}, api_calls=${usageData.api_calls ?? "N/A"}, rows_stored=${usageData.rows_stored ?? "N/A"}`;
      }

      steps.push(countStep);
    }
  } catch (err: unknown) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return buildResult(steps, checkStart);
}

function buildResult(steps: StepResult[], checkStart: number, errorMsg?: string): CheckResult {
  const totalDuration = Math.round(performance.now() - checkStart);
  let hasFail = false;
  let hasSkip = false;
  let hasPass = false;

  for (const step of steps) {
    if (step.status === "fail") hasFail = true;
    else if (step.status === "skip") hasSkip = true;
    else hasPass = true;
  }

  const status = hasFail ? "fail" : !hasPass && hasSkip ? "skip" : hasSkip ? "warn" : "pass";

  return {
    name: "usage",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg,
  };
}
