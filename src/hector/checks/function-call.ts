/**
 * Function Call Check -- creates a function with Data ABI usage,
 * calls it via the synchronous /call endpoint, verifies output
 * and mutation results, then cleans up.
 *
 * Tests: function create → compile → /call → Data ABI mutations → cleanup
 *
 * Requires KAPABLE_APP_ID and KAPABLE_ENV_NAME env vars.
 */
import type { HttpClient } from "../../canary/http";
import type { CheckResult, StepResult } from "../../canary/types";

const FUNCTION_NAME = "hector-call-test";
const FUNCTION_SOURCE = `function handle(input) {
  var msg = (input && input.msg) || "hector-ok";
  kapable.db.insert("canary_tasks", { title: msg, created_at: new Date().toISOString() });
  return { ok: true, echo: msg };
}`;

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
    name: "function-call",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg,
  };
}

export async function functionCallCheck(http: HttpClient): Promise<CheckResult> {
  const appId = process.env.KAPABLE_APP_ID ?? "";
  const envName = process.env.KAPABLE_ENV_NAME ?? "production";

  if (!appId) {
    return {
      name: "function-call",
      status: "skip",
      durationMs: 0,
      steps: [{
        name: "KAPABLE_APP_ID not set",
        status: "skip",
        durationMs: 0,
        detail: "Function call check requires KAPABLE_APP_ID env var",
      }],
    };
  }

  const functionsPath = `/v1/apps/${appId}/environments/${envName}/functions`;
  const steps: StepResult[] = [];
  const checkStart = performance.now();
  let functionId: string | null = null;

  try {
    // Pre-cleanup: delete any stale test functions from previous runs
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
              name: `pre-cleanup: DELETE ${FUNCTION_NAME} (stale)`,
              status: "pass",
              durationMs: delResp.durationMs,
              detail: "Stale function cleaned up",
            });
          }
        }
      }
    }

    // Step 1: Create function with Data ABI usage (compile timeout 30s)
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
      stepFromResponse("POST .../functions (create with Data ABI)", createResp, 201, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        const inner = (obj.data ?? obj) as Record<string, unknown>;
        if (!inner || typeof inner !== "object") return "Response missing 'data' wrapper";
        if (!inner.id) return "Response missing 'id' field";
        if (inner.name !== FUNCTION_NAME) {
          return `name mismatch: expected "${FUNCTION_NAME}", got "${inner.name}"`;
        }
        functionId = String(inner.id);
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
        lastStep.detail = `version=${createData.version}, compiled=${compiled}`;
      }
    }

    // Step 2: Call function via /call endpoint (synchronous)
    const callResp = await http.request(
      "POST",
      `${functionsPath}/${functionId}/call`,
      {
        body: { input: { msg: "hector-canary" } },
        auth: "admin-key",
        timeoutMs: 15_000,
      },
    );
    steps.push(
      stepFromResponse("POST .../functions/{id}/call (sync invoke)", callResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const resp = data as Record<string, unknown>;

        // Verify output
        if (!resp.output || typeof resp.output !== "object") return "Missing or invalid output";
        const output = resp.output as Record<string, unknown>;
        if (output.ok !== true) return `output.ok expected true, got ${output.ok}`;
        if (output.echo !== "hector-canary") {
          return `output.echo expected "hector-canary", got "${output.echo}"`;
        }

        // Verify fuel and duration
        if (typeof resp.fuel_consumed !== "number" || resp.fuel_consumed <= 0) {
          return `fuel_consumed should be > 0, got ${resp.fuel_consumed}`;
        }
        if (typeof resp.duration_ms !== "number" || resp.duration_ms < 0) {
          return `duration_ms should be >= 0, got ${resp.duration_ms}`;
        }

        return null;
      }),
    );

    // Step 3: Verify Data ABI mutations
    if (callResp.data && typeof callResp.data === "object") {
      const callData = callResp.data as Record<string, unknown>;
      const mutations = callData.mutations_applied as Record<string, unknown> | undefined;
      if (mutations) {
        steps.push({
          name: "verify mutations_applied",
          status: typeof mutations.inserts === "number" && mutations.inserts >= 1 ? "pass" : "fail",
          durationMs: 0,
          detail: `inserts=${mutations.inserts}, updates=${mutations.updates}, deletes=${mutations.deletes}`,
          error: typeof mutations.inserts !== "number" || mutations.inserts < 1
            ? `Expected at least 1 insert, got ${mutations.inserts}`
            : undefined,
        });
      } else {
        steps.push({
          name: "verify mutations_applied",
          status: "fail",
          durationMs: 0,
          error: "No mutations_applied in response -- Data ABI bridge may not be working",
        });
      }
    }

    // Step 4: Delete the function
    const deleteResp = await http.delete(`${functionsPath}/${functionId}`, "admin-key");
    steps.push(
      stepFromResponse(`DELETE .../functions/${functionId} (cleanup)`, deleteResp, 204),
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
