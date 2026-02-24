/**
 * App Lifecycle Check -- the core SDLC canary.
 * Creates an app, verifies the environment, triggers deploy, polls until done,
 * verifies the subdomain serves traffic, then cleans up.
 *
 * Uses a fixed slug ("canary-smoke") for reentrance -- pre-cleanup handles orphans.
 */
import type { HttpClient } from "../http";
import type { CheckResult, StepResult } from "../types";

const APP_SLUG = "canary-smoke";
const APP_NAME = "Canary Smoke";
const FRAMEWORK = "bun-server";
const DEPLOY_POLL_INTERVAL_MS = 5000;
const DEPLOY_TIMEOUT_MS = 120_000;
const SUBDOMAIN_TIMEOUT_MS = 30_000;
const SUBDOMAIN_RETRY_INTERVAL_MS = 3000;
const SUBDOMAIN_URL = `https://${APP_SLUG}.kapable.run/health`;

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

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function appLifecycleCheck(http: HttpClient): Promise<CheckResult> {
  const steps: StepResult[] = [];
  const checkStart = performance.now();
  let appId: string | null = null;

  try {
    // Step 1: Pre-cleanup — delete existing canary-smoke app if it exists
    // Response format: { data: [...], pagination: {...} }
    const listResp = await http.get<Record<string, unknown>>("/v1/apps", "admin-key");
    if (!listResp.error && listResp.data) {
      const wrapper = listResp.data as Record<string, unknown>;
      const appsArray = (wrapper.data ?? wrapper) as Record<string, unknown>[];
      const apps = Array.isArray(appsArray) ? appsArray : [];
      for (const app of apps) {
        const obj = app as Record<string, unknown>;
        if (obj.slug === APP_SLUG) {
          const existingId = String(obj.id);
          // Stop the production environment first (can't DELETE production, but can STOP it)
          const stopResp = await http.request<Record<string, unknown>>(
            "POST",
            `/v1/apps/${existingId}/environments/production/stop`,
            { auth: "admin-key" },
          );
          // Retry app delete — container teardown is async
          let delResp = stopResp;
          let cleanupOk = false;
          for (let attempt = 0; attempt < 5; attempt++) {
            await sleep(3000);
            delResp = await http.delete(`/v1/apps/${existingId}`, "admin-key");
            if (!delResp.error || delResp.status === 404) {
              cleanupOk = true;
              break;
            }
          }
          steps.push({
            name: `pre-cleanup: stop + DELETE /v1/apps/${existingId}`,
            status: cleanupOk ? "pass" : "fail",
            durationMs: delResp.durationMs + stopResp.durationMs + listResp.durationMs,
            detail: cleanupOk ? "Orphan cleaned up" : `stop=${stopResp.status}, app-del=${delResp.status}`,
            error: cleanupOk ? undefined : (delResp.error || `app-del returned ${delResp.status}`),
          });
          // Don't break — clean up ALL orphans (multiple can exist from concurrent runs)
        }
      }
    }

    // Step 2: Create app (retry on 409 — delete cascade may still be in progress)
    let createResp = await http.request<Record<string, unknown>>("POST", "/v1/apps", {
      body: { name: APP_NAME, slug: APP_SLUG, framework: FRAMEWORK },
      auth: "admin-key",
    });

    if (createResp.status === 409) {
      for (let attempt = 0; attempt < 3; attempt++) {
        await sleep(3000);
        createResp = await http.request<Record<string, unknown>>("POST", "/v1/apps", {
          body: { name: APP_NAME, slug: APP_SLUG, framework: FRAMEWORK },
          auth: "admin-key",
        });
        if (createResp.status !== 409) break;
      }
    }

    steps.push(
      stepFromResponse("POST /v1/apps (create canary-smoke)", createResp, [200, 201], (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        if (!obj.id) return "Response missing 'id' field";
        appId = String(obj.id);
        return null;
      }),
    );

    if (!appId) {
      return buildResult(steps, checkStart, "Cannot proceed without app ID");
    }

    // Step 3: Verify environment exists
    const getResp = await http.get<Record<string, unknown>>(`/v1/apps/${appId}`, "admin-key");
    steps.push(
      stepFromResponse(`GET /v1/apps/${appId} (verify env)`, getResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        const envs = obj.environments as Record<string, unknown>[] | undefined;
        if (!envs || !Array.isArray(envs) || envs.length === 0) return "No environments found";
        const prodEnv = envs[0] as Record<string, unknown>;
        if (prodEnv.name !== "production") return `Expected env name 'production', got '${prodEnv.name}'`;
        return null;
      }),
    );

    // Step 4: Trigger deploy
    const deployResp = await http.request<Record<string, unknown>>(
      "POST",
      `/v1/apps/${appId}/environments/production/deploy`,
      { auth: "admin-key" },
    );

    let deploymentId: string | null = null;
    steps.push(
      stepFromResponse("POST .../deploy (trigger)", deployResp, [200, 201, 202], (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        const id = obj.id ?? obj.deployment_id;
        if (!id) return "Response missing deployment ID";
        deploymentId = String(id);
        return null;
      }),
    );

    if (!deploymentId) {
      return buildResult(steps, checkStart, "Cannot proceed without deployment ID");
    }

    // Step 5: Poll deploy until success or failure
    const pollStart = performance.now();
    let deployStatus = "pending";
    let pollCount = 0;

    while (performance.now() - pollStart < DEPLOY_TIMEOUT_MS) {
      await sleep(DEPLOY_POLL_INTERVAL_MS);
      pollCount++;

      const pollResp = await http.get<Record<string, unknown>>(
        `/v1/apps/${appId}/environments/production/deployments/${deploymentId}`,
        "admin-key",
      );

      if (pollResp.error) continue;
      if (pollResp.data && typeof pollResp.data === "object") {
        const obj = pollResp.data as Record<string, unknown>;
        // API wraps response in { data: { status: ... } }
        const inner = (obj.data && typeof obj.data === "object" ? obj.data : obj) as Record<string, unknown>;
        deployStatus = String(inner.status ?? "unknown");
        if (deployStatus === "success" || deployStatus === "failed" || deployStatus === "error") {
          break;
        }
      }
    }

    const pollDuration = Math.round(performance.now() - pollStart);
    const pollStep: StepResult = {
      name: `Poll deployment (${pollCount} polls)`,
      status: deployStatus === "success" ? "pass" : "fail",
      durationMs: pollDuration,
      detail: `status=${deployStatus}`,
    };

    if (deployStatus !== "success") {
      pollStep.error = `Deploy ended with status '${deployStatus}'`;
    }

    steps.push(pollStep);

    if (deployStatus !== "success") {
      return buildResult(steps, checkStart, "Deploy did not succeed");
    }

    // Step 6: Verify subdomain serves traffic
    const subdomainStart = performance.now();
    let subdomainOk = false;
    let lastSubError = "";
    let subRetries = 0;

    while (performance.now() - subdomainStart < SUBDOMAIN_TIMEOUT_MS) {
      subRetries++;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(SUBDOMAIN_URL, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        clearTimeout(timer);

        if (resp.status === 200) {
          subdomainOk = true;
          break;
        }
        lastSubError = `status=${resp.status}`;
      } catch (err: unknown) {
        lastSubError = err instanceof Error ? err.message : String(err);
      }

      await sleep(SUBDOMAIN_RETRY_INTERVAL_MS);
    }

    const subdomainDuration = Math.round(performance.now() - subdomainStart);
    const subStep: StepResult = {
      name: `GET ${SUBDOMAIN_URL} (verify live)`,
      status: subdomainOk ? "pass" : "fail",
      durationMs: subdomainDuration,
      detail: subdomainOk ? `OK after ${subRetries} attempt(s)` : undefined,
    };

    if (!subdomainOk) {
      subStep.error = `Subdomain not reachable after ${subRetries} attempts: ${lastSubError}`;
    }

    steps.push(subStep);
  } catch (err: unknown) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // Always cleanup: stop environment, then delete app (cascades)
    if (appId) {
      try {
        // Stop environment (can't DELETE production, but stopping it allows app deletion)
        await http.request<Record<string, unknown>>(
          "POST",
          `/v1/apps/${appId}/environments/production/stop`,
          { auth: "admin-key" },
        );
        // Retry app delete — container teardown is async
        let delResp: { status: number; durationMs: number; error?: string; rawText: string; data: unknown } | null = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          await sleep(3000);
          delResp = await http.delete(`/v1/apps/${appId}`, "admin-key");
          if (!delResp.error || delResp.status === 404 || delResp.status === 200 || delResp.status === 204) {
            break;
          }
        }
        if (delResp) {
          steps.push(
            stepFromResponse(`DELETE /v1/apps/${appId} (cleanup)`, delResp, [200, 204, 404]),
          );
        }
      } catch (cleanupErr: unknown) {
        steps.push({
          name: "cleanup: delete app",
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
    name: "app-lifecycle",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg,
  };
}
