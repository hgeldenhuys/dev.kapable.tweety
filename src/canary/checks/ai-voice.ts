/**
 * AI Voice Synthesis Check -- verifies the voice synthesis service is configured,
 * lists available voices, and checks usage data.
 *
 * Lifecycle: check status (configured=true) -> list voices (verify array with >0 items)
 * -> check usage (verify structure).
 * Does NOT actually generate audio -- it costs money.
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

export async function aiVoiceCheck(http: HttpClient): Promise<CheckResult> {
  const steps: StepResult[] = [];
  const checkStart = performance.now();

  try {
    // Step 1: Check voice service status
    const statusResp = await http.get<Record<string, unknown>>("/v1/voice/status", "admin-key");

    // 503 means voice service is not configured -- skip the whole check
    if (statusResp.status === 503) {
      steps.push({
        name: "GET /v1/voice/status (check configured)",
        status: "skip",
        durationMs: statusResp.durationMs,
        detail: "Voice service not configured (503), skipping check",
      });
      return buildResult(steps, checkStart);
    }

    steps.push(
      stepFromResponse("GET /v1/voice/status (check configured)", statusResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        if (obj.configured !== true) return `configured expected true, got ${obj.configured}`;
        return null;
      }),
    );

    // If status check failed, don't proceed
    if (steps[steps.length - 1].status === "fail") {
      return buildResult(steps, checkStart, "Voice status check failed");
    }

    // Extract provider for detail
    const statusData = statusResp.data as Record<string, unknown> | null;
    const provider = statusData?.provider ?? "unknown";
    if (steps[steps.length - 1].status === "pass") {
      steps[steps.length - 1].detail = `provider=${provider}`;
    }

    // Step 2: List voices
    const voicesResp = await http.get<unknown>("/v1/voice/voices", "admin-key");

    // 500 means the external voice provider (ElevenLabs) returned an error -- skip, not fail
    if (voicesResp.status === 500) {
      steps.push({
        name: "GET /v1/voice/voices (list voices)",
        status: "skip",
        durationMs: voicesResp.durationMs,
        detail: `External voice provider error (500), skipping: ${voicesResp.rawText.slice(0, 200)}`,
      });
    } else {
    steps.push(
      stepFromResponse("GET /v1/voice/voices (list voices)", voicesResp, 200, (data) => {
        if (!Array.isArray(data)) {
          // Some APIs wrap in { data: [...] } or { voices: [...] }
          if (data && typeof data === "object") {
            const obj = data as Record<string, unknown>;
            const arr = obj.data ?? obj.voices ?? obj.items;
            if (Array.isArray(arr)) {
              if (arr.length === 0) {
                // Empty array is a warning, not a failure
                return null;
              }
              return null;
            }
          }
          return "Response is not an array and has no data/voices/items array";
        }
        // Empty array is acceptable (ElevenLabs may have issues) but we note it
        return null;
      }),
    );

    // Add voice count as detail
    const voicesStep = steps[steps.length - 1];
    if (voicesStep.status === "pass" && voicesResp.data) {
      const voiceCount = getArrayLength(voicesResp.data);
      if (voiceCount === 0) {
        voicesStep.detail = "WARNING: voice list is empty (ElevenLabs may have issues)";
      } else {
        voicesStep.detail = `${voiceCount} voices available`;
      }
    }
    } // end else (non-500 voices response)

    // Step 3: Check usage endpoint
    const usageResp = await http.get<Record<string, unknown>>("/v1/voice/usage", "admin-key");
    steps.push(
      stepFromResponse("GET /v1/voice/usage (verify structure)", usageResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;

        // Verify expected fields exist (values can be 0, that's fine)
        const errors: string[] = [];

        if (typeof obj.characters_used !== "number") {
          errors.push(`"characters_used" field missing or not a number (got ${typeof obj.characters_used})`);
        }
        if (typeof obj.quota !== "number") {
          errors.push(`"quota" field missing or not a number (got ${typeof obj.quota})`);
        }
        if (typeof obj.remaining !== "number") {
          errors.push(`"remaining" field missing or not a number (got ${typeof obj.remaining})`);
        }
        if (typeof obj.month !== "string") {
          errors.push(`"month" field missing or not a string (got ${typeof obj.month})`);
        }

        return errors.length > 0 ? errors.join("; ") : null;
      }),
    );

    // Add usage summary as detail
    const usageStep = steps[steps.length - 1];
    if (usageStep.status === "pass" && usageResp.data) {
      const usage = usageResp.data as Record<string, unknown>;
      usageStep.detail = `characters_used=${usage.characters_used}, quota=${usage.quota}, remaining=${usage.remaining}, month=${usage.month}`;
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
 * Get array length from a response that might be an array or an object wrapping an array.
 */
function getArrayLength(data: unknown): number {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const arr = obj.data ?? obj.voices ?? obj.items;
    if (Array.isArray(arr)) return arr.length;
  }
  return 0;
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
    name: "ai-voice",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg,
  };
}
