/**
 * Secrets Lifecycle Check -- creates a secret, reads it (decrypted),
 * lists secrets, deletes by name, and verifies deletion.
 */
import type { HttpClient } from "../http";
import type { CheckResult, StepResult } from "../types";

const SECRET_NAME = "canary-secret";
const SECRETS_PATH = "/v1/management/secrets";

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

export async function secretsCheck(http: HttpClient): Promise<CheckResult> {
  const steps: StepResult[] = [];
  const checkStart = performance.now();
  let secretCreated = false;

  try {
    // Pre-cleanup: delete secret if it exists from a previous failed run
    const preClean = await http.delete(`${SECRETS_PATH}/${SECRET_NAME}`, "admin-key");
    if (preClean.status === 200 || preClean.status === 204) {
      steps.push({
        name: "pre-cleanup: DELETE canary-secret (existed from previous run)",
        status: "pass",
        durationMs: preClean.durationMs,
        detail: "Stale secret cleaned up",
      });
    }

    // Step 1: Create secret
    const createResp = await http.post(
      SECRETS_PATH,
      {
        name: SECRET_NAME,
        value: "canary-secret-value-12345",
        description: "Canary test secret",
      },
      "admin-key",
    );
    steps.push(
      stepFromResponse("POST /v1/management/secrets (create secret)", createResp, 201, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        if (!obj.id) return "Response missing 'id' field";
        if (obj.name !== SECRET_NAME) return `name mismatch: expected "${SECRET_NAME}", got "${obj.name}"`;
        return null;
      }),
    );
    if (createResp.status === 201) {
      secretCreated = true;
    } else {
      return buildResult(steps, checkStart, "Cannot proceed without secret");
    }

    // Step 2: Get secret (decrypted) by name
    const getResp = await http.get(`${SECRETS_PATH}/${SECRET_NAME}`, "admin-key");
    steps.push(
      stepFromResponse(`GET /v1/management/secrets/${SECRET_NAME} (get decrypted)`, getResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        if (obj.name !== SECRET_NAME) return `name mismatch: expected "${SECRET_NAME}", got "${obj.name}"`;
        if (obj.value !== "canary-secret-value-12345") {
          return `value mismatch: expected "canary-secret-value-12345", got "${obj.value}"`;
        }
        return null;
      }),
    );

    // Step 3: List secrets -- verify our secret appears
    const listResp = await http.get(SECRETS_PATH, "admin-key");
    steps.push(
      stepFromResponse("GET /v1/management/secrets (list secrets)", listResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        const arr = obj.data;
        if (!Array.isArray(arr)) return "Response missing 'data' array";

        let found = false;
        for (const item of arr) {
          const s = item as Record<string, unknown>;
          if (s.name === SECRET_NAME) {
            found = true;
            break;
          }
        }

        return found ? null : `Secret "${SECRET_NAME}" not found in list`;
      }),
    );

    // Step 4: Delete secret by name
    const deleteResp = await http.delete(`${SECRETS_PATH}/${SECRET_NAME}`, "admin-key");
    steps.push(
      stepFromResponse(`DELETE /v1/management/secrets/${SECRET_NAME} (delete)`, deleteResp, 204),
    );
    if (deleteResp.status === 204) {
      secretCreated = false; // Already cleaned up
    }

    // Step 5: Verify deletion -- get should 404
    const verifyResp = await http.get(`${SECRETS_PATH}/${SECRET_NAME}`, "admin-key");
    steps.push(
      stepFromResponse(`GET /v1/management/secrets/${SECRET_NAME} (verify gone)`, verifyResp, 404),
    );
  } catch (err: unknown) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // Cleanup: delete secret if still exists
    if (secretCreated) {
      try {
        const cleanupResp = await http.delete(`${SECRETS_PATH}/${SECRET_NAME}`, "admin-key");
        steps.push(
          stepFromResponse(`DELETE /v1/management/secrets/${SECRET_NAME} (cleanup)`, cleanupResp, [204, 404]),
        );
      } catch (cleanupErr: unknown) {
        steps.push({
          name: "cleanup: delete secret",
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
    name: "secrets",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg,
  };
}
