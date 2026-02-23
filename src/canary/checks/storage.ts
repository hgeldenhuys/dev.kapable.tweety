/**
 * Storage Check -- verifies MinIO/S3 storage endpoints: status, bucket CRUD,
 * and usage reporting. If storage is not configured (503), the check is skipped.
 */
import type { HttpClient } from "../http";
import type { CheckResult, StepResult } from "../types";

const STORAGE_PATH = "/v1/storage";
const BUCKET_NAME = "canary-test-bucket";

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

export async function storageCheck(http: HttpClient): Promise<CheckResult> {
  const steps: StepResult[] = [];
  const checkStart = performance.now();
  let bucketCreated = false;

  try {
    // Step 1: Check storage status
    const statusResp = await http.get(`${STORAGE_PATH}/status`, "admin-key");

    // If storage returns 503, it is not configured -- skip the entire check
    if (statusResp.status === 503) {
      return {
        name: "storage",
        status: "skip",
        durationMs: Math.round(performance.now() - checkStart),
        steps: [
          {
            name: "GET /v1/storage/status (check configured)",
            status: "skip",
            durationMs: statusResp.durationMs,
            detail: "Storage not configured (503) -- skipping storage checks",
          },
        ],
      };
    }

    steps.push(
      stepFromResponse("GET /v1/storage/status (check configured)", statusResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        if (obj.configured !== true) {
          return `Expected configured=true, got ${obj.configured}`;
        }
        return null;
      }),
    );

    // If status check failed, don't proceed
    if (statusResp.status !== 200) {
      return buildResult(steps, checkStart, "Storage status check failed -- cannot proceed");
    }

    // Step 2: Pre-cleanup -- delete canary bucket if it exists from a previous run
    const preClean = await http.delete(`${STORAGE_PATH}/buckets/${BUCKET_NAME}`, "admin-key");
    if (preClean.status === 200 || preClean.status === 204) {
      steps.push({
        name: `pre-cleanup: DELETE /v1/storage/buckets/${BUCKET_NAME} (existed from previous run)`,
        status: "pass",
        durationMs: preClean.durationMs,
        detail: "Stale bucket cleaned up",
      });
    }
    // If 404 or other, bucket didn't exist -- that's fine, no step added

    // Step 3: Create bucket
    const createResp = await http.post(
      `${STORAGE_PATH}/buckets`,
      { name: BUCKET_NAME, visibility: "private" },
      "admin-key",
    );
    steps.push(
      stepFromResponse(`POST /v1/storage/buckets (create ${BUCKET_NAME})`, createResp, [200, 201]),
    );
    if (createResp.status === 200 || createResp.status === 201) {
      bucketCreated = true;
    } else {
      return buildResult(steps, checkStart, "Cannot proceed without bucket creation");
    }

    // Step 4: List buckets -- verify our bucket appears (name is auto-prefixed with kap-{org_slug}-)
    const listResp = await http.get(`${STORAGE_PATH}/buckets`, "admin-key");
    steps.push(
      stepFromResponse("GET /v1/storage/buckets (list buckets)", listResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        const buckets = obj.buckets;
        if (!Array.isArray(buckets)) {
          return `Expected 'buckets' to be an array, got ${typeof buckets}`;
        }

        // Bucket name is auto-prefixed: kap-{org_slug}-canary-test-bucket
        let found = false;
        for (const bucket of buckets) {
          const b = bucket as Record<string, unknown>;
          const name = String(b.name ?? "");
          if (name.includes(BUCKET_NAME)) {
            found = true;
            break;
          }
        }

        return found ? null : `Bucket containing "${BUCKET_NAME}" not found in list of ${buckets.length} buckets`;
      }),
    );

    // Step 5: Check storage usage
    const usageResp = await http.get(`${STORAGE_PATH}/usage`, "admin-key");
    steps.push(
      stepFromResponse("GET /v1/storage/usage (check usage)", usageResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;

        // Verify expected numeric fields exist
        const numericFields = ["used_bytes", "quota_bytes", "bucket_count", "remaining_bytes"];
        const missingFields: string[] = [];
        for (const field of numericFields) {
          if (typeof obj[field] !== "number") {
            missingFields.push(`${field} (got ${typeof obj[field]})`);
          }
        }

        if (missingFields.length > 0) {
          return `Missing or non-numeric fields: ${missingFields.join(", ")}`;
        }

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
  } finally {
    // Always clean up: delete the test bucket
    if (bucketCreated) {
      try {
        const deleteResp = await http.delete(`${STORAGE_PATH}/buckets/${BUCKET_NAME}`, "admin-key");
        steps.push(
          stepFromResponse(
            `DELETE /v1/storage/buckets/${BUCKET_NAME} (cleanup)`,
            deleteResp,
            [200, 204, 404],
          ),
        );
      } catch (cleanupErr: unknown) {
        steps.push({
          name: "cleanup: delete bucket",
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
  let status: "pass" | "fail" | "skip" = "pass";

  for (const step of steps) {
    if (step.status === "fail") {
      status = "fail";
      break;
    }
  }

  return {
    name: "storage",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg,
  };
}
