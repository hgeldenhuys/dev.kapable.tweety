/**
 * Serverless Functions Lifecycle Check -- creates a function, verifies compilation,
 * invokes it, polls for execution result, and deletes it.
 *
 * Lifecycle: pre-cleanup -> create (auto-compiles WASM) -> list (verify present)
 * -> invoke -> poll invocations (verify success + output) -> delete -> verify gone.
 *
 * Requires KAPABLE_APP_ID and KAPABLE_ENV_NAME env vars.
 */
import type { HttpClient } from "../http";
import type { CheckResult, StepResult } from "../types";

const FUNCTION_NAME = "canary-function";
const FUNCTION_SOURCE = 'export function handle(input) { return { ok: true, echo: input.msg || "CANARY_OK" }; }';

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

    // Step 1: Create function (auto-compiles to WASM — can take 15-30s in container)
    const createResp = await http.request(
      "POST",
      functionsPath,
      {
        body: {
          name: FUNCTION_NAME,
          source_code: FUNCTION_SOURCE,
          runtime: "javascript",
          handler_name: "handle",
          status: "active",
        },
        auth: "admin-key",
        timeoutMs: 30_000,
      },
    );
    steps.push(
      stepFromResponse("POST .../functions (create + compile)", createResp, 201, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        const inner = obj.data ?? obj;
        if (!inner || typeof inner !== "object") return "Response missing 'data' wrapper";
        const fn = inner as Record<string, unknown>;
        if (!fn.id) return "Response missing 'id' field";
        if (fn.name !== FUNCTION_NAME) {
          return `name mismatch: expected "${FUNCTION_NAME}", got "${fn.name}"`;
        }
        if (!fn.compiled_at) return "Function was not compiled (compiled_at is null)";
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
        lastStep.detail = `version=${createData.version}, runtime=${createData.runtime}, fuel_limit=${createData.fuel_limit}`;
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

    // Step 3: Invoke the function
    const invokeResp = await http.post(
      `${functionsPath}/${functionId}/invoke`,
      { input: { msg: "CANARY_OK" } },
      "admin-key",
    );

    let invocationId: string | null = null;
    steps.push(
      stepFromResponse("POST .../invoke (trigger execution)", invokeResp, 201, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        const inner = obj.data ?? obj;
        if (!inner || typeof inner !== "object") return "Response missing 'data' wrapper";
        const inv = inner as Record<string, unknown>;
        if (!inv.id) return "Response missing invocation 'id'";
        if (inv.status !== "queued" && inv.status !== "running" && inv.status !== "success") {
          return `Unexpected invocation status: ${inv.status}`;
        }
        invocationId = String(inv.id);
        return null;
      }),
    );

    // Step 4: Poll invocations for result (up to 10 attempts, 1s apart)
    if (invocationId) {
      let pollResult: StepResult | null = null;
      const pollStart = performance.now();

      for (let attempt = 1; attempt <= 10; attempt++) {
        // Wait 1 second between polls
        await new Promise((resolve) => setTimeout(resolve, 1000));

        const pollResp = await http.get(
          `${functionsPath}/${functionId}/invocations?limit=1`,
          "admin-key",
        );

        if (pollResp.error || pollResp.status !== 200) continue;

        const pollData = pollResp.data as Record<string, unknown>;
        const invocations = Array.isArray(pollData?.data) ? pollData.data : [];
        if (invocations.length === 0) continue;

        const inv = invocations[0] as Record<string, unknown>;
        const invStatus = String(inv.status);

        if (invStatus === "success") {
          const output = inv.output_payload as Record<string, unknown> | null;
          const pollDuration = Math.round(performance.now() - pollStart);
          pollResult = {
            name: `GET .../invocations (poll attempt ${attempt})`,
            status: "pass",
            durationMs: pollDuration,
            detail: `status=success, fuel=${inv.fuel_consumed}, output=${JSON.stringify(output).slice(0, 100)}`,
          };

          // Validate output
          if (!output || output.ok !== true) {
            pollResult.status = "fail";
            pollResult.error = `Expected output.ok=true, got ${JSON.stringify(output)}`;
          } else if (output.echo !== "CANARY_OK") {
            pollResult.status = "fail";
            pollResult.error = `Expected output.echo="CANARY_OK", got "${output.echo}"`;
          }
          break;
        }

        if (invStatus === "error" || invStatus === "timeout") {
          const pollDuration = Math.round(performance.now() - pollStart);
          pollResult = {
            name: `GET .../invocations (poll attempt ${attempt})`,
            status: "fail",
            durationMs: pollDuration,
            error: `Invocation ${invStatus}: ${inv.error_message || "no error message"}`,
          };
          break;
        }

        // Still queued or running — continue polling
      }

      if (!pollResult) {
        const pollDuration = Math.round(performance.now() - pollStart);
        pollResult = {
          name: "GET .../invocations (poll timeout)",
          status: "fail",
          durationMs: pollDuration,
          error: "Invocation did not complete within 10 poll attempts (10s)",
        };
      }

      steps.push(pollResult);
    }

    // Step 5: Delete function
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
