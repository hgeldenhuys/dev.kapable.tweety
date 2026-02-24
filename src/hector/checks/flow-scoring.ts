/**
 * Flow Scoring Check -- tests Judge and Committee node types.
 *
 * Test 1: Source -> Judge (rubric scoring) -> Output
 *   Verifies: score populated, reasoning non-empty, score within range
 *
 * Test 2: Source -> Judge1 + Judge2 (parallel) -> Committee (average) -> Output
 *   Verifies: committee aggregates judge scores, passed field populated
 */
import type { HttpClient } from "../../canary/http";
import type { CheckResult, StepResult } from "../../canary/types";

const FLOW_NAME_JUDGE = "hector-judge-test";
const FLOW_NAME_COMMITTEE = "hector-committee-test";
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

/**
 * Run a flow and poll until complete, returning node results by key.
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

export async function flowScoringCheck(http: HttpClient): Promise<CheckResult> {
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
        if ((item.name === FLOW_NAME_JUDGE || item.name === FLOW_NAME_COMMITTEE) && item.id) {
          await http.delete(`/v1/flows/${item.id}`, "admin-key");
        }
      }
    }

    // ── Test 1: Single Judge ──
    const judgeCreateResp = await http.post("/v1/flows", {
      name: FLOW_NAME_JUDGE,
      description: "Hector judge scoring test",
      budget_cap_usd: "0.50",
    }, "admin-key");
    let judgeFlowId: string | null = null;
    steps.push(
      stepFromResponse("POST /v1/flows (create judge flow)", judgeCreateResp, 201, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        const inner = (obj.data ?? obj) as Record<string, unknown>;
        if (!inner.id) return "Missing id";
        judgeFlowId = String(inner.id);
        return null;
      }),
    );

    if (judgeFlowId) {
      flowIds.push(judgeFlowId);

      // Canvas: Source -> Judge -> Output
      const canvasResp = await http.put(`/v1/flows/${judgeFlowId}/canvas`, {
        nodes: [
          {
            node_key: "source_1",
            node_type: "source",
            label: "Content to Judge",
            config: { content: "The sky is blue because of Rayleigh scattering of sunlight by the atmosphere." },
            position_x: 100,
            position_y: 200,
          },
          {
            node_key: "judge_1",
            node_type: "judge",
            label: "Quality Judge",
            config: {
              rubric: "Rate the scientific accuracy of this statement on a scale of 0 to 10. Consider factual correctness and completeness.",
              score_min: 0,
              score_max: 10,
              model: "google/gemini-2.0-flash-001",
            },
            position_x: 400,
            position_y: 200,
          },
          {
            node_key: "output_1",
            node_type: "output",
            label: "Judge Result",
            config: { format: "text" },
            position_x: 700,
            position_y: 200,
          },
        ],
        edges: [
          { source_node_key: "source_1", target_node_key: "judge_1" },
          { source_node_key: "judge_1", target_node_key: "output_1" },
        ],
      }, "admin-key");
      steps.push(
        stepFromResponse(`PUT /v1/flows/${judgeFlowId}/canvas (Source->Judge->Output)`, canvasResp, 200),
      );

      if (canvasResp.status === 200) {
        const judgeNodes = await runAndPoll(http, judgeFlowId, steps, "judge");
        if (judgeNodes) {
          const judgeResult = judgeNodes["judge_1"];

          // Verify judge scored
          const score = judgeResult?.score;
          const scoreMax = judgeResult?.score_max;
          steps.push({
            name: "Verify judge score populated",
            status: score !== null && score !== undefined ? "pass" : "fail",
            durationMs: 0,
            detail: `score=${score}, score_max=${scoreMax}`,
            error: score === null || score === undefined ? "Judge score is null/undefined" : undefined,
          });

          // Verify score in range
          if (score !== null && score !== undefined) {
            const numScore = Number(score);
            steps.push({
              name: "Verify score within range [0, 10]",
              status: numScore >= 0 && numScore <= 10 ? "pass" : "fail",
              durationMs: 0,
              detail: `score=${numScore}`,
              error: numScore < 0 || numScore > 10
                ? `Score ${numScore} outside range [0, 10]` : undefined,
            });
          }

          // Verify reasoning
          const reasoning = String(judgeResult?.reasoning ?? "");
          steps.push({
            name: "Verify judge reasoning non-empty",
            status: reasoning.length > 0 ? "pass" : "fail",
            durationMs: 0,
            detail: `reasoning: "${reasoning.slice(0, 100)}"`,
            error: reasoning.length === 0 ? "Judge reasoning is empty" : undefined,
          });
        }
      }
    }

    // ── Test 2: Committee (2 Judges + average) ──
    const committeeCreateResp = await http.post("/v1/flows", {
      name: FLOW_NAME_COMMITTEE,
      description: "Hector committee scoring test",
      budget_cap_usd: "1.00",
    }, "admin-key");
    let committeeFlowId: string | null = null;
    steps.push(
      stepFromResponse("POST /v1/flows (create committee flow)", committeeCreateResp, 201, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        const inner = (obj.data ?? obj) as Record<string, unknown>;
        if (!inner.id) return "Missing id";
        committeeFlowId = String(inner.id);
        return null;
      }),
    );

    if (committeeFlowId) {
      flowIds.push(committeeFlowId);

      // Canvas: Source -> Judge1 + Judge2 (parallel) -> Committee -> Output
      const canvasResp = await http.put(`/v1/flows/${committeeFlowId}/canvas`, {
        nodes: [
          {
            node_key: "source_1",
            node_type: "source",
            label: "Content",
            config: { content: "Water boils at 100 degrees Celsius at standard atmospheric pressure." },
            position_x: 100,
            position_y: 200,
          },
          {
            node_key: "judge_1",
            node_type: "judge",
            label: "Judge A",
            config: {
              rubric: "Rate scientific accuracy 0-10",
              score_min: 0,
              score_max: 10,
              model: "google/gemini-2.0-flash-001",
            },
            position_x: 400,
            position_y: 100,
          },
          {
            node_key: "judge_2",
            node_type: "judge",
            label: "Judge B",
            config: {
              rubric: "Rate clarity and precision 0-10",
              score_min: 0,
              score_max: 10,
              model: "google/gemini-2.0-flash-001",
            },
            position_x: 400,
            position_y: 300,
          },
          {
            node_key: "committee_1",
            node_type: "committee",
            label: "Score Committee",
            config: {
              method: "average",
              threshold: 5,
            },
            position_x: 700,
            position_y: 200,
          },
          {
            node_key: "output_1",
            node_type: "output",
            label: "Committee Result",
            config: { format: "text" },
            position_x: 1000,
            position_y: 200,
          },
        ],
        edges: [
          { source_node_key: "source_1", target_node_key: "judge_1" },
          { source_node_key: "source_1", target_node_key: "judge_2" },
          { source_node_key: "judge_1", target_node_key: "committee_1" },
          { source_node_key: "judge_2", target_node_key: "committee_1" },
          { source_node_key: "committee_1", target_node_key: "output_1" },
        ],
      }, "admin-key");
      steps.push(
        stepFromResponse(`PUT /v1/flows/${committeeFlowId}/canvas (Source->2xJudge->Committee->Output)`, canvasResp, 200),
      );

      if (canvasResp.status === 200) {
        const committeeNodes = await runAndPoll(http, committeeFlowId, steps, "committee");
        if (committeeNodes) {
          // Verify both judges scored
          const j1 = committeeNodes["judge_1"];
          const j2 = committeeNodes["judge_2"];

          steps.push({
            name: "Verify judge_1 scored",
            status: j1?.score !== null && j1?.score !== undefined ? "pass" : "fail",
            durationMs: 0,
            detail: `score=${j1?.score}`,
          });

          steps.push({
            name: "Verify judge_2 scored",
            status: j2?.score !== null && j2?.score !== undefined ? "pass" : "fail",
            durationMs: 0,
            detail: `score=${j2?.score}`,
          });

          // Verify committee aggregated
          const committee = committeeNodes["committee_1"];
          const committeeScore = committee?.score;
          steps.push({
            name: "Verify committee score populated",
            status: committeeScore !== null && committeeScore !== undefined ? "pass" : "fail",
            durationMs: 0,
            detail: `committee_score=${committeeScore}, j1=${j1?.score}, j2=${j2?.score}`,
            error: committeeScore === null || committeeScore === undefined
              ? "Committee score is null/undefined" : undefined,
          });

          // Verify committee passed field
          const committeePassed = committee?.passed;
          steps.push({
            name: "Verify committee 'passed' field populated",
            status: committeePassed !== null && committeePassed !== undefined ? "pass" : "warn",
            durationMs: 0,
            detail: `passed=${committeePassed}, score=${committeeScore}, threshold=5`,
          });

          // Sanity: committee score should be approximately average of judges
          if (j1?.score !== null && j2?.score !== null && committeeScore !== null) {
            const avg = (Number(j1?.score) + Number(j2?.score)) / 2;
            const diff = Math.abs(Number(committeeScore) - avg);
            steps.push({
              name: "Verify committee score ≈ average of judges",
              status: diff < 1.0 ? "pass" : "warn",
              durationMs: 0,
              detail: `committee=${committeeScore}, avg(j1,j2)=${avg.toFixed(2)}, diff=${diff.toFixed(2)}`,
              error: diff >= 1.0 ? `Committee score differs from average by ${diff.toFixed(2)}` : undefined,
            });
          }
        }
      }
    }
  } catch (err: unknown) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
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
    name: "flow-scoring",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg,
  };
}
