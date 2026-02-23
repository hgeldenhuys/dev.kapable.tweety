/**
 * AI Image Generation Check -- verifies the image generation service is configured
 * and the usage endpoint returns valid data.
 *
 * Lifecycle: check status (configured=true) -> check usage (verify structure).
 * Does NOT actually generate an image -- it costs money and takes 5-30s.
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

export async function aiImageCheck(http: HttpClient): Promise<CheckResult> {
  const steps: StepResult[] = [];
  const checkStart = performance.now();

  try {
    // Step 1: Check image service status
    const statusResp = await http.get<Record<string, unknown>>("/v1/images/status", "admin-key");

    // 503 means image service is not configured -- skip the whole check
    if (statusResp.status === 503) {
      steps.push({
        name: "GET /v1/images/status (check configured)",
        status: "skip",
        durationMs: statusResp.durationMs,
        detail: "Image service not configured (503), skipping check",
      });
      return buildResult(steps, checkStart);
    }

    steps.push(
      stepFromResponse("GET /v1/images/status (check configured)", statusResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        if (obj.configured !== true) return `configured expected true, got ${obj.configured}`;
        return null;
      }),
    );

    // If status check failed, don't proceed
    if (steps[steps.length - 1].status === "fail") {
      return buildResult(steps, checkStart, "Image status check failed");
    }

    // Extract provider for detail
    const statusData = statusResp.data as Record<string, unknown> | null;
    const provider = statusData?.provider ?? "unknown";
    if (steps[steps.length - 1].status === "pass") {
      steps[steps.length - 1].detail = `provider=${provider}`;
    }

    // Step 2: Check usage endpoint
    const usageResp = await http.get<Record<string, unknown>>("/v1/images/usage", "admin-key");
    steps.push(
      stepFromResponse("GET /v1/images/usage (verify structure)", usageResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;

        // Verify expected fields exist (values can be 0, that's fine)
        const errors: string[] = [];

        if (typeof obj.generated !== "number") {
          errors.push(`"generated" field missing or not a number (got ${typeof obj.generated})`);
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
    const lastStep = steps[steps.length - 1];
    if (lastStep.status === "pass" && usageResp.data) {
      const usage = usageResp.data as Record<string, unknown>;
      lastStep.detail = `generated=${usage.generated}, quota=${usage.quota}, remaining=${usage.remaining}, month=${usage.month}`;
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

function buildResult(steps: StepResult[], checkStart: number, errorMsg?: string): CheckResult {
  const totalDuration = Math.round(performance.now() - checkStart);
  let status: "pass" | "fail" | "skip" = "pass";
  let allSkip = true;

  for (const step of steps) {
    if (step.status === "fail") {
      status = "fail";
      allSkip = false;
      break;
    }
    if (step.status !== "skip") {
      allSkip = false;
    }
  }

  // If every step was skipped, the whole check is skip
  if (allSkip && steps.length > 0) {
    status = "skip";
  }

  return {
    name: "ai-image",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg,
  };
}
