/**
 * Documents Lifecycle Check -- creates a document, reads it, updates it,
 * verifies the update, and deletes it.
 */
import type { HttpClient } from "../http";
import type { CheckResult, StepResult } from "../types";

const DOC_SLUG = "canary-doc";
const DOCS_PATH = "/v1/management/documents";

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

export async function documentsCheck(http: HttpClient): Promise<CheckResult> {
  const steps: StepResult[] = [];
  const checkStart = performance.now();
  let docId: string | null = null;

  try {
    // Pre-cleanup: list documents and delete any with canary-doc slug
    const preList = await http.get(DOCS_PATH, "admin-key");
    if (preList.data && typeof preList.data === "object") {
      const listObj = preList.data as Record<string, unknown>;
      const items = Array.isArray(listObj.data) ? listObj.data : (Array.isArray(preList.data) ? preList.data as unknown[] : []);
      for (const item of items) {
        const doc = item as Record<string, unknown>;
        if (doc.slug === DOC_SLUG && doc.id) {
          const delResp = await http.delete(`${DOCS_PATH}/${doc.id}`, "admin-key");
          if (delResp.status === 204 || delResp.status === 200) {
            steps.push({
              name: "pre-cleanup: DELETE canary-doc (existed from previous run)",
              status: "pass",
              durationMs: delResp.durationMs,
              detail: "Stale document cleaned up",
            });
          }
        }
      }
    }

    // Step 1: Create document
    const createResp = await http.post(
      DOCS_PATH,
      {
        title: "Canary Document",
        slug: DOC_SLUG,
        content: "This is a canary test document.",
        category: "canary",
        sort_order: 0,
        published: false,
      },
      "admin-key",
    );
    steps.push(
      stepFromResponse("POST /v1/management/documents (create document)", createResp, 201, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        if (!obj.id) return "Response missing 'id' field";
        if (obj.slug !== DOC_SLUG) return `slug mismatch: expected "${DOC_SLUG}", got "${obj.slug}"`;
        docId = String(obj.id);
        return null;
      }),
    );
    if (!docId) {
      return buildResult(steps, checkStart, "Cannot proceed without document ID");
    }

    // Step 2: Get document by ID
    const getResp = await http.get(`${DOCS_PATH}/${docId}`, "admin-key");
    steps.push(
      stepFromResponse(`GET /v1/management/documents/${docId} (get by ID)`, getResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        if (String(obj.id) !== docId) return `ID mismatch: expected ${docId}, got ${obj.id}`;
        if (obj.title !== "Canary Document") return `title mismatch: expected "Canary Document", got "${obj.title}"`;
        if (obj.slug !== DOC_SLUG) return `slug mismatch: expected "${DOC_SLUG}", got "${obj.slug}"`;
        return null;
      }),
    );

    // Step 3: Update document title
    const updateResp = await http.put(
      `${DOCS_PATH}/${docId}`,
      { title: "Canary Document Updated" },
      "admin-key",
    );
    steps.push(
      stepFromResponse(`PUT /v1/management/documents/${docId} (update title)`, updateResp, 200),
    );

    // Step 4: Verify update
    const verifyResp = await http.get(`${DOCS_PATH}/${docId}`, "admin-key");
    steps.push(
      stepFromResponse(`GET /v1/management/documents/${docId} (verify update)`, verifyResp, 200, (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        if (obj.title !== "Canary Document Updated") {
          return `title expected "Canary Document Updated", got "${obj.title}"`;
        }
        return null;
      }),
    );

    // Step 5: Delete document
    const deleteResp = await http.delete(`${DOCS_PATH}/${docId}`, "admin-key");
    steps.push(
      stepFromResponse(`DELETE /v1/management/documents/${docId} (delete)`, deleteResp, 204),
    );
    if (deleteResp.status === 204) {
      docId = null; // Already cleaned up
    }
  } catch (err: unknown) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // Cleanup: delete document if still exists
    if (docId) {
      try {
        const cleanupResp = await http.delete(`${DOCS_PATH}/${docId}`, "admin-key");
        steps.push(
          stepFromResponse(`DELETE /v1/management/documents/${docId} (cleanup)`, cleanupResp, [204, 404]),
        );
      } catch (cleanupErr: unknown) {
        steps.push({
          name: "cleanup: delete document",
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
    name: "documents",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg,
  };
}
