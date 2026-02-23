/**
 * Data CRUD Lifecycle Check -- creates a table, inserts/reads/updates/deletes a row,
 * then drops the table. Exercises the full Kapable Data API.
 */
import type { HttpClient } from "../http";
import type { CheckResult, StepResult } from "../types";

const TABLE_NAME = "canary_birds";
const TABLE_PATH = `/v1/${TABLE_NAME}`;
const META_PATH = `/v1/_meta/tables/${TABLE_NAME}`;

const TABLE_SCHEMA = {
  columns: [
    { name: "species", type: "text" },
    { name: "spotted_at", type: "timestamptz" },
    { name: "count", type: "integer" },
  ],
};

function makeRecord(): Record<string, unknown> {
  return {
    species: "Canary",
    spotted_at: new Date().toISOString(),
    count: 1,
  };
}

/**
 * Helper: push a step result based on an HTTP response.
 */
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

export async function dataCrudCheck(http: HttpClient): Promise<CheckResult> {
  const steps: StepResult[] = [];
  const checkStart = performance.now();
  let recordId: string | null = null;
  let hasFatalError = false;

  try {
    // Step 0: Try to drop table first in case it exists from a previous failed run
    const preClean = await http.delete(META_PATH, "api-key");
    if (preClean.status === 200 || preClean.status === 204) {
      steps.push({
        name: "pre-cleanup: DROP canary_birds (existed from previous run)",
        status: "pass",
        durationMs: preClean.durationMs,
        detail: "Stale table cleaned up",
      });
    }
    // If 404 or other, table didn't exist -- that's fine, no step added

    // Step 1: Create table
    const createTable = await http.put(META_PATH, TABLE_SCHEMA, "api-key");
    steps.push(
      stepFromResponse("PUT _meta/tables/canary_birds (create table)", createTable, [200, 201]),
    );
    if (createTable.error || (createTable.status !== 200 && createTable.status !== 201)) {
      hasFatalError = true;
      return buildResult(steps, checkStart, "Cannot proceed without table");
    }

    // Step 2: Insert a record
    const insertResp = await http.post(TABLE_PATH, makeRecord(), "api-key");
    steps.push(
      stepFromResponse("POST /v1/canary_birds (insert record)", insertResp, [200, 201], (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        if (!obj.id) return "Response missing 'id' field";
        recordId = String(obj.id);
        return null;
      }),
    );
    if (!recordId) {
      hasFatalError = true;
      // Still try cleanup
    }

    // Step 3: List records
    if (recordId) {
      const listResp = await http.get(TABLE_PATH, "api-key");
      steps.push(
        stepFromResponse("GET /v1/canary_birds (list records)", listResp, 200, (data) => {
          if (!Array.isArray(data)) {
            // Some APIs wrap in { data: [...] }
            const obj = data as Record<string, unknown>;
            const arr = obj?.data ?? obj?.rows ?? obj?.items;
            if (!Array.isArray(arr)) return "Response is not an array and has no data/rows/items array";
            const found = arr.some((r: Record<string, unknown>) => String(r.id) === recordId);
            return found ? null : `Record ${recordId} not found in list`;
          }
          const found = data.some((r: Record<string, unknown>) => String(r.id) === recordId);
          return found ? null : `Record ${recordId} not found in list`;
        }),
      );
    }

    // Step 4: Get by ID
    if (recordId) {
      const getResp = await http.get(`${TABLE_PATH}/${recordId}`, "api-key");
      steps.push(
        stepFromResponse(`GET /v1/canary_birds/${recordId} (get by ID)`, getResp, 200, (data) => {
          if (!data || typeof data !== "object") return "Response is not an object";
          const obj = data as Record<string, unknown>;
          if (String(obj.id) !== recordId) return `ID mismatch: expected ${recordId}, got ${obj.id}`;
          if (obj.species !== "Canary") return `species mismatch: expected "Canary", got "${obj.species}"`;
          return null;
        }),
      );
    }

    // Step 5: Update record
    if (recordId) {
      const patchResp = await http.patch(`${TABLE_PATH}/${recordId}`, { count: 2 }, "api-key");
      steps.push(
        stepFromResponse(`PATCH /v1/canary_birds/${recordId} (update count)`, patchResp, 200),
      );
    }

    // Step 6: Verify update
    if (recordId) {
      const verifyResp = await http.get(`${TABLE_PATH}/${recordId}`, "api-key");
      steps.push(
        stepFromResponse(`GET /v1/canary_birds/${recordId} (verify update)`, verifyResp, 200, (data) => {
          if (!data || typeof data !== "object") return "Response is not an object";
          const obj = data as Record<string, unknown>;
          if (Number(obj.count) !== 2) return `count expected 2, got ${obj.count}`;
          return null;
        }),
      );
    }

    // Step 7: Delete record
    if (recordId) {
      const deleteResp = await http.delete(`${TABLE_PATH}/${recordId}`, "api-key");
      steps.push(
        stepFromResponse(`DELETE /v1/canary_birds/${recordId} (delete record)`, deleteResp, [200, 204]),
      );
    }
  } catch (err: unknown) {
    hasFatalError = true;
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // Always clean up: drop the table
    try {
      const dropResp = await http.delete(META_PATH, "api-key");
      steps.push(
        stepFromResponse("DELETE _meta/tables/canary_birds (drop table)", dropResp, [200, 204, 404]),
      );
    } catch (cleanupErr: unknown) {
      steps.push({
        name: "cleanup: drop table",
        status: "fail",
        durationMs: 0,
        error: `Cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
      });
    }
  }

  return buildResult(steps, checkStart, hasFatalError ? "Check encountered fatal error" : undefined);
}

function buildResult(steps: StepResult[], checkStart: number, errorMsg?: string): CheckResult {
  const totalDuration = Math.round(performance.now() - checkStart);
  let status: "pass" | "fail" | "skip" = "pass";

  for (const step of steps) {
    if (step.status === "fail") {
      status = "fail";
      break;
    }
  }

  return {
    name: "data-crud",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg,
  };
}
