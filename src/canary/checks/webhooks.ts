/**
 * Webhooks Lifecycle Check -- creates a webhook, reads it, and deletes it.
 * Requires KAPABLE_PROJECT_ID env var; skips if not set.
 */
import type { HttpClient } from "../http";
import type { CheckResult, StepResult } from "../types";

const CANARY_WEBHOOK_URL = "https://example.com/canary-webhook";

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

export async function webhooksCheck(http: HttpClient): Promise<CheckResult> {
  const projectId = process.env.KAPABLE_PROJECT_ID ?? "";

  // Skip if project ID is not configured
  if (!projectId) {
    return {
      name: "webhooks",
      status: "skip",
      durationMs: 0,
      steps: [{
        name: "KAPABLE_PROJECT_ID not set",
        status: "skip",
        durationMs: 0,
        detail: "Webhooks check requires KAPABLE_PROJECT_ID env var",
      }],
    };
  }

  const webhooksPath = `/v1/projects/${projectId}/webhooks`;
  const steps: StepResult[] = [];
  const checkStart = performance.now();
  let webhookId: string | null = null;

  try {
    // Pre-cleanup: list webhooks and delete any canary webhooks
    const preList = await http.get(webhooksPath, "admin-key");
    if (preList.data && typeof preList.data === "object") {
      const listObj = preList.data as Record<string, unknown>;
      // Response may be { data: [...] } or array directly
      const items = Array.isArray(listObj.data) ? listObj.data : (Array.isArray(preList.data) ? preList.data as unknown[] : []);
      for (const item of items) {
        const wh = item as Record<string, unknown>;
        if (wh.url === CANARY_WEBHOOK_URL && wh.id) {
          const delResp = await http.delete(`${webhooksPath}/${wh.id}`, "admin-key");
          if (delResp.status === 204 || delResp.status === 200) {
            steps.push({
              name: "pre-cleanup: DELETE canary webhook (existed from previous run)",
              status: "pass",
              durationMs: delResp.durationMs,
              detail: "Stale webhook cleaned up",
            });
          }
        }
      }
    }

    // Step 1: Create webhook
    const createResp = await http.post(
      webhooksPath,
      {
        url: CANARY_WEBHOOK_URL,
        description: "Canary test webhook",
        enabled: true,
        events: ["insert", "update"],
      },
      "admin-key",
    );
    steps.push(
      stepFromResponse("POST /v1/projects/{pid}/webhooks (create webhook)", createResp, 201, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        // Response is wrapped in {data: {...}}
        const inner = obj.data ?? obj;
        if (!inner || typeof inner !== "object") return "Response missing 'data' wrapper";
        const webhook = inner as Record<string, unknown>;
        if (!webhook.id) return "Response missing 'id' field";
        if (webhook.url !== CANARY_WEBHOOK_URL) {
          return `url mismatch: expected "${CANARY_WEBHOOK_URL}", got "${webhook.url}"`;
        }
        webhookId = String(webhook.id);
        return null;
      }),
    );
    if (!webhookId) {
      return buildResult(steps, checkStart, "Cannot proceed without webhook ID");
    }

    // Step 2: Get webhook by ID
    const getResp = await http.get(`${webhooksPath}/${webhookId}`, "admin-key");
    steps.push(
      stepFromResponse(`GET /v1/projects/{pid}/webhooks/${webhookId} (get by ID)`, getResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        // Response is wrapped in {data: {...}}
        const inner = obj.data ?? obj;
        if (!inner || typeof inner !== "object") return "Response missing 'data' wrapper";
        const webhook = inner as Record<string, unknown>;
        if (String(webhook.id) !== webhookId) {
          return `ID mismatch: expected ${webhookId}, got ${webhook.id}`;
        }
        if (webhook.url !== CANARY_WEBHOOK_URL) {
          return `url mismatch: expected "${CANARY_WEBHOOK_URL}", got "${webhook.url}"`;
        }
        return null;
      }),
    );

    // Step 3: Delete webhook
    const deleteResp = await http.delete(`${webhooksPath}/${webhookId}`, "admin-key");
    steps.push(
      stepFromResponse(`DELETE /v1/projects/{pid}/webhooks/${webhookId} (delete)`, deleteResp, 204),
    );
    if (deleteResp.status === 204) {
      webhookId = null; // Already cleaned up
    }
  } catch (err: unknown) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // Cleanup: delete webhook if still exists
    if (webhookId) {
      try {
        const cleanupResp = await http.delete(`${webhooksPath}/${webhookId}`, "admin-key");
        steps.push(
          stepFromResponse(`DELETE /v1/projects/{pid}/webhooks/${webhookId} (cleanup)`, cleanupResp, [204, 404]),
        );
      } catch (cleanupErr: unknown) {
        steps.push({
          name: "cleanup: delete webhook",
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
    name: "webhooks",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg,
  };
}
