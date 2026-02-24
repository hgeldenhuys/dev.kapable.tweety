/**
 * Deploy Health Check -- verifies the proxy → container → app chain works
 * by hitting the Tweety app itself through its public subdomain.
 */
import type { HttpClient } from "../http";
import type { CheckResult, StepResult } from "../types";

const TWEETY_HEALTH_URL = "https://tweety.kapable.run/health";
const TIMEOUT_MS = 5000;

export async function deployHealthCheck(_http: HttpClient): Promise<CheckResult> {
  const steps: StepResult[] = [];
  const checkStart = performance.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const fetchStart = performance.now();

    let status = 0;
    let rawText = "";
    let data: Record<string, unknown> | null = null;
    let fetchError: string | undefined;

    try {
      const resp = await fetch(TWEETY_HEALTH_URL, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      status = resp.status;
      rawText = await resp.text();
      try {
        data = JSON.parse(rawText) as Record<string, unknown>;
      } catch {
        // Not JSON
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        fetchError = `Request timed out after ${TIMEOUT_MS}ms`;
      } else if (err instanceof Error) {
        fetchError = err.message;
      } else {
        fetchError = String(err);
      }
    } finally {
      clearTimeout(timer);
    }

    const fetchDuration = Math.round(performance.now() - fetchStart);

    // Step 1: HTTP 200
    const httpStep: StepResult = {
      name: `GET ${TWEETY_HEALTH_URL}`,
      status: "pass",
      durationMs: fetchDuration,
    };

    if (fetchError) {
      httpStep.status = "fail";
      httpStep.error = fetchError;
    } else if (status !== 200) {
      httpStep.status = "fail";
      httpStep.error = `Expected status 200, got ${status}`;
      httpStep.detail = rawText.slice(0, 200);
    } else {
      httpStep.detail = `status=${status}`;
    }

    steps.push(httpStep);

    // Step 2: Valid response body (JSON or "ok" plain text)
    const bodyStep: StepResult = {
      name: "Response has valid body",
      status: "pass",
      durationMs: 0,
    };

    if (fetchError) {
      bodyStep.status = "skip";
      bodyStep.detail = "Skipped due to request failure";
    } else if (data) {
      bodyStep.detail = JSON.stringify(data).slice(0, 100);
    } else if (rawText.trim() === "ok" || rawText.trim().length > 0) {
      bodyStep.detail = `plain text: "${rawText.trim().slice(0, 50)}"`;
    } else {
      bodyStep.status = "fail";
      bodyStep.error = "Response body was empty";
    }

    steps.push(bodyStep);

    // Step 3: Response time < 5000ms
    const latencyStep: StepResult = {
      name: "Response time < 5000ms",
      status: "pass",
      durationMs: fetchDuration,
    };

    if (fetchError) {
      latencyStep.status = "fail";
      latencyStep.error = "Request failed, cannot measure latency";
    } else if (fetchDuration >= 5000) {
      latencyStep.status = "fail";
      latencyStep.error = `Response took ${fetchDuration}ms (limit 5000ms)`;
    } else {
      latencyStep.detail = `${fetchDuration}ms`;
    }

    steps.push(latencyStep);
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

function buildResult(steps: StepResult[], checkStart: number): CheckResult {
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
    name: "deploy-health",
    status,
    durationMs: totalDuration,
    steps,
  };
}
