/**
 * Flow CRUD Lifecycle Check -- creates a flow, verifies list/get/update,
 * adds canvas nodes+edges, and cleans up.
 *
 * Lifecycle: pre-cleanup -> create -> list -> get -> update -> canvas update
 * -> verify canvas -> delete
 */
import type { HttpClient } from "../../canary/http";
import type { CheckResult, StepResult } from "../../canary/types";

const FLOW_NAME = "hector-crud-test";

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

export async function flowCrudCheck(http: HttpClient): Promise<CheckResult> {
  const steps: StepResult[] = [];
  const checkStart = performance.now();
  let flowId: string | null = null;

  try {
    // Pre-cleanup: list flows and delete any stale hector-crud-test flows
    const preList = await http.get<{ data: Array<{ id: string; name: string }> }>("/v1/flows", "admin-key");
    if (preList.data && typeof preList.data === "object") {
      const listObj = preList.data as Record<string, unknown>;
      const items = Array.isArray(listObj.data) ? listObj.data as Array<Record<string, unknown>> : [];
      for (const item of items) {
        if (item.name === FLOW_NAME && item.id) {
          const delResp = await http.delete(`/v1/flows/${item.id}`, "admin-key");
          if (delResp.status === 200 || delResp.status === 204) {
            steps.push({
              name: `pre-cleanup: DELETE flow ${item.id} (stale ${FLOW_NAME})`,
              status: "pass",
              durationMs: delResp.durationMs,
              detail: "Stale flow cleaned up",
            });
          }
        }
      }
    }

    // Step 1: Create flow
    const createResp = await http.post("/v1/flows", {
      name: FLOW_NAME,
      description: "Hector CRUD test flow",
      budget_cap_usd: "1.00",
    }, "admin-key");
    steps.push(
      stepFromResponse("POST /v1/flows (create flow)", createResp, 201, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        const inner = (obj.data ?? obj) as Record<string, unknown>;
        if (!inner.id) return "Response missing 'id' field";
        if (inner.name !== FLOW_NAME) return `name mismatch: expected "${FLOW_NAME}", got "${inner.name}"`;
        flowId = String(inner.id);
        return null;
      }),
    );
    if (!flowId) {
      return buildResult(steps, checkStart, "Cannot proceed without flow ID");
    }

    // Step 2: List flows -- verify it appears
    const listResp = await http.get("/v1/flows", "admin-key");
    steps.push(
      stepFromResponse("GET /v1/flows (verify in list)", listResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        const items = Array.isArray(obj.data) ? obj.data as Array<Record<string, unknown>> : [];
        let found = false;
        for (const item of items) {
          if (String(item.id) === flowId) {
            found = true;
            break;
          }
        }
        if (!found) return `Flow ${flowId} not found in list`;
        return null;
      }),
    );

    // Step 3: Get flow by ID -- verify detail response shape
    const getResp = await http.get(`/v1/flows/${flowId}`, "admin-key");
    steps.push(
      stepFromResponse(`GET /v1/flows/${flowId} (get detail)`, getResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        // FlowDetailResponse has: data (flow), nodes, edges
        const flowData = obj.data as Record<string, unknown> | undefined;
        if (!flowData) return "Response missing 'data' field";
        if (String(flowData.id) !== flowId) return `ID mismatch: expected ${flowId}, got ${flowData.id}`;
        if (flowData.name !== FLOW_NAME) return `name mismatch: expected "${FLOW_NAME}", got "${flowData.name}"`;
        if (!Array.isArray(obj.nodes)) return "Response missing 'nodes' array";
        if (!Array.isArray(obj.edges)) return "Response missing 'edges' array";
        return null;
      }),
    );

    // Step 4: Update flow -- change description
    const updateResp = await http.put(`/v1/flows/${flowId}`, {
      description: "Hector CRUD test -- updated",
    }, "admin-key");
    steps.push(
      stepFromResponse(`PUT /v1/flows/${flowId} (update description)`, updateResp, 200),
    );

    // Step 5: Canvas update -- add Source + Output nodes and an edge
    const canvasResp = await http.put(`/v1/flows/${flowId}/canvas`, {
      nodes: [
        {
          node_key: "source_1",
          node_type: "source",
          label: "Test Source",
          config: { content: "Hello from Hector" },
          position_x: 100,
          position_y: 100,
        },
        {
          node_key: "output_1",
          node_type: "output",
          label: "Test Output",
          config: { format: "text" },
          position_x: 400,
          position_y: 100,
        },
      ],
      edges: [
        {
          source_node_key: "source_1",
          target_node_key: "output_1",
        },
      ],
    }, "admin-key");
    steps.push(
      stepFromResponse(`PUT /v1/flows/${flowId}/canvas (add nodes+edges)`, canvasResp, 200),
    );

    // Step 6: Verify canvas -- get flow and check nodes/edges
    const verifyResp = await http.get(`/v1/flows/${flowId}`, "admin-key");
    steps.push(
      stepFromResponse(`GET /v1/flows/${flowId} (verify canvas)`, verifyResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        const nodes = obj.nodes as Array<Record<string, unknown>> | undefined;
        const edges = obj.edges as Array<Record<string, unknown>> | undefined;
        if (!nodes || nodes.length !== 2) return `Expected 2 nodes, got ${nodes?.length ?? 0}`;
        if (!edges || edges.length !== 1) return `Expected 1 edge, got ${edges?.length ?? 0}`;

        // Verify node types
        const nodeTypes = new Set<string>();
        for (const n of nodes) {
          nodeTypes.add(String(n.node_type));
        }
        if (!nodeTypes.has("source")) return "Missing source node";
        if (!nodeTypes.has("output")) return "Missing output node";
        return null;
      }),
    );

    // Step 7: Delete flow
    const deleteResp = await http.delete(`/v1/flows/${flowId}`, "admin-key");
    steps.push(
      stepFromResponse(`DELETE /v1/flows/${flowId} (cleanup)`, deleteResp, [200, 204]),
    );
    if (deleteResp.status === 200 || deleteResp.status === 204) {
      flowId = null; // Already cleaned up
    }
  } catch (err: unknown) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // Cleanup: delete flow if still exists
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
    name: "flow-crud",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg,
  };
}
