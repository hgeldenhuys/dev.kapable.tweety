/**
 * Schedules Lifecycle Check -- creates a schedule, reads it, verifies fields,
 * and deletes it. Requires KAPABLE_APP_ID and KAPABLE_ENV_NAME env vars.
 */
import type { HttpClient } from "../http";
import type { CheckResult, StepResult } from "../types";

const SCHEDULE_NAME = "canary-schedule";

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

export async function schedulesCheck(http: HttpClient): Promise<CheckResult> {
  const appId = process.env.KAPABLE_APP_ID ?? "";
  const envName = process.env.KAPABLE_ENV_NAME ?? "production";

  // Skip if app ID is not configured
  if (!appId) {
    return {
      name: "schedules",
      status: "skip",
      durationMs: 0,
      steps: [{
        name: "KAPABLE_APP_ID not set",
        status: "skip",
        durationMs: 0,
        detail: "Schedules check requires KAPABLE_APP_ID env var",
      }],
    };
  }

  const schedulesPath = `/v1/apps/${appId}/environments/${envName}/schedules`;
  const steps: StepResult[] = [];
  const checkStart = performance.now();
  let scheduleId: string | null = null;

  try {
    // Pre-cleanup: list schedules and delete any canary schedules
    const preList = await http.get(schedulesPath, "admin-key");
    if (preList.data && typeof preList.data === "object") {
      const listObj = preList.data as Record<string, unknown>;
      // Response may be { data: [...] } or array directly
      const items = Array.isArray(listObj.data) ? listObj.data : (Array.isArray(preList.data) ? preList.data as unknown[] : []);
      for (const item of items) {
        const sched = item as Record<string, unknown>;
        if (sched.name === SCHEDULE_NAME && sched.id) {
          const delResp = await http.delete(`${schedulesPath}/${sched.id}`, "admin-key");
          if (delResp.status === 204 || delResp.status === 200) {
            steps.push({
              name: "pre-cleanup: DELETE canary-schedule (existed from previous run)",
              status: "pass",
              durationMs: delResp.durationMs,
              detail: "Stale schedule cleaned up",
            });
          }
        }
      }
    }

    // Step 1: Create schedule (disabled so it never fires)
    const createResp = await http.post(
      schedulesPath,
      {
        name: SCHEDULE_NAME,
        cron_expression: "0 * * * *",
        action_type: "webhook",
        action_config: { url: "https://example.com/canary-cron" },
        enabled: false,
        description: "Canary test schedule",
      },
      "admin-key",
    );
    steps.push(
      stepFromResponse("POST .../schedules (create schedule)", createResp, 201, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        // Response is wrapped in {data: {...}}
        const inner = obj.data ?? obj;
        if (!inner || typeof inner !== "object") return "Response missing 'data' wrapper";
        const schedule = inner as Record<string, unknown>;
        if (!schedule.id) return "Response missing 'id' field";
        if (schedule.name !== SCHEDULE_NAME) {
          return `name mismatch: expected "${SCHEDULE_NAME}", got "${schedule.name}"`;
        }
        scheduleId = String(schedule.id);
        return null;
      }),
    );
    if (!scheduleId) {
      return buildResult(steps, checkStart, "Cannot proceed without schedule ID");
    }

    // Step 2: Get schedule by ID -- verify fields
    const getResp = await http.get(`${schedulesPath}/${scheduleId}`, "admin-key");
    steps.push(
      stepFromResponse(`GET .../schedules/${scheduleId} (verify fields)`, getResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        // Response is wrapped in {data: {...}}
        const inner = obj.data ?? obj;
        if (!inner || typeof inner !== "object") return "Response missing 'data' wrapper";
        const schedule = inner as Record<string, unknown>;
        if (String(schedule.id) !== scheduleId) {
          return `ID mismatch: expected ${scheduleId}, got ${schedule.id}`;
        }
        if (schedule.name !== SCHEDULE_NAME) {
          return `name mismatch: expected "${SCHEDULE_NAME}", got "${schedule.name}"`;
        }
        if (schedule.cron_expression !== "0 * * * *") {
          return `cron_expression mismatch: expected "0 * * * *", got "${schedule.cron_expression}"`;
        }
        if (schedule.enabled !== false) {
          return `enabled expected false, got ${schedule.enabled}`;
        }
        if (schedule.action_type !== "http") {
          return `action_type mismatch: expected "http", got "${schedule.action_type}"`;
        }
        return null;
      }),
    );

    // Step 3: Delete schedule
    const deleteResp = await http.delete(`${schedulesPath}/${scheduleId}`, "admin-key");
    steps.push(
      stepFromResponse(`DELETE .../schedules/${scheduleId} (delete)`, deleteResp, 204),
    );
    if (deleteResp.status === 204) {
      scheduleId = null; // Already cleaned up
    }
  } catch (err: unknown) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // Cleanup: delete schedule if still exists
    if (scheduleId) {
      try {
        const cleanupResp = await http.delete(`${schedulesPath}/${scheduleId}`, "admin-key");
        steps.push(
          stepFromResponse(`DELETE .../schedules/${scheduleId} (cleanup)`, cleanupResp, [204, 404]),
        );
      } catch (cleanupErr: unknown) {
        steps.push({
          name: "cleanup: delete schedule",
          status: "fail",
          durationMs: 0,
          error: `Cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
        });
      }
    }
  }

  return buildResult(steps, checkStart);
}

function buildResult(steps: StepResult[], checkStart: number, errorMsg?: string): CheckResult {
  const totalDuration = Math.round(performance.now() - checkStart);
  let status: "pass" | "fail" | "skip" = "pass";

  for (const step of steps) {
    if (step.status === "fail") {
      status = "fail";
      break;
    }
  }

  return {
    name: "schedules",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg,
  };
}
