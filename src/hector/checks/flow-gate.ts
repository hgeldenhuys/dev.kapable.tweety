/**
 * Flow Gate Routing Check -- creates a flow with a programmatic gate,
 * tests pass and fail paths to verify routing works correctly.
 *
 * Test 1: Source("hello world") -> Gate(contains "hello") -> Output-Pass (should execute)
 * Test 2: Source("goodbye") -> Gate(contains "hello") -> Output-Fail (should execute)
 *
 * Verifies that gate routing correctly sends data down pass/fail edges
 * and that skipped nodes get status="skipped".
 */
import type { HttpClient } from "../../canary/http";
import type { CheckResult, StepResult } from "../../canary/types";

const FLOW_NAME_PASS = "hector-gate-pass-test";
const FLOW_NAME_FAIL = "hector-gate-fail-test";
const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_MS = 30_000;

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

/**
 * Create a gate test flow with source content and two output branches.
 */
async function createGateFlow(
  http: HttpClient,
  name: string,
  sourceContent: string,
): Promise<{ flowId: string | null; steps: StepResult[] }> {
  const steps: StepResult[] = [];
  let flowId: string | null = null;

  const createResp = await http.post("/v1/flows", {
    name,
    description: `Hector gate test -- source: "${sourceContent}"`,
    budget_cap_usd: "0.10",
  }, "admin-key");
  steps.push(
    stepFromResponse(`POST /v1/flows (create ${name})`, createResp, 201, (data) => {
      if (!data || typeof data !== "object") return "Response is not an object";
      const obj = data as Record<string, unknown>;
      const inner = (obj.data ?? obj) as Record<string, unknown>;
      if (!inner.id) return "Response missing 'id' field";
      flowId = String(inner.id);
      return null;
    }),
  );

  if (!flowId) return { flowId: null, steps };

  // Canvas: Source -> Gate -> Output-Pass (via "pass" handle)
  //                       -> Output-Fail (via "fail" handle)
  const canvasResp = await http.put(`/v1/flows/${flowId}/canvas`, {
    nodes: [
      {
        node_key: "source_1",
        node_type: "source",
        label: "Gate Input",
        config: { content: sourceContent },
        position_x: 100,
        position_y: 200,
      },
      {
        node_key: "gate_1",
        node_type: "gate",
        label: "Contains Hello Gate",
        config: {
          mode: "programmatic",
          check_type: "contains",
          check_value: "hello",
        },
        position_x: 400,
        position_y: 200,
      },
      {
        node_key: "output_pass",
        node_type: "output",
        label: "Pass Output",
        config: { format: "text" },
        position_x: 700,
        position_y: 100,
      },
      {
        node_key: "output_fail",
        node_type: "output",
        label: "Fail Output",
        config: { format: "text" },
        position_x: 700,
        position_y: 300,
      },
    ],
    edges: [
      { source_node_key: "source_1", target_node_key: "gate_1" },
      { source_node_key: "gate_1", target_node_key: "output_pass", source_handle: "pass" },
      { source_node_key: "gate_1", target_node_key: "output_fail", source_handle: "fail" },
    ],
  }, "admin-key");
  steps.push(
    stepFromResponse(`PUT /v1/flows/${flowId}/canvas (gate pipeline)`, canvasResp, 200),
  );

  return { flowId, steps };
}

/**
 * Run a flow and poll until complete, returning node results.
 */
async function runAndPoll(
  http: HttpClient,
  flowId: string,
  steps: StepResult[],
  label: string,
): Promise<Record<string, Record<string, unknown>> | null> {
  const runResp = await http.post(`/v1/flows/${flowId}/run`, {}, "admin-key");
  let runId: string | null = null;
  steps.push(
    stepFromResponse(`POST /v1/flows/${flowId}/run (${label})`, runResp, [200, 201, 202], (data) => {
      if (!data || typeof data !== "object") return "Response is not an object";
      const obj = data as Record<string, unknown>;
      const inner = (obj.data ?? obj) as Record<string, unknown>;
      if (!inner.id) return "Missing run id";
      runId = String(inner.id);
      return null;
    }),
  );

  if (!runId) return null;

  // Poll
  const pollStart = performance.now();
  let finalStatus = "queued";
  let lastData: Record<string, unknown> | null = null;

  while (performance.now() - pollStart < MAX_POLL_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const pollResp = await http.get(`/v1/flows/${flowId}/runs/${runId}`, "admin-key");
    if (pollResp.error || pollResp.status !== 200) break;
    const pollObj = pollResp.data as Record<string, unknown>;
    const runData = (pollObj?.data ?? pollObj) as Record<string, unknown>;
    finalStatus = String(runData?.status ?? "unknown");
    lastData = pollObj;
    if (finalStatus !== "queued" && finalStatus !== "running") break;
  }

  steps.push({
    name: `Poll ${label} completion`,
    status: finalStatus === "completed" ? "pass" : "fail",
    durationMs: Math.round(performance.now() - pollStart),
    detail: `status: ${finalStatus}`,
    error: finalStatus !== "completed" ? `Expected 'completed', got '${finalStatus}'` : undefined,
  });

  if (!lastData || finalStatus !== "completed") return null;

  const runData = (lastData.data ?? lastData) as Record<string, unknown>;
  const nodeResults = (lastData.node_results ?? runData.node_results) as Array<Record<string, unknown>> | undefined;
  if (!nodeResults) return null;

  const resultsByKey: Record<string, Record<string, unknown>> = {};
  for (const nr of nodeResults) {
    resultsByKey[String(nr.node_key)] = nr;
  }
  return resultsByKey;
}

