/**
 * AI Chat Check -- verifies the AI chat service is configured and can respond
 * to a simple 1-turn prompt. Uses admin-key auth.
 *
 * Lifecycle: check status (configured=true) -> send 1-turn chat -> verify non-empty response.
 * No cleanup needed -- chat is stateless.
 */
import type { HttpClient } from "../http";
import type { CheckResult, StepResult } from "../types";

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

export async function aiChatCheck(http: HttpClient): Promise<CheckResult> {
  const steps: StepResult[] = [];
  const checkStart = performance.now();

  try {
    // Step 1: Check AI status
    const statusResp = await http.get<Record<string, unknown>>("/v1/ai/status", "admin-key");

    // 503 means AI is not configured -- skip the whole check
    if (statusResp.status === 503) {
      steps.push({
        name: "GET /v1/ai/status (check configured)",
        status: "skip",
        durationMs: statusResp.durationMs,
        detail: "AI service not configured (503), skipping check",
      });
      return buildResult(steps, checkStart);
    }

    steps.push(
      stepFromResponse("GET /v1/ai/status (check configured)", statusResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        if (obj.configured !== true) return `configured expected true, got ${obj.configured}`;
        return null;
      }),
    );

    // If status check failed, don't proceed
    if (steps[steps.length - 1].status === "fail") {
      return buildResult(steps, checkStart, "AI status check failed");
    }

    // Extract provider/model for detail
    const statusData = statusResp.data as Record<string, unknown> | null;
    const provider = statusData?.provider ?? "unknown";
    const model = statusData?.model ?? "unknown";
    if (steps[steps.length - 1].status === "pass") {
      steps[steps.length - 1].detail = `provider=${provider}, model=${model}`;
    }

    // Step 2: Send a 1-turn chat
    const chatResp = await http.request<Record<string, unknown>>("POST", "/v1/ai/chat", {
      body: {
        messages: [{ role: "user", content: "Reply with exactly: CANARY_OK" }],
        max_tokens: 50,
        temperature: 0,
      },
      auth: "admin-key",
    });

    // 402 means quota exceeded -- skip, not fail
    if (chatResp.status === 402) {
      steps.push({
        name: "POST /v1/ai/chat (1-turn canary prompt)",
        status: "skip",
        durationMs: chatResp.durationMs,
        detail: "AI quota exceeded (402), check skipped",
      });
      return buildResult(steps, checkStart);
    }

    // 503 also means service unavailable -- skip
    if (chatResp.status === 503) {
      steps.push({
        name: "POST /v1/ai/chat (1-turn canary prompt)",
        status: "skip",
        durationMs: chatResp.durationMs,
        detail: "AI service unavailable (503), check skipped",
      });
      return buildResult(steps, checkStart);
    }

    steps.push(
      stepFromResponse("POST /v1/ai/chat (1-turn canary prompt)", chatResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        // Response shape varies -- just verify we got some text content back
        const obj = data as Record<string, unknown>;
        const content = extractChatContent(obj);
        if (!content || content.trim().length === 0) {
          return "Chat response contained no text content";
        }
        return null;
      }),
    );

    // Add response content as detail if available
    const lastStep = steps[steps.length - 1];
    if (lastStep.status === "pass" && chatResp.data) {
      const content = extractChatContent(chatResp.data as Record<string, unknown>);
      if (content) {
        lastStep.detail = `response="${content.slice(0, 100)}"`;
      }
    }
  } catch (err: unknown) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return buildResult(steps, checkStart);
}

/**
 * Extract text content from an AI chat response.
 * Handles multiple possible response shapes:
 *   - {choices: [{message: {content: "..."}}]}
 *   - {content: "..."}
 *   - {response: "..."}
 *   - {message: {content: "..."}}
 */
function extractChatContent(obj: Record<string, unknown>): string | null {
  // Shape: {text: "..."} (Kapable AI proxy response)
  if (typeof obj.text === "string") return obj.text;

  // Shape: {content: "..."}
  if (typeof obj.content === "string") return obj.content;

  // Shape: {response: "..."}
  if (typeof obj.response === "string") return obj.response;

  // Shape: {choices: [{message: {content: "..."}}]}
  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const choice = obj.choices[0] as Record<string, unknown>;
    if (choice.message && typeof choice.message === "object") {
      const msg = choice.message as Record<string, unknown>;
      if (typeof msg.content === "string") return msg.content;
    }
    // Shape: {choices: [{text: "..."}]}
    if (typeof choice.text === "string") return choice.text;
  }

  // Shape: {message: {content: "..."}}
  if (obj.message && typeof obj.message === "object") {
    const msg = obj.message as Record<string, unknown>;
    if (typeof msg.content === "string") return msg.content;
  }

  return null;
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
    name: "ai-chat",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg,
  };
}
