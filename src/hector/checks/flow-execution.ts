/**
 * Flow Execution Check -- creates a Source->LLM->Output flow,
 * runs it, polls for completion, and verifies results.
 *
 * This is the core Hector check: proves that the entire AI Flows
 * pipeline works end-to-end (create flow, run it, get LLM response).
 *
 * Requires OPENROUTER_API_KEY configured on the production server.
 */
import type { HttpClient } from "../../canary/http";
import type { CheckResult, StepResult } from "../../canary/types";

const FLOW_NAME = "hector-execution-test";
const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_MS = 60_000;

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

export async function flowExecutionCheck(http: HttpClient): Promise<CheckResult> {
  const steps: StepResult[] = [];
  const checkStart = performance.now();
  let flowId: string | null = null;

  try {
    // Pre-cleanup: delete any stale test flows
    const preList = await http.get<{ data: Array<{ id: string; name: string }> }>("/v1/flows", "admin-key");
    if (preList.data && typeof preList.data === "object") {
      const listObj = preList.data as Record<string, unknown>;
      const items = Array.isArray(listObj.data) ? listObj.data as Array<Record<string, unknown>> : [];
      for (const item of items) {
        if (item.name === FLOW_NAME && item.id) {
          await http.delete(`/v1/flows/${item.id}`, "admin-key");
        }
      }
    }

    // Step 1: Create flow
    const createResp = await http.post("/v1/flows", {
      name: FLOW_NAME,
      description: "Hector execution test -- Source->LLM->Output",
      budget_cap_usd: "0.50",
    }, "admin-key");
    steps.push(
      stepFromResponse("POST /v1/flows (create)", createResp, 201, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        const inner = (obj.data ?? obj) as Record<string, unknown>;
        if (!inner.id) return "Response missing 'id' field";
        flowId = String(inner.id);
        return null;
      }),
    );
    if (!flowId) {
      return buildResult(steps, checkStart, "Cannot proceed without flow ID");
    }

    // Step 2: Add Source->LLM->Output pipeline via canvas update
    const canvasResp = await http.put(`/v1/flows/${flowId}/canvas`, {
      nodes: [
        {
          node_key: "source_1",
          node_type: "source",
          label: "Question Source",
          config: { content: "What is 2+2? Reply with just the number." },
          position_x: 100,
          position_y: 200,
        },
        {
          node_key: "llm_1",
          node_type: "llm",
          label: "Math LLM",
          config: {
            prompt_template: "{{input}}",
            model: "google/gemini-2.0-flash-001",
            max_tokens: 50,
            temperature: 0,
          },
          position_x: 400,
          position_y: 200,
        },
        {
          node_key: "output_1",
          node_type: "output",
          label: "Result",
          config: { format: "text" },
          position_x: 700,
          position_y: 200,
        },
      ],
      edges: [
        { source_node_key: "source_1", target_node_key: "llm_1" },
        { source_node_key: "llm_1", target_node_key: "output_1" },
      ],
    }, "admin-key");
    steps.push(
      stepFromResponse(`PUT /v1/flows/${flowId}/canvas (Source->LLM->Output)`, canvasResp, 200),
    );
    if (canvasResp.status !== 200) {
      return buildResult(steps, checkStart, "Cannot proceed without canvas");
    }

    // Step 3: Run the flow
    const runResp = await http.post(`/v1/flows/${flowId}/run`, {}, "admin-key");
    let runId: string | null = null;
    steps.push(
      stepFromResponse(`POST /v1/flows/${flowId}/run (trigger execution)`, runResp, [200, 201, 202], (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        const inner = (obj.data ?? obj) as Record<string, unknown>;
        if (!inner.id) return "Response missing run 'id' field";
        const status = String(inner.status);
        if (status !== "queued" && status !== "running") {
          return `Expected status 'queued' or 'running', got '${status}'`;
        }
        runId = String(inner.id);
        return null;
      }),
    );
    if (!runId) {
      return buildResult(steps, checkStart, "Cannot proceed without run ID");
    }

    // Step 4: Poll for completion (max 60s, 2s interval)
    const pollStart = performance.now();
    let finalStatus = "queued";
    let pollCount = 0;
    let lastPollData: Record<string, unknown> | null = null;

    while (performance.now() - pollStart < MAX_POLL_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      pollCount++;

      const pollResp = await http.get(`/v1/flows/${flowId}/runs/${runId}`, "admin-key");
      if (pollResp.error || pollResp.status !== 200) {
        steps.push(
          stepFromResponse(`GET /v1/flows/${flowId}/runs/${runId} (poll #${pollCount})`, pollResp, 200),
        );
        break;
      }

      const pollObj = pollResp.data as Record<string, unknown>;
      const runData = (pollObj?.data ?? pollObj) as Record<string, unknown>;
      finalStatus = String(runData?.status ?? "unknown");
      lastPollData = pollObj;

      if (finalStatus !== "queued" && finalStatus !== "running") {
        break;
      }
    }

    const pollDuration = Math.round(performance.now() - pollStart);
    steps.push({
      name: `Poll for completion (${pollCount} polls, ${pollDuration}ms)`,
      status: finalStatus === "completed" ? "pass" : "fail",
      durationMs: pollDuration,
      detail: `Final status: ${finalStatus}`,
      error: finalStatus !== "completed" ? `Expected status 'completed', got '${finalStatus}'` : undefined,
    });

    if (finalStatus !== "completed" || !lastPollData) {
      return buildResult(steps, checkStart, `Flow run did not complete: ${finalStatus}`);
    }

    // Step 5: Verify node results
    const runData = (lastPollData.data ?? lastPollData) as Record<string, unknown>;
    const nodeResults = (lastPollData.node_results ?? runData.node_results) as Array<Record<string, unknown>> | undefined;

    if (!nodeResults || !Array.isArray(nodeResults)) {
      steps.push({
        name: "Verify node_results present",
        status: "fail",
        durationMs: 0,
        error: "node_results missing or not an array",
      });
      return buildResult(steps, checkStart);
    }

    // Check each node completed
    const resultsByKey: Record<string, Record<string, unknown>> = {};
    for (const nr of nodeResults) {
      resultsByKey[String(nr.node_key)] = nr;
    }

    // Source node
    const sourceResult = resultsByKey["source_1"];
    steps.push({
      name: "Verify source_1 node result",
      status: sourceResult && sourceResult.status === "done" ? "pass" : "fail",
      durationMs: 0,
      detail: sourceResult ? `status=${sourceResult.status}` : "not found",
      error: !sourceResult ? "source_1 node result not found" :
             sourceResult.status !== "done" ? `Expected status 'done', got '${sourceResult.status}'` : undefined,
    });

    // LLM node
    const llmResult = resultsByKey["llm_1"];
    steps.push({
      name: "Verify llm_1 node result",
      status: llmResult && llmResult.status === "done" ? "pass" : "fail",
      durationMs: Number(llmResult?.duration_ms ?? 0),
      detail: llmResult ? `status=${llmResult.status}, model=${llmResult.model ?? "?"}` : "not found",
      error: !llmResult ? "llm_1 node result not found" :
             llmResult.status !== "done" ? `Expected status 'done', got '${llmResult.status}'` : undefined,
    });

    // Verify LLM produced output
    if (llmResult && llmResult.status === "done") {
      const llmOutput = String(llmResult.output ?? "");
      steps.push({
        name: "Verify LLM output is non-empty",
        status: llmOutput.length > 0 ? "pass" : "fail",
        durationMs: 0,
        detail: `output: "${llmOutput.slice(0, 100)}"`,
        error: llmOutput.length === 0 ? "LLM output is empty" : undefined,
      });

      // Check if "4" appears in the output (2+2=4)
      const hasAnswer = llmOutput.includes("4");
      steps.push({
        name: "Verify LLM answered correctly (contains '4')",
        status: hasAnswer ? "pass" : "warn",
        durationMs: 0,
        detail: `output: "${llmOutput.slice(0, 100)}"`,
        error: !hasAnswer ? `Expected output to contain '4', got: "${llmOutput.slice(0, 100)}"` : undefined,
      });
    }

    // Output node
    const outputResult = resultsByKey["output_1"];
    steps.push({
      name: "Verify output_1 node result",
      status: outputResult && outputResult.status === "done" ? "pass" : "fail",
      durationMs: 0,
      detail: outputResult ? `status=${outputResult.status}` : "not found",
      error: !outputResult ? "output_1 node result not found" :
             outputResult.status !== "done" ? `Expected status 'done', got '${outputResult.status}'` : undefined,
    });

    // Step 6: Verify cost tracking
    const costUsd = runData.cost_usd;
    if (costUsd !== undefined && costUsd !== null) {
      const cost = Number(costUsd);
      steps.push({
        name: "Verify cost_usd tracked",
        status: cost >= 0 ? "pass" : "warn",
        durationMs: 0,
        detail: `cost_usd=${costUsd}`,
      });
    }

    // Step 7: Delete flow (cleanup)
    const deleteResp = await http.delete(`/v1/flows/${flowId}`, "admin-key");
    steps.push(
      stepFromResponse(`DELETE /v1/flows/${flowId} (cleanup)`, deleteResp, [200, 204]),
    );
    if (deleteResp.status === 200 || deleteResp.status === 204) {
      flowId = null;
    }
  } catch (err: unknown) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (flowId) {
      try {
        const cleanupResp = await http.delete(`/v1/flows/${flowId}`, "admin-key");
        steps.push(
          stepFromResponse(`DELETE /v1/flows/${flowId} (finally cleanup)`, cleanupResp, [200, 204, 404]),
        );
      } catch (cleanupErr: unknown) {
        steps.push({
          name: "cleanup: delete flow",
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
    name: "flow-execution",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg,
  };
}