export async function flowGateCheck(http: HttpClient): Promise<CheckResult> {
  const steps: StepResult[] = [];
  const checkStart = performance.now();
  const flowIds: string[] = [];

  try {
    // Pre-cleanup
    const preList = await http.get<{ data: Array<{ id: string; name: string }> }>("/v1/flows", "admin-key");
    if (preList.data && typeof preList.data === "object") {
      const listObj = preList.data as Record<string, unknown>;
      const items = Array.isArray(listObj.data) ? listObj.data as Array<Record<string, unknown>> : [];
      for (const item of items) {
        if ((item.name === FLOW_NAME_PASS || item.name === FLOW_NAME_FAIL) && item.id) {
          await http.delete(`/v1/flows/${item.id}`, "admin-key");
        }
      }
    }

    // ── Test 1: Gate PASS path ("hello world" contains "hello") ──
    const passResult = await createGateFlow(http, FLOW_NAME_PASS, "hello world");
    steps.push(...passResult.steps);
    if (!passResult.flowId) {
      return buildResult(steps, checkStart, "Cannot create pass-path flow");
    }
    flowIds.push(passResult.flowId);

    const passNodes = await runAndPoll(http, passResult.flowId, steps, "gate-pass");
    if (passNodes) {
      // Gate should have passed -- engine returns "pass"/"fail" strings or true/false booleans
      const gateResult = passNodes["gate_1"];
      const grVal = String(gateResult?.gate_result);
      const gatePassed = grVal === "true" || grVal === "pass";
      steps.push({
        name: "Verify gate_1 passed",
        status: gatePassed ? "pass" : "fail",
        durationMs: 0,
        detail: `gate_result=${gateResult?.gate_result}, passed=${gateResult?.passed}`,
        error: !gatePassed
          ? `Expected gate_result=true/pass, got ${gateResult?.gate_result}` : undefined,
      });

      // output_pass should be "done", output_fail should be "skipped"
      const outputPass = passNodes["output_pass"];
      steps.push({
        name: "Verify output_pass executed (status=done)",
        status: outputPass?.status === "done" ? "pass" : "fail",
        durationMs: 0,
        detail: `status=${outputPass?.status}`,
        error: outputPass?.status !== "done" ? `Expected 'done', got '${outputPass?.status}'` : undefined,
      });

      const outputFail = passNodes["output_fail"];
      steps.push({
        name: "Verify output_fail skipped (status=skipped)",
        status: outputFail?.status === "skipped" ? "pass" : "warn",
        durationMs: 0,
        detail: `status=${outputFail?.status}`,
        error: outputFail?.status !== "skipped" ? `Expected 'skipped', got '${outputFail?.status}'` : undefined,
      });
    }

    // ── Test 2: Gate FAIL path ("goodbye" does NOT contain "hello") ──
    const failResult = await createGateFlow(http, FLOW_NAME_FAIL, "goodbye");
    steps.push(...failResult.steps);
    if (!failResult.flowId) {
      return buildResult(steps, checkStart, "Cannot create fail-path flow");
    }
    flowIds.push(failResult.flowId);

    const failNodes = await runAndPoll(http, failResult.flowId, steps, "gate-fail");
    if (failNodes) {
      // Gate should have failed -- engine returns "pass"/"fail" strings or true/false booleans
      const gateResult = failNodes["gate_1"];
      const grVal = String(gateResult?.gate_result);
      const gateFailed = grVal === "false" || grVal === "fail";
      steps.push({
        name: "Verify gate_1 failed",
        status: gateFailed ? "pass" : "fail",
        durationMs: 0,
        detail: `gate_result=${gateResult?.gate_result}, passed=${gateResult?.passed}`,
        error: !gateFailed
          ? `Expected gate_result=false/fail, got ${gateResult?.gate_result}` : undefined,
      });

      // output_fail should be "done", output_pass should be "skipped"
      const outputFail = failNodes["output_fail"];
      steps.push({
        name: "Verify output_fail executed (status=done)",
        status: outputFail?.status === "done" ? "pass" : "fail",
        durationMs: 0,
        detail: `status=${outputFail?.status}`,
        error: outputFail?.status !== "done" ? `Expected 'done', got '${outputFail?.status}'` : undefined,
      });

      const outputPass = failNodes["output_pass"];
      steps.push({
        name: "Verify output_pass skipped (status=skipped)",
        status: outputPass?.status === "skipped" ? "pass" : "warn",
        durationMs: 0,
        detail: `status=${outputPass?.status}`,
        error: outputPass?.status !== "skipped" ? `Expected 'skipped', got '${outputPass?.status}'` : undefined,
      });
    }
  } catch (err: unknown) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // Cleanup all flows
    for (const fid of flowIds) {
      try {
        await http.delete(`/v1/flows/${fid}`, "admin-key");
      } catch { /* best effort */ }
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
    name: "flow-gate",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg,
  };
}
