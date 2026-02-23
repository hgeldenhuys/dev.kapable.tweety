/**
 * Audit Logs Check -- queries the management audit logs endpoint and verifies
 * the response structure (data array + pagination).
 */
import type { HttpClient } from "../http";
import type { CheckResult, StepResult } from "../types";

const AUDIT_PATH = "/v1/management/audit-logs";

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

export async function auditLogsCheck(http: HttpClient): Promise<CheckResult> {
  const steps: StepResult[] = [];
  const checkStart = performance.now();

  try {
    // Step 1: List recent audit logs with limit
    const listResp = await http.get(`${AUDIT_PATH}?limit=5`, "admin-key");
    steps.push(
      stepFromResponse("GET /v1/management/audit-logs?limit=5 (list recent)", listResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;

        // Verify data array exists
        if (!Array.isArray(obj.data)) {
          return `Expected 'data' to be an array, got ${typeof obj.data}`;
        }

        // Verify pagination object exists
        const pagination = obj.pagination as Record<string, unknown> | undefined;
        if (!pagination || typeof pagination !== "object") {
          return "Response missing 'pagination' object";
        }

        // Verify pagination fields
        if (typeof pagination.total !== "number") {
          return `Expected pagination.total to be a number, got ${typeof pagination.total}`;
        }
        if (typeof pagination.limit !== "number") {
          return `Expected pagination.limit to be a number, got ${typeof pagination.limit}`;
        }
        if (typeof pagination.offset !== "number") {
          return `Expected pagination.offset to be a number, got ${typeof pagination.offset}`;
        }
        if (typeof pagination.has_more !== "boolean") {
          return `Expected pagination.has_more to be a boolean, got ${typeof pagination.has_more}`;
        }

        return null;
      }),
    );

    // Step 2: Verify structure of individual log entries (if any exist)
    const listData = listResp.data as Record<string, unknown> | null;
    const entries = listData?.data as unknown[] | undefined;

    if (entries && entries.length > 0) {
      const entry = entries[0] as Record<string, unknown>;
      const structureStep: StepResult = {
        name: "Verify audit log entry structure",
        status: "pass",
        durationMs: 0,
      };

      const requiredFields = ["id", "action", "resource_type", "created_at"];
      const missingFields: string[] = [];
      for (const field of requiredFields) {
        if (entry[field] === undefined || entry[field] === null) {
          missingFields.push(field);
        }
      }

      if (missingFields.length > 0) {
        structureStep.status = "fail";
        structureStep.error = `Audit log entry missing required fields: ${missingFields.join(", ")}`;
      } else {
        structureStep.detail = `action=${entry.action}, resource_type=${entry.resource_type}, entries=${entries.length}`;
      }

      steps.push(structureStep);
    } else {
      // Empty array is acceptable -- the endpoint works, there are just no recent logs
      steps.push({
        name: "Verify audit log entry structure",
        status: "pass",
        durationMs: 0,
        detail: "No audit log entries found (empty data array -- acceptable)",
      });
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
    name: "audit-logs",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg,
  };
}
