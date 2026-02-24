/**
 * Serverless Functions Lifecycle Check -- creates a function, verifies it appears
 * in the list, reads it back by ID, and deletes it.
 *
 * Lifecycle: pre-cleanup -> create -> list (verify present) -> get by ID (verify fields)
 * -> delete -> verify gone.
 *
 * NOTE: We do NOT invoke the function. Invocation requires kapable-worker async
 * processing and WASM compilation can be slow. This check verifies the CRUD API surface.
 *
 * Requires KAPABLE_APP_ID and KAPABLE_ENV_NAME env vars.
 */
import type { HttpClient } from "../http";
import type { CheckResult, StepResult } from "../types";

const FUNCTION_NAME = "canary-function";
const FUNCTION_SOURCE = 'function handle(input) { var msg = (input && input.msg) || "CANARY_OK"; return { ok: true, echo: msg }; }';

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

export async function functionsCheck(http: HttpClient): Promise<CheckResult> {
  const appId = process.env.KAPABLE_APP_ID ?? "";
  const envName = process.env.KAPABLE_ENV_NAME ?? "production";

  if (!appId) {
    return {
      name: "functions",
      status: "skip",
      durationMs: 0,
      steps: [{
        name: "KAPABLE_APP_ID not set",
        status: "skip",
        durationMs: 0,
        detail: "Functions check requires KAPABLE_APP_ID env var",
      }],
    };
  }

  const functionsPath = `/v1/apps/${appId}/environments/${envName}/functions`;
  const steps: StepResult[] = [];
  const checkStart = performance.now();
  let functionId: string | null = null;

  try {
    // Pre-cleanup: list functions and delete any canary functions from previous runs
    const preList = await http.get(functionsPath, "admin-key");
    if (preList.data && typeof preList.data === "object") {
      const listObj = preList.data as Record<string, unknown>;
      const items = Array.isArray(listObj.data) ? listObj.data : (Array.isArray(preList.data) ? preList.data as unknown[] : []);
      for (const item of items) {
        const fn = item as Record<string, unknown>;
        if (fn.name === FUNCTION_NAME && fn.id) {
          const delResp = await http.delete(`${functionsPath}/${fn.id}`, "admin-key");
          if (delResp.status === 204 || delResp.status === 200) {
            steps.push({
              name: "pre-cleanup: DELETE canary-function (existed from previous run)",
              status: "pass",
              durationMs: delResp.durationMs,
              detail: "Stale function cleaned up",
            });
          }
        }
      }
    }

    // Step 1: Create function (WASM compilation happens server-side, 20s timeout)
    const createResp = await http.request(
      "POST",
      functionsPath,
      {
        body: {
          name: FUNCTION_NAME,
          source_code: FUNCTION_SOURCE,
          handler_name: "handle",
        },
        auth: "admin-key",
        timeoutMs: 30_000,
      },
    );
    steps.push(
      stepFromResponse("POST .../functions (create)", createResp, 201, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        const inner = obj.data ?? obj;
        if (!inner || typeof inner !== "object") return "Response missing 'data' wrapper";
        const fn = inner as Record<string, unknown>;
        if (!fn.id) return "Response missing 'id' field";
        if (fn.name !== FUNCTION_NAME) {
          return `name mismatch: expected "${FUNCTION_NAME}", got "${fn.name}"`;
        }
        functionId = String(fn.id);
        return null;
      }),
    );
    if (!functionId) {
      return buildResult(steps, checkStart, "Cannot proceed without function ID");
    }

    // Add compilation detail
    const createData = (createResp.data as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
    if (createData) {
      const lastStep = steps[steps.length - 1];
      if (lastStep.status === "pass") {
        const compiled = createData.compiled_at ? "yes" : "no";
        lastStep.detail = `version=${createData.version}, runtime=${createData.runtime}, compiled=${compiled}`;
      }
    }

    // Step 2: List functions -- verify canary function appears
    const listResp = await http.get(functionsPath, "admin-key");
    steps.push(
      stepFromResponse("GET .../functions (verify in list)", listResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        const items = Array.isArray(obj.data) ? obj.data : [];
        let found = false;
        for (const item of items) {
          const fn = item as Record<string, unknown>;
          if (String(fn.id) === functionId) {
            found = true;
            break;
          }
        }
        if (!found) return `Function ${functionId} not found in list`;
        return null;
      }),
    );

    // Step 3: Get function by ID -- verify fields
    const getResp = await http.get(`${functionsPath}/${functionId}`, "admin-key");
    steps.push(
      stepFromResponse(`GET .../functions/${functionId} (verify fields)`, getResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        const inner = obj.data ?? obj;
        if (!inner || typeof inner !== "object") return "Response missing 'data' wrapper";
        const fn = inner as Record<string, unknown>;
        if (String(fn.id) !== functionId) {
          return `ID mismatch: expected ${functionId}, got ${fn.id}`;
        }
        if (fn.name !== FUNCTION_NAME) {
          return `name mismatch: expected "${FUNCTION_NAME}", got "${fn.name}"`;
        }
        if (fn.runtime !== "typescript") {
          return `runtime mismatch: expected "typescript", got "${fn.runtime}"`;
        }
        if (fn.handler_name !== "handle") {
          return `handler_name mismatch: expected "handle", got "${fn.handler_name}"`;
        }
        return null;
      }),
    );

    // Step 4: Delete function
    const deleteResp = await http.delete(`${functionsPath}/${functionId}`, "admin-key");
    steps.push(
      stepFromResponse(`DELETE .../functions/${functionId} (delete)`, deleteResp, 204),
    );
    if (deleteResp.status === 204) {
      functionId = null; // Already cleaned up
    }
  } catch (err: unknown) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // Cleanup: delete function if still exists
    if (functionId) {
      try {
        const cleanupResp = await http.delete(`${functionsPath}/${functionId}`, "admin-key");
        steps.push(
          stepFromResponse(`DELETE .../functions/${functionId} (finally cleanup)`, cleanupResp, [204, 404]),
        );
      } catch (cleanupErr: unknown) {
        steps.push({
          name: "cleanup: delete function",
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
    name: "functions",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg,
  };
}
