/**
 * Feature Toggles Lifecycle Check -- creates a feature flag, evaluates it,
 * toggles it, re-evaluates, and cleans up.
 */
import type { HttpClient } from "../http";
import type { CheckResult, StepResult } from "../types";

const FLAG_NAME = "canary-flag";
const TOGGLES_PATH = "/v1/feature-toggles";

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

export async function togglesCheck(http: HttpClient): Promise<CheckResult> {
  const steps: StepResult[] = [];
  const checkStart = performance.now();
  let flagCreated = false;

  try {
    // Pre-cleanup: delete flag if it exists from a previous failed run
    const preClean = await http.delete(`${TOGGLES_PATH}/${FLAG_NAME}`, "api-key");
    if (preClean.status === 200 || preClean.status === 204) {
      steps.push({
        name: "pre-cleanup: DELETE canary-flag (existed from previous run)",
        status: "pass",
        durationMs: preClean.durationMs,
        detail: "Stale flag cleaned up",
      });
    }

    // Step 1: Create feature toggle
    const createResp = await http.post(
      TOGGLES_PATH,
      {
        name: FLAG_NAME,
        description: "Canary test toggle",
        enabled: true,
      },
      "api-key",
    );
    steps.push(
      stepFromResponse("POST /v1/feature-toggles (create flag)", createResp, [200, 201]),
    );
    if (createResp.status === 200 || createResp.status === 201) {
      flagCreated = true;
    } else {
      return buildResult(steps, checkStart, "Cannot proceed without flag");
    }

    // Step 2: Get flag by name
    const getResp = await http.get(`${TOGGLES_PATH}/${FLAG_NAME}`, "api-key");
    steps.push(
      stepFromResponse(`GET /v1/feature-toggles/${FLAG_NAME} (verify created)`, getResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        if (obj.name !== FLAG_NAME) return `name mismatch: expected "${FLAG_NAME}", got "${obj.name}"`;
        return null;
      }),
    );

    // Step 3: Evaluate flag (expect enabled=true)
    const eval1Resp = await http.post(
      `${TOGGLES_PATH}/evaluate`,
      { flag_name: FLAG_NAME },
      "api-key",
    );
    steps.push(
      stepFromResponse("POST /v1/feature-toggles/evaluate (expect enabled)", eval1Resp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        if (obj.enabled !== true) return `enabled expected true, got ${obj.enabled}`;
        return null;
      }),
    );

    // Step 4: Disable flag
    const updateResp = await http.put(
      `${TOGGLES_PATH}/${FLAG_NAME}`,
      { enabled: false },
      "api-key",
    );
    steps.push(
      stepFromResponse(`PUT /v1/feature-toggles/${FLAG_NAME} (disable)`, updateResp, 200),
    );

    // Step 5: Evaluate again (expect enabled=false)
    const eval2Resp = await http.post(
      `${TOGGLES_PATH}/evaluate`,
      { flag_name: FLAG_NAME },
      "api-key",
    );
    steps.push(
      stepFromResponse("POST /v1/feature-toggles/evaluate (expect disabled)", eval2Resp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        if (obj.enabled !== false) return `enabled expected false, got ${obj.enabled}`;
        return null;
      }),
    );
  } catch (err: unknown) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // Always clean up: delete flag
    if (flagCreated) {
      try {
        const deleteResp = await http.delete(`${TOGGLES_PATH}/${FLAG_NAME}`, "api-key");
        steps.push(
          stepFromResponse(`DELETE /v1/feature-toggles/${FLAG_NAME} (cleanup)`, deleteResp, [200, 204, 404]),
        );
      } catch (cleanupErr: unknown) {
        steps.push({
          name: "cleanup: delete flag",
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
    name: "toggles",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg,
  };
}
