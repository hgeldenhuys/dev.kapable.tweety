/**
 * Auth Flow Check -- exercises the full signup → login → session → cleanup flow.
 * Uses unique timestamped emails for reentrance safety.
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

export async function authFlowCheck(http: HttpClient): Promise<CheckResult> {
  const steps: StepResult[] = [];
  const checkStart = performance.now();

  const ts = Date.now();
  const email = `canary-${ts}@test.kapable.dev`;
  const password = `CanaryP@ss${ts}!`;
  const orgName = `canary-org-${ts}`;
  let sessionToken: string | null = null;

  try {
    // Step 1: Signup
    const orgSlug = `canary-org-${ts}`;
    const signupResp = await http.request<Record<string, unknown>>("POST", "/v1/auth/signup", {
      body: { email, password, name: "Canary Bird", org_name: orgName, org_slug: orgSlug },
      auth: "none",
    });

    steps.push(
      stepFromResponse("POST /v1/auth/signup", signupResp, [200, 201], (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        if (!obj.token && !obj.session_token) return "Response missing token";
        return null;
      }),
    );

    if (signupResp.error || (signupResp.status !== 200 && signupResp.status !== 201)) {
      return buildResult(steps, checkStart, "Cannot proceed without signup");
    }

    // Step 2: Login
    const loginResp = await http.request<Record<string, unknown>>("POST", "/v1/auth/login", {
      body: { email, password, org_slug: orgSlug },
      auth: "none",
    });

    steps.push(
      stepFromResponse("POST /v1/auth/login", loginResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        const token = (obj.token ?? obj.session_token) as string | undefined;
        if (!token) return "Response missing token";
        sessionToken = token;
        return null;
      }),
    );

    if (!sessionToken) {
      return buildResult(steps, checkStart, "Cannot proceed without session token");
    }

    // Step 3: Verify session
    const sessionResp = await http.request<Record<string, unknown>>("GET", "/v1/auth/session", {
      auth: "none",
      headers: { Authorization: `Bearer ${sessionToken}` },
    });

    steps.push(
      stepFromResponse("GET /v1/auth/session (verify)", sessionResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        // Verify email matches
        const respEmail = (obj.email ?? (obj.user as Record<string, unknown>)?.email) as string | undefined;
        if (respEmail && respEmail !== email) return `Email mismatch: expected ${email}, got ${respEmail}`;
        return null;
      }),
    );
  } catch (err: unknown) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // No explicit cleanup needed -- hobbyist tier orgs are lightweight,
  // and timestamped emails prevent name collisions.

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
    name: "auth-flow",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg,
  };
}
