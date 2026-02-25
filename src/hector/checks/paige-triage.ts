/**
 * PAIGE Triage Check -- validates the work item search, creation with correct
 * item_type values, tags encoding, and dedup detection.
 *
 * Steps:
 *  1. Pre-cleanup: delete any stale "paige-triage-test" work items
 *  2. Create work item with valid item_type (feature_request) + tags
 *  3. Verify created item has correct tags (source:paige, route:/)
 *  4. Search by title keyword — should find the created item
 *  5. Search by non-existent term — should return empty
 *  6. Create second item with item_type=bug — verify DB accepts it
 *  7. Create third item with item_type=enhancement — verify DB accepts it
 *  8. Create fourth item with item_type=task — verify DB accepts it
 *  9. Cleanup: delete all test items
 */
import type { HttpClient, HttpResponse } from "../../canary/http";
import type { CheckResult, StepResult } from "../../canary/types";

const TEST_PREFIX = "paige-triage-test";

interface WorkItemData {
  id: string;
  title: string;
  status: string;
  item_type: string;
  priority: string;
  tags: string[];
  description: string | null;
}

function stepFromResponse(
  name: string,
  resp: HttpResponse,
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

export async function paigeTriageCheck(http: HttpClient): Promise<CheckResult> {
  const steps: StepResult[] = [];
  const checkStart = performance.now();
  const createdIds: string[] = [];

  try {
    // ─── Pre-cleanup: find and delete stale test items ────────────────
    const preList = await http.get<{ data: WorkItemData[] }>(
      `/v1/work-items?search=${encodeURIComponent(TEST_PREFIX)}&limit=50`,
      "admin-key",
    );
    if (preList.data && Array.isArray((preList.data as Record<string, unknown>).data)) {
      const items = (preList.data as { data: WorkItemData[] }).data;
      for (const item of items) {
        if (item.title.startsWith(TEST_PREFIX)) {
          const delResp = await http.delete(`/v1/work-items/${item.id}`, "admin-key");
          if (delResp.status === 204 || delResp.status === 200) {
            steps.push({
              name: `pre-cleanup: DELETE work item ${item.id}`,
              status: "pass",
              durationMs: delResp.durationMs,
              detail: `Cleaned up stale item: ${item.title}`,
            });
          }
        }
      }
    }

    // ─── Step 1: Create work item with feature_request + tags ─────────
    const createResp = await http.post<{ data: WorkItemData }>(
      "/v1/work-items",
      {
        title: `${TEST_PREFIX}: CSV export feature`,
        description: "User requested CSV export from the usage page",
        item_type: "feature_request",
        priority: "medium",
        tags: ["source:paige", "route:/usage"],
      },
      "admin-key",
    );
    steps.push(stepFromResponse("create work item (feature_request + tags)", createResp, 201, (d) => {
      const resp = d as { data?: WorkItemData };
      if (!resp?.data?.id) return "Missing id in response";
      if (resp.data.item_type !== "feature_request") return `Expected item_type=feature_request, got ${resp.data.item_type}`;
      if (resp.data.status !== "draft") return `Expected status=draft, got ${resp.data.status}`;
      return null;
    }));
    const item1Id = ((createResp.data as { data?: WorkItemData })?.data?.id) ?? null;
    if (item1Id) createdIds.push(item1Id);

    // ─── Step 2: Verify tags on created item ──────────────────────────
    if (item1Id) {
      const getResp = await http.get<{ data: WorkItemData }>(
        `/v1/work-items/${item1Id}`,
        "admin-key",
      );
      steps.push(stepFromResponse("verify tags on created item", getResp, 200, (d) => {
        const resp = d as { data?: WorkItemData };
        const tags = resp?.data?.tags ?? [];
        if (!tags.includes("source:paige")) return `Missing tag source:paige, got: ${JSON.stringify(tags)}`;
        if (!tags.includes("route:/usage")) return `Missing tag route:/usage, got: ${JSON.stringify(tags)}`;
        return null;
      }));
    }

    // ─── Step 3: Search by title keyword — should find it ─────────────
    const searchResp = await http.get<{ data: WorkItemData[] }>(
      `/v1/work-items?search=${encodeURIComponent("CSV export")}`,
      "admin-key",
    );
    steps.push(stepFromResponse("search by title keyword (should find)", searchResp, 200, (d) => {
      const resp = d as { data?: WorkItemData[] };
      const items = resp?.data ?? [];
      const found = items.some((i) => i.title.includes("CSV export"));
      if (!found) return `Search for "CSV export" returned ${items.length} items, none matching`;
      return null;
    }));

    // ─── Step 4: Search by non-existent term — should be empty ────────
    const emptySearchResp = await http.get<{ data: WorkItemData[] }>(
      `/v1/work-items?search=${encodeURIComponent("xyznonexistent99")}`,
      "admin-key",
    );
    steps.push(stepFromResponse("search non-existent term (should be empty)", emptySearchResp, 200, (d) => {
      const resp = d as { data?: WorkItemData[] };
      const items = resp?.data ?? [];
      if (items.length > 0) return `Expected 0 results, got ${items.length}`;
      return null;
    }));

    // ─── Step 5: Create with item_type=bug ────────────────────────────
    const bugResp = await http.post<{ data: WorkItemData }>(
      "/v1/work-items",
      {
        title: `${TEST_PREFIX}: Login page 500 error`,
        description: "Reproduce: go to login, submit empty form, see 500",
        item_type: "bug",
        priority: "high",
        tags: ["source:paige", "route:/login"],
      },
      "admin-key",
    );
    steps.push(stepFromResponse("create work item (bug)", bugResp, 201, (d) => {
      const resp = d as { data?: WorkItemData };
      if (resp?.data?.item_type !== "bug") return `Expected bug, got ${resp?.data?.item_type}`;
      return null;
    }));
    const item2Id = ((bugResp.data as { data?: WorkItemData })?.data?.id) ?? null;
    if (item2Id) createdIds.push(item2Id);

    // ─── Step 6: Create with item_type=enhancement ────────────────────
    const enhResp = await http.post<{ data: WorkItemData }>(
      "/v1/work-items",
      {
        title: `${TEST_PREFIX}: Better error messages in flows`,
        description: "Flow execution errors are too generic",
        item_type: "enhancement",
        priority: "low",
        tags: ["source:paige"],
      },
      "admin-key",
    );
    steps.push(stepFromResponse("create work item (enhancement)", enhResp, 201, (d) => {
      const resp = d as { data?: WorkItemData };
      if (resp?.data?.item_type !== "enhancement") return `Expected enhancement, got ${resp?.data?.item_type}`;
      return null;
    }));
    const item3Id = ((enhResp.data as { data?: WorkItemData })?.data?.id) ?? null;
    if (item3Id) createdIds.push(item3Id);

    // ─── Step 7: Create with item_type=task ───────────────────────────
    const taskResp = await http.post<{ data: WorkItemData }>(
      "/v1/work-items",
      {
        title: `${TEST_PREFIX}: Investigate slow queries`,
        description: "Dashboard load time increased this week",
        item_type: "task",
        priority: "medium",
        tags: ["source:paige", "route:/dashboard"],
      },
      "admin-key",
    );
    steps.push(stepFromResponse("create work item (task)", taskResp, 201, (d) => {
      const resp = d as { data?: WorkItemData };
      if (resp?.data?.item_type !== "task") return `Expected task, got ${resp?.data?.item_type}`;
      return null;
    }));
    const item4Id = ((taskResp.data as { data?: WorkItemData })?.data?.id) ?? null;
    if (item4Id) createdIds.push(item4Id);

    // ─── Step 8: Dedup search — should find multiple test items ───────
    const dedupResp = await http.get<{ data: WorkItemData[] }>(
      `/v1/work-items?search=${encodeURIComponent(TEST_PREFIX)}`,
      "admin-key",
    );
    steps.push(stepFromResponse("dedup search (should find all test items)", dedupResp, 200, (d) => {
      const resp = d as { data?: WorkItemData[] };
      const items = resp?.data ?? [];
      const testItems = items.filter((i) => i.title.startsWith(TEST_PREFIX));
      if (testItems.length < 4) return `Expected at least 4 test items, found ${testItems.length}`;
      return null;
    }));

    // ─── Step 9: Verify search matches description too ────────────────
    const descSearchResp = await http.get<{ data: WorkItemData[] }>(
      `/v1/work-items?search=${encodeURIComponent("empty form")}`,
      "admin-key",
    );
    steps.push(stepFromResponse("search by description text", descSearchResp, 200, (d) => {
      const resp = d as { data?: WorkItemData[] };
      const items = resp?.data ?? [];
      const found = items.some((i) => i.title.includes("Login page"));
      if (!found) return `Search in description for "empty form" didn't match the login bug item`;
      return null;
    }));

    // ─── Cleanup: delete all test items ───────────────────────────────
    for (const id of createdIds) {
      const delResp = await http.delete(`/v1/work-items/${id}`, "admin-key");
      steps.push(stepFromResponse(`cleanup: DELETE ${id}`, delResp, [200, 204]));
    }
  } catch (err: unknown) {
    steps.push({
      name: "unhandled error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const durationMs = Math.round(performance.now() - checkStart);
  let status: "pass" | "fail" = "pass";
  for (const step of steps) {
    if (step.status === "fail") {
      status = "fail";
      break;
    }
  }

  return { name: "paige-triage", status, durationMs, steps };
}
