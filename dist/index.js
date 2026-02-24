// @bun
// src/canary/http.ts
class HttpClient {
  baseUrl;
  apiKey;
  adminKey;
  timeoutMs;
  constructor(config) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.adminKey = config.adminKey;
    this.timeoutMs = config.timeoutMs ?? 1e4;
  }
  async request(method, path, options) {
    const auth = options?.auth ?? "none";
    const url = `${this.baseUrl}${path}`;
    const headers = {
      Accept: "application/json",
      ...options?.headers
    };
    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (auth === "api-key") {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    } else if (auth === "admin-key") {
      headers["x-api-key"] = this.adminKey;
    }
    const controller = new AbortController;
    const effectiveTimeout = options?.timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);
    const start = performance.now();
    let status = 0;
    let rawText = "";
    let data = null;
    let error;
    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      });
      status = resp.status;
      rawText = await resp.text();
      try {
        data = JSON.parse(rawText);
      } catch {}
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        error = `Request timed out after ${effectiveTimeout}ms`;
      } else if (err instanceof Error) {
        error = err.message;
      } else {
        error = String(err);
      }
    } finally {
      clearTimeout(timer);
    }
    const durationMs = Math.round(performance.now() - start);
    return { status, data, rawText, durationMs, error };
  }
  async get(path, auth = "none") {
    return this.request("GET", path, { auth });
  }
  async post(path, body, auth = "api-key") {
    return this.request("POST", path, { body, auth });
  }
  async put(path, body, auth = "api-key") {
    return this.request("PUT", path, { body, auth });
  }
  async patch(path, body, auth = "api-key") {
    return this.request("PATCH", path, { body, auth });
  }
  async delete(path, auth = "api-key") {
    return this.request("DELETE", path, { auth });
  }
}
function createHttpClient() {
  const baseUrl = process.env.KAPABLE_API_URL ?? "";
  const apiKey = process.env.KAPABLE_API_KEY ?? "";
  const adminKey = process.env.KAPABLE_ADMIN_KEY ?? "";
  if (!baseUrl) {
    console.warn("[tweety] WARNING: KAPABLE_API_URL is not set");
  }
  if (!apiKey) {
    console.warn("[tweety] WARNING: KAPABLE_API_KEY is not set");
  }
  if (!adminKey) {
    console.warn("[tweety] WARNING: KAPABLE_ADMIN_KEY is not set (needed for admin checks)");
  }
  return new HttpClient({ baseUrl, apiKey, adminKey });
}

// src/canary/checks/health.ts
async function healthCheck(http) {
  const steps = [];
  const checkStart = performance.now();
  const resp = await http.get("/health", "none");
  const step = {
    name: "GET /health",
    status: "pass",
    durationMs: resp.durationMs
  };
  if (resp.error) {
    step.status = "fail";
    step.error = resp.error;
  } else if (resp.status !== 200) {
    step.status = "fail";
    step.error = `Expected status 200, got ${resp.status}`;
    step.detail = resp.rawText.slice(0, 200);
  } else if (!resp.data) {
    step.status = "fail";
    step.error = "Response was not valid JSON";
    step.detail = resp.rawText.slice(0, 200);
  } else {
    const errors = [];
    if (resp.data.status !== "ok") {
      errors.push(`status="${resp.data.status}" (expected "ok")`);
    }
    if (resp.data.db !== undefined && resp.data.db !== "connected") {
      errors.push(`db="${resp.data.db}" (expected "connected")`);
    }
    if (errors.length > 0) {
      step.status = "fail";
      step.error = errors.join("; ");
    } else {
      step.detail = `status=${resp.data.status}, db=${resp.data.db ?? "not reported"}`;
    }
  }
  steps.push(step);
  const totalDuration = Math.round(performance.now() - checkStart);
  const hasFail = steps.some((s) => s.status === "fail");
  return {
    name: "health",
    status: hasFail ? "fail" : "pass",
    durationMs: totalDuration,
    steps
  };
}

// src/canary/checks/data-crud.ts
var TABLE_NAME = "canary_birds";
var TABLE_PATH = `/v1/${TABLE_NAME}`;
var META_PATH = `/v1/_meta/tables/${TABLE_NAME}`;
var TABLE_SCHEMA = {
  columns: [
    { name: "species", col_type: "text", nullable: true },
    { name: "spotted_at", col_type: "timestamp", nullable: true },
    { name: "count", col_type: "integer", nullable: true }
  ]
};
function makeRecord() {
  return {
    species: "Canary",
    spotted_at: new Date().toISOString(),
    count: 1
  };
}
function stepFromResponse(name, resp, expectedStatus, validate) {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const step = {
    name,
    status: "pass",
    durationMs: resp.durationMs
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
async function dataCrudCheck(http) {
  const steps = [];
  const checkStart = performance.now();
  let recordId = null;
  let hasFatalError = false;
  try {
    const preClean = await http.delete(META_PATH, "api-key");
    if (preClean.status === 200 || preClean.status === 204) {
      steps.push({
        name: "pre-cleanup: DROP canary_birds (existed from previous run)",
        status: "pass",
        durationMs: preClean.durationMs,
        detail: "Stale table cleaned up"
      });
    }
    const createTable = await http.put(META_PATH, TABLE_SCHEMA, "api-key");
    steps.push(stepFromResponse("PUT _meta/tables/canary_birds (create table)", createTable, [200, 201]));
    if (createTable.error || createTable.status !== 200 && createTable.status !== 201) {
      hasFatalError = true;
      return buildResult(steps, checkStart, "Cannot proceed without table");
    }
    const insertResp = await http.post(TABLE_PATH, makeRecord(), "api-key");
    steps.push(stepFromResponse("POST /v1/canary_birds (insert record)", insertResp, [200, 201], (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      if (!obj.id)
        return "Response missing 'id' field";
      recordId = String(obj.id);
      return null;
    }));
    if (!recordId) {
      hasFatalError = true;
    }
    if (recordId) {
      const listResp = await http.get(TABLE_PATH, "api-key");
      steps.push(stepFromResponse("GET /v1/canary_birds (list records)", listResp, 200, (data) => {
        if (!Array.isArray(data)) {
          const obj = data;
          const arr = obj?.data ?? obj?.rows ?? obj?.items;
          if (!Array.isArray(arr))
            return "Response is not an array and has no data/rows/items array";
          const found2 = arr.some((r) => String(r.id) === recordId);
          return found2 ? null : `Record ${recordId} not found in list`;
        }
        const found = data.some((r) => String(r.id) === recordId);
        return found ? null : `Record ${recordId} not found in list`;
      }));
    }
    if (recordId) {
      const getResp = await http.get(`${TABLE_PATH}/${recordId}`, "api-key");
      steps.push(stepFromResponse(`GET /v1/canary_birds/${recordId} (get by ID)`, getResp, 200, (data) => {
        if (!data || typeof data !== "object")
          return "Response is not an object";
        const obj = data;
        if (String(obj.id) !== recordId)
          return `ID mismatch: expected ${recordId}, got ${obj.id}`;
        if (obj.species !== "Canary")
          return `species mismatch: expected "Canary", got "${obj.species}"`;
        return null;
      }));
    }
    if (recordId) {
      const patchResp = await http.patch(`${TABLE_PATH}/${recordId}`, { count: 2 }, "api-key");
      steps.push(stepFromResponse(`PATCH /v1/canary_birds/${recordId} (update count)`, patchResp, 200));
    }
    if (recordId) {
      const verifyResp = await http.get(`${TABLE_PATH}/${recordId}`, "api-key");
      steps.push(stepFromResponse(`GET /v1/canary_birds/${recordId} (verify update)`, verifyResp, 200, (data) => {
        if (!data || typeof data !== "object")
          return "Response is not an object";
        const obj = data;
        if (Number(obj.count) !== 2)
          return `count expected 2, got ${obj.count}`;
        return null;
      }));
    }
    if (recordId) {
      const deleteResp = await http.delete(`${TABLE_PATH}/${recordId}`, "api-key");
      steps.push(stepFromResponse(`DELETE /v1/canary_birds/${recordId} (delete record)`, deleteResp, [200, 204]));
    }
  } catch (err) {
    hasFatalError = true;
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err)
    });
  } finally {
    try {
      const dropResp = await http.delete(META_PATH, "api-key");
      steps.push(stepFromResponse("DELETE _meta/tables/canary_birds (drop table)", dropResp, [200, 204, 404]));
    } catch (cleanupErr) {
      steps.push({
        name: "cleanup: drop table",
        status: "fail",
        durationMs: 0,
        error: `Cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
      });
    }
  }
  return buildResult(steps, checkStart, hasFatalError ? "Check encountered fatal error" : undefined);
}
function buildResult(steps, checkStart, errorMsg) {
  const totalDuration = Math.round(performance.now() - checkStart);
  let hasFail = false;
  let hasSkip = false;
  let hasPass = false;
  for (const step of steps) {
    if (step.status === "fail")
      hasFail = true;
    else if (step.status === "skip")
      hasSkip = true;
    else
      hasPass = true;
  }
  const status = hasFail ? "fail" : !hasPass && hasSkip ? "skip" : hasSkip ? "warn" : "pass";
  return {
    name: "data-crud",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg
  };
}

// src/canary/checks/toggles.ts
var FLAG_NAME = "canary-flag";
var TOGGLES_PATH = "/v1/feature-toggles";
function stepFromResponse2(name, resp, expectedStatus, validate) {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const step = {
    name,
    status: "pass",
    durationMs: resp.durationMs
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
async function togglesCheck(http) {
  const steps = [];
  const checkStart = performance.now();
  let flagCreated = false;
  try {
    const preClean = await http.delete(`${TOGGLES_PATH}/${FLAG_NAME}`, "admin-key");
    if (preClean.status === 200 || preClean.status === 204) {
      steps.push({
        name: "pre-cleanup: DELETE canary-flag (existed from previous run)",
        status: "pass",
        durationMs: preClean.durationMs,
        detail: "Stale flag cleaned up"
      });
    }
    const createResp = await http.post(TOGGLES_PATH, {
      name: FLAG_NAME,
      description: "Canary test toggle",
      enabled: true,
      default_value: true
    }, "admin-key");
    steps.push(stepFromResponse2("POST /v1/feature-toggles (create flag)", createResp, [200, 201]));
    if (createResp.status === 200 || createResp.status === 201) {
      flagCreated = true;
    } else {
      return buildResult2(steps, checkStart, "Cannot proceed without flag");
    }
    const getResp = await http.get(`${TOGGLES_PATH}/${FLAG_NAME}`, "admin-key");
    steps.push(stepFromResponse2(`GET /v1/feature-toggles/${FLAG_NAME} (verify created)`, getResp, 200, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      if (obj.name !== FLAG_NAME)
        return `name mismatch: expected "${FLAG_NAME}", got "${obj.name}"`;
      return null;
    }));
    const eval1Resp = await http.post(`${TOGGLES_PATH}/evaluate`, { flag_name: FLAG_NAME }, "admin-key");
    steps.push(stepFromResponse2("POST /v1/feature-toggles/evaluate (expect enabled)", eval1Resp, 200, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      if (obj.enabled !== true)
        return `enabled expected true, got ${obj.enabled}`;
      return null;
    }));
    const updateResp = await http.put(`${TOGGLES_PATH}/${FLAG_NAME}`, { enabled: false }, "admin-key");
    steps.push(stepFromResponse2(`PUT /v1/feature-toggles/${FLAG_NAME} (disable)`, updateResp, 200));
    const eval2Resp = await http.post(`${TOGGLES_PATH}/evaluate`, { flag_name: FLAG_NAME }, "admin-key");
    steps.push(stepFromResponse2("POST /v1/feature-toggles/evaluate (expect disabled)", eval2Resp, 200, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      if (obj.enabled !== false)
        return `enabled expected false, got ${obj.enabled}`;
      return null;
    }));
  } catch (err) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err)
    });
  } finally {
    if (flagCreated) {
      try {
        const deleteResp = await http.delete(`${TOGGLES_PATH}/${FLAG_NAME}`, "admin-key");
        steps.push(stepFromResponse2(`DELETE /v1/feature-toggles/${FLAG_NAME} (cleanup)`, deleteResp, [200, 204, 404]));
      } catch (cleanupErr) {
        steps.push({
          name: "cleanup: delete flag",
          status: "fail",
          durationMs: 0,
          error: `Cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
        });
      }
    }
  }
  return buildResult2(steps, checkStart);
}
function buildResult2(steps, checkStart, errorMsg) {
  const totalDuration = Math.round(performance.now() - checkStart);
  let hasFail = false;
  let hasSkip = false;
  let hasPass = false;
  for (const step of steps) {
    if (step.status === "fail")
      hasFail = true;
    else if (step.status === "skip")
      hasSkip = true;
    else
      hasPass = true;
  }
  const status = hasFail ? "fail" : !hasPass && hasSkip ? "skip" : hasSkip ? "warn" : "pass";
  return {
    name: "toggles",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg
  };
}

// src/canary/checks/tokens.ts
var TOKENS_PATH = "/v1/tokens";
function stepFromResponse3(name, resp, expectedStatus, validate) {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const step = {
    name,
    status: "pass",
    durationMs: resp.durationMs
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
async function tokensCheck(http) {
  const steps = [];
  const checkStart = performance.now();
  let tokenJti = null;
  try {
    const createResp = await http.post(TOKENS_PATH, {
      sub: "canary-user",
      scopes: { role: "tester" },
      ttl_seconds: 300
    }, "api-key");
    steps.push(stepFromResponse3("POST /v1/tokens (create token)", createResp, [200, 201], (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      const jti = obj.jti ?? obj.id ?? obj.token?.jti;
      if (!jti)
        return "Response missing 'jti' or 'id' field";
      tokenJti = String(jti);
      return null;
    }));
    if (!tokenJti) {
      return buildResult3(steps, checkStart, "Cannot proceed without token jti");
    }
    const listResp = await http.get(TOKENS_PATH, "api-key");
    steps.push(stepFromResponse3("GET /v1/tokens (list tokens)", listResp, 200, (data) => {
      let tokens = [];
      if (Array.isArray(data)) {
        tokens = data;
      } else if (data && typeof data === "object") {
        const obj = data;
        const arr = obj.data ?? obj.tokens ?? obj.items;
        if (Array.isArray(arr)) {
          tokens = arr;
        }
      }
      if (tokens.length === 0) {
        return "Token list is empty -- expected at least 1 token";
      }
      let found = false;
      for (const t of tokens) {
        const tok = t;
        if (String(tok.jti) === tokenJti || String(tok.id) === tokenJti) {
          found = true;
          break;
        }
      }
      return found ? null : `Token with jti=${tokenJti} not found in list`;
    }));
    const revokeResp = await http.delete(`${TOKENS_PATH}/${tokenJti}`, "api-key");
    steps.push(stepFromResponse3(`DELETE /v1/tokens/${tokenJti} (revoke)`, revokeResp, [200, 204]));
    const verifyResp = await http.get(TOKENS_PATH, "api-key");
    steps.push(stepFromResponse3("GET /v1/tokens (verify revoked)", verifyResp, 200, (data) => {
      let tokens = [];
      if (Array.isArray(data)) {
        tokens = data;
      } else if (data && typeof data === "object") {
        const obj = data;
        const arr = obj.data ?? obj.tokens ?? obj.items;
        if (Array.isArray(arr)) {
          tokens = arr;
        }
      }
      for (const t of tokens) {
        const tok = t;
        const matchesJti = String(tok.jti) === tokenJti || String(tok.id) === tokenJti;
        if (matchesJti) {
          if (tok.revoked_at != null || tok.revoked === true || tok.status === "revoked") {
            return null;
          }
          return `Token ${tokenJti} still appears in list and is not marked revoked`;
        }
      }
      return null;
    }));
  } catch (err) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err)
    });
    if (tokenJti) {
      try {
        await http.delete(`${TOKENS_PATH}/${tokenJti}`, "api-key");
      } catch {}
    }
  }
  return buildResult3(steps, checkStart);
}
function buildResult3(steps, checkStart, errorMsg) {
  const totalDuration = Math.round(performance.now() - checkStart);
  let hasFail = false;
  let hasSkip = false;
  let hasPass = false;
  for (const step of steps) {
    if (step.status === "fail")
      hasFail = true;
    else if (step.status === "skip")
      hasSkip = true;
    else
      hasPass = true;
  }
  const status = hasFail ? "fail" : !hasPass && hasSkip ? "skip" : hasSkip ? "warn" : "pass";
  return {
    name: "tokens",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg
  };
}

// src/canary/checks/secrets.ts
var SECRET_NAME = "canary-secret";
var SECRETS_PATH = "/v1/management/secrets";
function stepFromResponse4(name, resp, expectedStatus, validate) {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const step = {
    name,
    status: "pass",
    durationMs: resp.durationMs
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
async function secretsCheck(http) {
  const steps = [];
  const checkStart = performance.now();
  let secretCreated = false;
  try {
    const preClean = await http.delete(`${SECRETS_PATH}/${SECRET_NAME}`, "admin-key");
    if (preClean.status === 200 || preClean.status === 204) {
      steps.push({
        name: "pre-cleanup: DELETE canary-secret (existed from previous run)",
        status: "pass",
        durationMs: preClean.durationMs,
        detail: "Stale secret cleaned up"
      });
    }
    const createResp = await http.post(SECRETS_PATH, {
      name: SECRET_NAME,
      value: "canary-secret-value-12345",
      description: "Canary test secret"
    }, "admin-key");
    steps.push(stepFromResponse4("POST /v1/management/secrets (create secret)", createResp, 201, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      if (!obj.id)
        return "Response missing 'id' field";
      if (obj.name !== SECRET_NAME)
        return `name mismatch: expected "${SECRET_NAME}", got "${obj.name}"`;
      return null;
    }));
    if (createResp.status === 201) {
      secretCreated = true;
    } else {
      return buildResult4(steps, checkStart, "Cannot proceed without secret");
    }
    const getResp = await http.get(`${SECRETS_PATH}/${SECRET_NAME}`, "admin-key");
    steps.push(stepFromResponse4(`GET /v1/management/secrets/${SECRET_NAME} (get decrypted)`, getResp, 200, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      if (obj.name !== SECRET_NAME)
        return `name mismatch: expected "${SECRET_NAME}", got "${obj.name}"`;
      if (obj.value !== "canary-secret-value-12345") {
        return `value mismatch: expected "canary-secret-value-12345", got "${obj.value}"`;
      }
      return null;
    }));
    const listResp = await http.get(SECRETS_PATH, "admin-key");
    steps.push(stepFromResponse4("GET /v1/management/secrets (list secrets)", listResp, 200, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      const arr = obj.data;
      if (!Array.isArray(arr))
        return "Response missing 'data' array";
      let found = false;
      for (const item of arr) {
        const s = item;
        if (s.name === SECRET_NAME) {
          found = true;
          break;
        }
      }
      return found ? null : `Secret "${SECRET_NAME}" not found in list`;
    }));
    const deleteResp = await http.delete(`${SECRETS_PATH}/${SECRET_NAME}`, "admin-key");
    steps.push(stepFromResponse4(`DELETE /v1/management/secrets/${SECRET_NAME} (delete)`, deleteResp, 204));
    if (deleteResp.status === 204) {
      secretCreated = false;
    }
    const verifyResp = await http.get(`${SECRETS_PATH}/${SECRET_NAME}`, "admin-key");
    steps.push(stepFromResponse4(`GET /v1/management/secrets/${SECRET_NAME} (verify gone)`, verifyResp, 404));
  } catch (err) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err)
    });
  } finally {
    if (secretCreated) {
      try {
        const cleanupResp = await http.delete(`${SECRETS_PATH}/${SECRET_NAME}`, "admin-key");
        steps.push(stepFromResponse4(`DELETE /v1/management/secrets/${SECRET_NAME} (cleanup)`, cleanupResp, [204, 404]));
      } catch (cleanupErr) {
        steps.push({
          name: "cleanup: delete secret",
          status: "fail",
          durationMs: 0,
          error: `Cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
        });
      }
    }
  }
  return buildResult4(steps, checkStart);
}
function buildResult4(steps, checkStart, errorMsg) {
  const totalDuration = Math.round(performance.now() - checkStart);
  let hasFail = false;
  let hasSkip = false;
  let hasPass = false;
  for (const step of steps) {
    if (step.status === "fail")
      hasFail = true;
    else if (step.status === "skip")
      hasSkip = true;
    else
      hasPass = true;
  }
  const status = hasFail ? "fail" : !hasPass && hasSkip ? "skip" : hasSkip ? "warn" : "pass";
  return {
    name: "secrets",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg
  };
}

// src/canary/checks/documents.ts
var DOC_SLUG = "canary-doc";
var DOCS_PATH = "/v1/management/documents";
function stepFromResponse5(name, resp, expectedStatus, validate) {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const step = {
    name,
    status: "pass",
    durationMs: resp.durationMs
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
async function documentsCheck(http) {
  const steps = [];
  const checkStart = performance.now();
  let docId = null;
  try {
    const preList = await http.get(DOCS_PATH, "admin-key");
    if (preList.data && typeof preList.data === "object") {
      const listObj = preList.data;
      const items = Array.isArray(listObj.data) ? listObj.data : Array.isArray(preList.data) ? preList.data : [];
      for (const item of items) {
        const doc = item;
        if (doc.slug === DOC_SLUG && doc.id) {
          const delResp = await http.delete(`${DOCS_PATH}/${doc.id}`, "admin-key");
          if (delResp.status === 204 || delResp.status === 200) {
            steps.push({
              name: "pre-cleanup: DELETE canary-doc (existed from previous run)",
              status: "pass",
              durationMs: delResp.durationMs,
              detail: "Stale document cleaned up"
            });
          }
        }
      }
    }
    const createResp = await http.post(DOCS_PATH, {
      title: "Canary Document",
      slug: DOC_SLUG,
      content: "This is a canary test document.",
      category: "canary",
      sort_order: 0,
      published: false
    }, "admin-key");
    steps.push(stepFromResponse5("POST /v1/management/documents (create document)", createResp, 201, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      if (!obj.id)
        return "Response missing 'id' field";
      if (obj.slug !== DOC_SLUG)
        return `slug mismatch: expected "${DOC_SLUG}", got "${obj.slug}"`;
      docId = String(obj.id);
      return null;
    }));
    if (!docId) {
      return buildResult5(steps, checkStart, "Cannot proceed without document ID");
    }
    const getResp = await http.get(`${DOCS_PATH}/${docId}`, "admin-key");
    steps.push(stepFromResponse5(`GET /v1/management/documents/${docId} (get by ID)`, getResp, 200, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      if (String(obj.id) !== docId)
        return `ID mismatch: expected ${docId}, got ${obj.id}`;
      if (obj.title !== "Canary Document")
        return `title mismatch: expected "Canary Document", got "${obj.title}"`;
      if (obj.slug !== DOC_SLUG)
        return `slug mismatch: expected "${DOC_SLUG}", got "${obj.slug}"`;
      return null;
    }));
    const updateResp = await http.put(`${DOCS_PATH}/${docId}`, { title: "Canary Document Updated" }, "admin-key");
    steps.push(stepFromResponse5(`PUT /v1/management/documents/${docId} (update title)`, updateResp, 200));
    const verifyResp = await http.get(`${DOCS_PATH}/${docId}`, "admin-key");
    steps.push(stepFromResponse5(`GET /v1/management/documents/${docId} (verify update)`, verifyResp, 200, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      if (obj.title !== "Canary Document Updated") {
        return `title expected "Canary Document Updated", got "${obj.title}"`;
      }
      return null;
    }));
    const deleteResp = await http.delete(`${DOCS_PATH}/${docId}`, "admin-key");
    steps.push(stepFromResponse5(`DELETE /v1/management/documents/${docId} (delete)`, deleteResp, 204));
    if (deleteResp.status === 204) {
      docId = null;
    }
  } catch (err) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err)
    });
  } finally {
    if (docId) {
      try {
        const cleanupResp = await http.delete(`${DOCS_PATH}/${docId}`, "admin-key");
        steps.push(stepFromResponse5(`DELETE /v1/management/documents/${docId} (cleanup)`, cleanupResp, [204, 404]));
      } catch (cleanupErr) {
        steps.push({
          name: "cleanup: delete document",
          status: "fail",
          durationMs: 0,
          error: `Cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
        });
      }
    }
  }
  return buildResult5(steps, checkStart);
}
function buildResult5(steps, checkStart, errorMsg) {
  const totalDuration = Math.round(performance.now() - checkStart);
  let hasFail = false;
  let hasSkip = false;
  let hasPass = false;
  for (const step of steps) {
    if (step.status === "fail")
      hasFail = true;
    else if (step.status === "skip")
      hasSkip = true;
    else
      hasPass = true;
  }
  const status = hasFail ? "fail" : !hasPass && hasSkip ? "skip" : hasSkip ? "warn" : "pass";
  return {
    name: "documents",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg
  };
}

// src/canary/checks/webhooks.ts
var CANARY_WEBHOOK_URL = "https://example.com/canary-webhook";
function stepFromResponse6(name, resp, expectedStatus, validate) {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const step = {
    name,
    status: "pass",
    durationMs: resp.durationMs
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
async function webhooksCheck(http) {
  const projectId = process.env.KAPABLE_PROJECT_ID ?? "";
  if (!projectId) {
    return {
      name: "webhooks",
      status: "skip",
      durationMs: 0,
      steps: [{
        name: "KAPABLE_PROJECT_ID not set",
        status: "skip",
        durationMs: 0,
        detail: "Webhooks check requires KAPABLE_PROJECT_ID env var"
      }]
    };
  }
  const webhooksPath = `/v1/projects/${projectId}/webhooks`;
  const steps = [];
  const checkStart = performance.now();
  let webhookId = null;
  try {
    const preList = await http.get(webhooksPath, "admin-key");
    if (preList.data && typeof preList.data === "object") {
      const listObj = preList.data;
      const items = Array.isArray(listObj.data) ? listObj.data : Array.isArray(preList.data) ? preList.data : [];
      for (const item of items) {
        const wh = item;
        if (wh.url === CANARY_WEBHOOK_URL && wh.id) {
          const delResp = await http.delete(`${webhooksPath}/${wh.id}`, "admin-key");
          if (delResp.status === 204 || delResp.status === 200) {
            steps.push({
              name: "pre-cleanup: DELETE canary webhook (existed from previous run)",
              status: "pass",
              durationMs: delResp.durationMs,
              detail: "Stale webhook cleaned up"
            });
          }
        }
      }
    }
    const createResp = await http.post(webhooksPath, {
      url: CANARY_WEBHOOK_URL,
      description: "Canary test webhook",
      enabled: true,
      events: ["insert", "update"]
    }, "admin-key");
    steps.push(stepFromResponse6("POST /v1/projects/{pid}/webhooks (create webhook)", createResp, 201, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      const inner = obj.data ?? obj;
      if (!inner || typeof inner !== "object")
        return "Response missing 'data' wrapper";
      const webhook = inner;
      if (!webhook.id)
        return "Response missing 'id' field";
      if (webhook.url !== CANARY_WEBHOOK_URL) {
        return `url mismatch: expected "${CANARY_WEBHOOK_URL}", got "${webhook.url}"`;
      }
      webhookId = String(webhook.id);
      return null;
    }));
    if (!webhookId) {
      return buildResult6(steps, checkStart, "Cannot proceed without webhook ID");
    }
    const getResp = await http.get(`${webhooksPath}/${webhookId}`, "admin-key");
    steps.push(stepFromResponse6(`GET /v1/projects/{pid}/webhooks/${webhookId} (get by ID)`, getResp, 200, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      const inner = obj.data ?? obj;
      if (!inner || typeof inner !== "object")
        return "Response missing 'data' wrapper";
      const webhook = inner;
      if (String(webhook.id) !== webhookId) {
        return `ID mismatch: expected ${webhookId}, got ${webhook.id}`;
      }
      if (webhook.url !== CANARY_WEBHOOK_URL) {
        return `url mismatch: expected "${CANARY_WEBHOOK_URL}", got "${webhook.url}"`;
      }
      return null;
    }));
    const deleteResp = await http.delete(`${webhooksPath}/${webhookId}`, "admin-key");
    steps.push(stepFromResponse6(`DELETE /v1/projects/{pid}/webhooks/${webhookId} (delete)`, deleteResp, 204));
    if (deleteResp.status === 204) {
      webhookId = null;
    }
  } catch (err) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err)
    });
  } finally {
    if (webhookId) {
      try {
        const cleanupResp = await http.delete(`${webhooksPath}/${webhookId}`, "admin-key");
        steps.push(stepFromResponse6(`DELETE /v1/projects/{pid}/webhooks/${webhookId} (cleanup)`, cleanupResp, [204, 404]));
      } catch (cleanupErr) {
        steps.push({
          name: "cleanup: delete webhook",
          status: "fail",
          durationMs: 0,
          error: `Cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
        });
      }
    }
  }
  return buildResult6(steps, checkStart);
}
function buildResult6(steps, checkStart, errorMsg) {
  const totalDuration = Math.round(performance.now() - checkStart);
  let hasFail = false;
  let hasSkip = false;
  let hasPass = false;
  for (const step of steps) {
    if (step.status === "fail")
      hasFail = true;
    else if (step.status === "skip")
      hasSkip = true;
    else
      hasPass = true;
  }
  const status = hasFail ? "fail" : !hasPass && hasSkip ? "skip" : hasSkip ? "warn" : "pass";
  return {
    name: "webhooks",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg
  };
}

// src/canary/checks/schedules.ts
var SCHEDULE_NAME = "canary-schedule";
function stepFromResponse7(name, resp, expectedStatus, validate) {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const step = {
    name,
    status: "pass",
    durationMs: resp.durationMs
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
async function schedulesCheck(http) {
  const appId = process.env.KAPABLE_APP_ID ?? "";
  const envName = process.env.KAPABLE_ENV_NAME ?? "production";
  if (!appId) {
    return {
      name: "schedules",
      status: "skip",
      durationMs: 0,
      steps: [{
        name: "KAPABLE_APP_ID not set",
        status: "skip",
        durationMs: 0,
        detail: "Schedules check requires KAPABLE_APP_ID env var"
      }]
    };
  }
  const schedulesPath = `/v1/apps/${appId}/environments/${envName}/schedules`;
  const steps = [];
  const checkStart = performance.now();
  let scheduleId = null;
  try {
    const preList = await http.get(schedulesPath, "admin-key");
    if (preList.data && typeof preList.data === "object") {
      const listObj = preList.data;
      const items = Array.isArray(listObj.data) ? listObj.data : Array.isArray(preList.data) ? preList.data : [];
      for (const item of items) {
        const sched = item;
        if (sched.name === SCHEDULE_NAME && sched.id) {
          const delResp = await http.delete(`${schedulesPath}/${sched.id}`, "admin-key");
          if (delResp.status === 204 || delResp.status === 200) {
            steps.push({
              name: "pre-cleanup: DELETE canary-schedule (existed from previous run)",
              status: "pass",
              durationMs: delResp.durationMs,
              detail: "Stale schedule cleaned up"
            });
          }
        }
      }
    }
    const createResp = await http.post(schedulesPath, {
      name: SCHEDULE_NAME,
      cron_expression: "0 * * * *",
      action_type: "webhook",
      action_config: { url: "https://example.com/canary-cron" },
      enabled: false,
      description: "Canary test schedule"
    }, "admin-key");
    steps.push(stepFromResponse7("POST .../schedules (create schedule)", createResp, 201, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      const inner = obj.data ?? obj;
      if (!inner || typeof inner !== "object")
        return "Response missing 'data' wrapper";
      const schedule = inner;
      if (!schedule.id)
        return "Response missing 'id' field";
      if (schedule.name !== SCHEDULE_NAME) {
        return `name mismatch: expected "${SCHEDULE_NAME}", got "${schedule.name}"`;
      }
      scheduleId = String(schedule.id);
      return null;
    }));
    if (!scheduleId) {
      return buildResult7(steps, checkStart, "Cannot proceed without schedule ID");
    }
    const getResp = await http.get(`${schedulesPath}/${scheduleId}`, "admin-key");
    steps.push(stepFromResponse7(`GET .../schedules/${scheduleId} (verify fields)`, getResp, 200, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      const inner = obj.data ?? obj;
      if (!inner || typeof inner !== "object")
        return "Response missing 'data' wrapper";
      const schedule = inner;
      if (String(schedule.id) !== scheduleId) {
        return `ID mismatch: expected ${scheduleId}, got ${schedule.id}`;
      }
      if (schedule.name !== SCHEDULE_NAME) {
        return `name mismatch: expected "${SCHEDULE_NAME}", got "${schedule.name}"`;
      }
      if (schedule.cron_expression !== "0 * * * *") {
        return `cron_expression mismatch: expected "0 * * * *", got "${schedule.cron_expression}"`;
      }
      if (schedule.enabled !== false) {
        return `enabled expected false, got ${schedule.enabled}`;
      }
      if (schedule.action_type !== "webhook") {
        return `action_type mismatch: expected "webhook", got "${schedule.action_type}"`;
      }
      return null;
    }));
    const deleteResp = await http.delete(`${schedulesPath}/${scheduleId}`, "admin-key");
    steps.push(stepFromResponse7(`DELETE .../schedules/${scheduleId} (delete)`, deleteResp, 204));
    if (deleteResp.status === 204) {
      scheduleId = null;
    }
  } catch (err) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err)
    });
  } finally {
    if (scheduleId) {
      try {
        const cleanupResp = await http.delete(`${schedulesPath}/${scheduleId}`, "admin-key");
        steps.push(stepFromResponse7(`DELETE .../schedules/${scheduleId} (cleanup)`, cleanupResp, [204, 404]));
      } catch (cleanupErr) {
        steps.push({
          name: "cleanup: delete schedule",
          status: "fail",
          durationMs: 0,
          error: `Cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
        });
      }
    }
  }
  return buildResult7(steps, checkStart);
}
function buildResult7(steps, checkStart, errorMsg) {
  const totalDuration = Math.round(performance.now() - checkStart);
  let hasFail = false;
  let hasSkip = false;
  let hasPass = false;
  for (const step of steps) {
    if (step.status === "fail")
      hasFail = true;
    else if (step.status === "skip")
      hasSkip = true;
    else
      hasPass = true;
  }
  const status = hasFail ? "fail" : !hasPass && hasSkip ? "skip" : hasSkip ? "warn" : "pass";
  return {
    name: "schedules",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg
  };
}

// src/canary/checks/ai-chat.ts
function stepFromResponse8(name, resp, expectedStatus, validate) {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const step = {
    name,
    status: "pass",
    durationMs: resp.durationMs
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
async function aiChatCheck(http) {
  const steps = [];
  const checkStart = performance.now();
  try {
    const statusResp = await http.get("/v1/ai/status", "admin-key");
    if (statusResp.status === 503) {
      steps.push({
        name: "GET /v1/ai/status (check configured)",
        status: "skip",
        durationMs: statusResp.durationMs,
        detail: "AI service not configured (503), skipping check"
      });
      return buildResult8(steps, checkStart);
    }
    steps.push(stepFromResponse8("GET /v1/ai/status (check configured)", statusResp, 200, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      if (obj.configured !== true)
        return `configured expected true, got ${obj.configured}`;
      return null;
    }));
    if (steps[steps.length - 1].status === "fail") {
      return buildResult8(steps, checkStart, "AI status check failed");
    }
    const statusData = statusResp.data;
    const provider = statusData?.provider ?? "unknown";
    const model = statusData?.model ?? "unknown";
    if (steps[steps.length - 1].status === "pass") {
      steps[steps.length - 1].detail = `provider=${provider}, model=${model}`;
    }
    const chatResp = await http.request("POST", "/v1/ai/chat", {
      body: {
        messages: [{ role: "user", content: "Reply with exactly: CANARY_OK" }],
        max_tokens: 50,
        temperature: 0
      },
      auth: "admin-key"
    });
    if (chatResp.status === 402) {
      steps.push({
        name: "POST /v1/ai/chat (1-turn canary prompt)",
        status: "skip",
        durationMs: chatResp.durationMs,
        detail: "AI quota exceeded (402), check skipped"
      });
      return buildResult8(steps, checkStart);
    }
    if (chatResp.status === 503) {
      steps.push({
        name: "POST /v1/ai/chat (1-turn canary prompt)",
        status: "skip",
        durationMs: chatResp.durationMs,
        detail: "AI service unavailable (503), check skipped"
      });
      return buildResult8(steps, checkStart);
    }
    steps.push(stepFromResponse8("POST /v1/ai/chat (1-turn canary prompt)", chatResp, 200, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      const content = extractChatContent(obj);
      if (!content || content.trim().length === 0) {
        return "Chat response contained no text content";
      }
      return null;
    }));
    const lastStep = steps[steps.length - 1];
    if (lastStep.status === "pass" && chatResp.data) {
      const content = extractChatContent(chatResp.data);
      if (content) {
        lastStep.detail = `response="${content.slice(0, 100)}"`;
      }
    }
  } catch (err) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return buildResult8(steps, checkStart);
}
function extractChatContent(obj) {
  if (typeof obj.text === "string")
    return obj.text;
  if (typeof obj.content === "string")
    return obj.content;
  if (typeof obj.response === "string")
    return obj.response;
  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const choice = obj.choices[0];
    if (choice.message && typeof choice.message === "object") {
      const msg = choice.message;
      if (typeof msg.content === "string")
        return msg.content;
    }
    if (typeof choice.text === "string")
      return choice.text;
  }
  if (obj.message && typeof obj.message === "object") {
    const msg = obj.message;
    if (typeof msg.content === "string")
      return msg.content;
  }
  return null;
}
function buildResult8(steps, checkStart, errorMsg) {
  const totalDuration = Math.round(performance.now() - checkStart);
  let hasFail = false;
  let hasSkip = false;
  let hasPass = false;
  for (const step of steps) {
    if (step.status === "fail")
      hasFail = true;
    else if (step.status === "skip")
      hasSkip = true;
    else
      hasPass = true;
  }
  const status = hasFail ? "fail" : !hasPass && hasSkip ? "skip" : hasSkip ? "warn" : "pass";
  return {
    name: "ai-chat",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg
  };
}

// src/canary/checks/ai-image.ts
function stepFromResponse9(name, resp, expectedStatus, validate) {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const step = {
    name,
    status: "pass",
    durationMs: resp.durationMs
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
async function aiImageCheck(http) {
  const steps = [];
  const checkStart = performance.now();
  try {
    const statusResp = await http.get("/v1/images/status", "admin-key");
    if (statusResp.status === 503) {
      steps.push({
        name: "GET /v1/images/status (check configured)",
        status: "skip",
        durationMs: statusResp.durationMs,
        detail: "Image service not configured (503), skipping check"
      });
      return buildResult9(steps, checkStart);
    }
    steps.push(stepFromResponse9("GET /v1/images/status (check configured)", statusResp, 200, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      if (obj.configured !== true)
        return `configured expected true, got ${obj.configured}`;
      return null;
    }));
    if (steps[steps.length - 1].status === "fail") {
      return buildResult9(steps, checkStart, "Image status check failed");
    }
    const statusData = statusResp.data;
    const provider = statusData?.provider ?? "unknown";
    if (steps[steps.length - 1].status === "pass") {
      steps[steps.length - 1].detail = `provider=${provider}`;
    }
    const usageResp = await http.get("/v1/images/usage", "admin-key");
    steps.push(stepFromResponse9("GET /v1/images/usage (verify structure)", usageResp, 200, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      const errors = [];
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
    }));
    const lastStep = steps[steps.length - 1];
    if (lastStep.status === "pass" && usageResp.data) {
      const usage = usageResp.data;
      lastStep.detail = `generated=${usage.generated}, quota=${usage.quota}, remaining=${usage.remaining}, month=${usage.month}`;
    }
  } catch (err) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return buildResult9(steps, checkStart);
}
function buildResult9(steps, checkStart, errorMsg) {
  const totalDuration = Math.round(performance.now() - checkStart);
  let hasFail = false;
  let hasSkip = false;
  let hasPass = false;
  for (const step of steps) {
    if (step.status === "fail")
      hasFail = true;
    else if (step.status === "skip")
      hasSkip = true;
    else
      hasPass = true;
  }
  const status = hasFail ? "fail" : !hasPass && hasSkip ? "skip" : hasSkip ? "warn" : "pass";
  return {
    name: "ai-image",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg
  };
}

// src/canary/checks/ai-voice.ts
function stepFromResponse10(name, resp, expectedStatus, validate) {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const step = {
    name,
    status: "pass",
    durationMs: resp.durationMs
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
async function aiVoiceCheck(http) {
  const steps = [];
  const checkStart = performance.now();
  try {
    const statusResp = await http.get("/v1/voice/status", "admin-key");
    if (statusResp.status === 503) {
      steps.push({
        name: "GET /v1/voice/status (check configured)",
        status: "skip",
        durationMs: statusResp.durationMs,
        detail: "Voice service not configured (503), skipping check"
      });
      return buildResult10(steps, checkStart);
    }
    steps.push(stepFromResponse10("GET /v1/voice/status (check configured)", statusResp, 200, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      if (obj.configured !== true)
        return `configured expected true, got ${obj.configured}`;
      return null;
    }));
    if (steps[steps.length - 1].status === "fail") {
      return buildResult10(steps, checkStart, "Voice status check failed");
    }
    const statusData = statusResp.data;
    const provider = statusData?.provider ?? "unknown";
    if (steps[steps.length - 1].status === "pass") {
      steps[steps.length - 1].detail = `provider=${provider}`;
    }
    const voicesResp = await http.get("/v1/voice/voices", "admin-key");
    if (voicesResp.status === 500) {
      steps.push({
        name: "GET /v1/voice/voices (list voices)",
        status: "skip",
        durationMs: voicesResp.durationMs,
        detail: `External voice provider error (500), skipping: ${voicesResp.rawText.slice(0, 200)}`
      });
    } else {
      steps.push(stepFromResponse10("GET /v1/voice/voices (list voices)", voicesResp, 200, (data) => {
        if (!Array.isArray(data)) {
          if (data && typeof data === "object") {
            const obj = data;
            const arr = obj.data ?? obj.voices ?? obj.items;
            if (Array.isArray(arr)) {
              if (arr.length === 0) {
                return null;
              }
              return null;
            }
          }
          return "Response is not an array and has no data/voices/items array";
        }
        return null;
      }));
      const voicesStep = steps[steps.length - 1];
      if (voicesStep.status === "pass" && voicesResp.data) {
        const voiceCount = getArrayLength(voicesResp.data);
        if (voiceCount === 0) {
          voicesStep.detail = "WARNING: voice list is empty (ElevenLabs may have issues)";
        } else {
          voicesStep.detail = `${voiceCount} voices available`;
        }
      }
    }
    const usageResp = await http.get("/v1/voice/usage", "admin-key");
    steps.push(stepFromResponse10("GET /v1/voice/usage (verify structure)", usageResp, 200, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      const errors = [];
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
    }));
    const usageStep = steps[steps.length - 1];
    if (usageStep.status === "pass" && usageResp.data) {
      const usage = usageResp.data;
      usageStep.detail = `characters_used=${usage.characters_used}, quota=${usage.quota}, remaining=${usage.remaining}, month=${usage.month}`;
    }
  } catch (err) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return buildResult10(steps, checkStart);
}
function getArrayLength(data) {
  if (Array.isArray(data))
    return data.length;
  if (data && typeof data === "object") {
    const obj = data;
    const arr = obj.data ?? obj.voices ?? obj.items;
    if (Array.isArray(arr))
      return arr.length;
  }
  return 0;
}
function buildResult10(steps, checkStart, errorMsg) {
  const totalDuration = Math.round(performance.now() - checkStart);
  let hasFail = false;
  let hasSkip = false;
  let hasPass = false;
  for (const step of steps) {
    if (step.status === "fail")
      hasFail = true;
    else if (step.status === "skip")
      hasSkip = true;
    else
      hasPass = true;
  }
  const status = hasFail ? "fail" : !hasPass && hasSkip ? "skip" : hasSkip ? "warn" : "pass";
  return {
    name: "ai-voice",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg
  };
}

// src/canary/checks/audit-logs.ts
var AUDIT_PATH = "/v1/management/audit-logs";
function stepFromResponse11(name, resp, expectedStatus, validate) {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const step = {
    name,
    status: "pass",
    durationMs: resp.durationMs
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
async function auditLogsCheck(http) {
  const steps = [];
  const checkStart = performance.now();
  try {
    const listResp = await http.get(`${AUDIT_PATH}?limit=5`, "admin-key");
    steps.push(stepFromResponse11("GET /v1/management/audit-logs?limit=5 (list recent)", listResp, 200, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      if (!Array.isArray(obj.data)) {
        return `Expected 'data' to be an array, got ${typeof obj.data}`;
      }
      const pagination = obj.pagination;
      if (!pagination || typeof pagination !== "object") {
        return "Response missing 'pagination' object";
      }
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
    }));
    const listData = listResp.data;
    const entries = listData?.data;
    if (entries && entries.length > 0) {
      const entry = entries[0];
      const structureStep = {
        name: "Verify audit log entry structure",
        status: "pass",
        durationMs: 0
      };
      const requiredFields = ["id", "action", "resource_type", "created_at"];
      const missingFields = [];
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
      steps.push({
        name: "Verify audit log entry structure",
        status: "pass",
        durationMs: 0,
        detail: "No audit log entries found (empty data array -- acceptable)"
      });
    }
  } catch (err) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return buildResult11(steps, checkStart);
}
function buildResult11(steps, checkStart, errorMsg) {
  const totalDuration = Math.round(performance.now() - checkStart);
  let hasFail = false;
  let hasSkip = false;
  let hasPass = false;
  for (const step of steps) {
    if (step.status === "fail")
      hasFail = true;
    else if (step.status === "skip")
      hasSkip = true;
    else
      hasPass = true;
  }
  const status = hasFail ? "fail" : !hasPass && hasSkip ? "skip" : hasSkip ? "warn" : "pass";
  return {
    name: "audit-logs",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg
  };
}

// src/canary/checks/usage.ts
function stepFromResponse12(name, resp, expectedStatus, validate) {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const step = {
    name,
    status: "pass",
    durationMs: resp.durationMs
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
async function usageCheck(http) {
  const steps = [];
  const checkStart = performance.now();
  const orgId = process.env.KAPABLE_ORG_ID ?? "";
  if (!orgId) {
    return {
      name: "usage",
      status: "skip",
      durationMs: Math.round(performance.now() - checkStart),
      steps: [
        {
          name: "Check KAPABLE_ORG_ID env var",
          status: "skip",
          durationMs: 0,
          detail: "KAPABLE_ORG_ID is not set -- skipping usage check"
        }
      ]
    };
  }
  try {
    const usagePath = `/v1/management/orgs/${orgId}/usage`;
    const usageResp = await http.get(usagePath, "admin-key");
    steps.push(stepFromResponse12(`GET /v1/management/orgs/{org_id}/usage (get usage)`, usageResp, 200, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      if (obj.org_id !== orgId) {
        return `org_id mismatch: expected "${orgId}", got "${obj.org_id}"`;
      }
      return null;
    }));
    const usageData = usageResp.data;
    if (usageData && usageResp.status === 200) {
      const dateStep = {
        name: "Verify period_start and period_end are ISO dates",
        status: "pass",
        durationMs: 0
      };
      const periodStart = usageData.period_start;
      const periodEnd = usageData.period_end;
      if (typeof periodStart !== "string" || !periodStart) {
        dateStep.status = "fail";
        dateStep.error = `period_start is not a string: got ${typeof periodStart}`;
      } else if (Number.isNaN(Date.parse(periodStart))) {
        dateStep.status = "fail";
        dateStep.error = `period_start is not a valid ISO date: "${periodStart}"`;
      } else if (typeof periodEnd !== "string" || !periodEnd) {
        dateStep.status = "fail";
        dateStep.error = `period_end is not a string: got ${typeof periodEnd}`;
      } else if (Number.isNaN(Date.parse(periodEnd))) {
        dateStep.status = "fail";
        dateStep.error = `period_end is not a valid ISO date: "${periodEnd}"`;
      } else {
        dateStep.detail = `period: ${periodStart} to ${periodEnd}`;
      }
      steps.push(dateStep);
      const countStep = {
        name: "Verify projects_count >= 1",
        status: "pass",
        durationMs: 0
      };
      const projectsCount = usageData.projects_count;
      if (typeof projectsCount !== "number") {
        countStep.status = "fail";
        countStep.error = `projects_count is not a number: got ${typeof projectsCount} (${projectsCount})`;
      } else if (projectsCount < 1) {
        countStep.status = "fail";
        countStep.error = `projects_count expected >= 1, got ${projectsCount}`;
      } else {
        countStep.detail = `projects_count=${projectsCount}, api_calls=${usageData.api_calls ?? "N/A"}, rows_stored=${usageData.rows_stored ?? "N/A"}`;
      }
      steps.push(countStep);
    }
  } catch (err) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return buildResult12(steps, checkStart);
}
function buildResult12(steps, checkStart, errorMsg) {
  const totalDuration = Math.round(performance.now() - checkStart);
  let hasFail = false;
  let hasSkip = false;
  let hasPass = false;
  for (const step of steps) {
    if (step.status === "fail")
      hasFail = true;
    else if (step.status === "skip")
      hasSkip = true;
    else
      hasPass = true;
  }
  const status = hasFail ? "fail" : !hasPass && hasSkip ? "skip" : hasSkip ? "warn" : "pass";
  return {
    name: "usage",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg
  };
}

// src/canary/checks/storage.ts
var STORAGE_PATH = "/v1/storage";
var BUCKET_NAME = "canary-test-bucket";
function stepFromResponse13(name, resp, expectedStatus, validate) {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const step = {
    name,
    status: "pass",
    durationMs: resp.durationMs
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
async function storageCheck(http) {
  const steps = [];
  const checkStart = performance.now();
  let bucketCreated = false;
  try {
    const statusResp = await http.get(`${STORAGE_PATH}/status`, "admin-key");
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
            detail: "Storage not configured (503) -- skipping storage checks"
          }
        ]
      };
    }
    steps.push(stepFromResponse13("GET /v1/storage/status (check configured)", statusResp, 200, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      if (obj.configured !== true) {
        return `Expected configured=true, got ${obj.configured}`;
      }
      return null;
    }));
    if (statusResp.status !== 200) {
      return buildResult13(steps, checkStart, "Storage status check failed -- cannot proceed");
    }
    const preClean = await http.delete(`${STORAGE_PATH}/buckets/${BUCKET_NAME}`, "admin-key");
    if (preClean.status === 200 || preClean.status === 204) {
      steps.push({
        name: `pre-cleanup: DELETE /v1/storage/buckets/${BUCKET_NAME} (existed from previous run)`,
        status: "pass",
        durationMs: preClean.durationMs,
        detail: "Stale bucket cleaned up"
      });
    }
    const createResp = await http.post(`${STORAGE_PATH}/buckets`, { name: BUCKET_NAME, visibility: "private" }, "admin-key");
    steps.push(stepFromResponse13(`POST /v1/storage/buckets (create ${BUCKET_NAME})`, createResp, [200, 201]));
    if (createResp.status === 200 || createResp.status === 201) {
      bucketCreated = true;
    } else {
      return buildResult13(steps, checkStart, "Cannot proceed without bucket creation");
    }
    const listResp = await http.get(`${STORAGE_PATH}/buckets`, "admin-key");
    steps.push(stepFromResponse13("GET /v1/storage/buckets (list buckets)", listResp, 200, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      const buckets = obj.buckets;
      if (!Array.isArray(buckets)) {
        return `Expected 'buckets' to be an array, got ${typeof buckets}`;
      }
      let found = false;
      for (const bucket of buckets) {
        const b = bucket;
        const name = String(b.name ?? "");
        if (name.includes(BUCKET_NAME)) {
          found = true;
          break;
        }
      }
      return found ? null : `Bucket containing "${BUCKET_NAME}" not found in list of ${buckets.length} buckets`;
    }));
    const usageResp = await http.get(`${STORAGE_PATH}/usage`, "admin-key");
    steps.push(stepFromResponse13("GET /v1/storage/usage (check usage)", usageResp, 200, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      const numericFields = ["used_bytes", "quota_bytes", "bucket_count", "remaining_bytes"];
      const missingFields = [];
      for (const field of numericFields) {
        if (typeof obj[field] !== "number") {
          missingFields.push(`${field} (got ${typeof obj[field]})`);
        }
      }
      if (missingFields.length > 0) {
        return `Missing or non-numeric fields: ${missingFields.join(", ")}`;
      }
      return null;
    }));
  } catch (err) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err)
    });
  } finally {
    if (bucketCreated) {
      try {
        const deleteResp = await http.delete(`${STORAGE_PATH}/buckets/${BUCKET_NAME}`, "admin-key");
        steps.push(stepFromResponse13(`DELETE /v1/storage/buckets/${BUCKET_NAME} (cleanup)`, deleteResp, [200, 204, 404]));
      } catch (cleanupErr) {
        steps.push({
          name: "cleanup: delete bucket",
          status: "fail",
          durationMs: 0,
          error: `Cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
        });
      }
    }
  }
  return buildResult13(steps, checkStart);
}
function buildResult13(steps, checkStart, errorMsg) {
  const totalDuration = Math.round(performance.now() - checkStart);
  let hasFail = false;
  let hasSkip = false;
  let hasPass = false;
  for (const step of steps) {
    if (step.status === "fail")
      hasFail = true;
    else if (step.status === "skip")
      hasSkip = true;
    else
      hasPass = true;
  }
  const status = hasFail ? "fail" : !hasPass && hasSkip ? "skip" : hasSkip ? "warn" : "pass";
  return {
    name: "storage",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg
  };
}

// src/canary/checks/functions.ts
var FUNCTION_NAME = "canary-function";
var FUNCTION_SOURCE = 'function handle(input) { var msg = (input && input.msg) || "CANARY_OK"; return { ok: true, echo: msg }; }';
function stepFromResponse14(name, resp, expectedStatus, validate) {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const step = {
    name,
    status: "pass",
    durationMs: resp.durationMs
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
async function functionsCheck(http) {
  const appId = process.env.KAPABLE_APP_ID ?? "";
  const envName = process.env.KAPABLE_ENV_NAME ?? "production";
  if (!appId) {
    return {
      name: "functions",
      status: "skip",
      durationMs: 0,
      steps: [{
        name: "KAPABLE_APP_ID not set",
        status: "skip",
        durationMs: 0,
        detail: "Functions check requires KAPABLE_APP_ID env var"
      }]
    };
  }
  const functionsPath = `/v1/apps/${appId}/environments/${envName}/functions`;
  const steps = [];
  const checkStart = performance.now();
  let functionId = null;
  try {
    const preList = await http.get(functionsPath, "admin-key");
    if (preList.data && typeof preList.data === "object") {
      const listObj = preList.data;
      const items = Array.isArray(listObj.data) ? listObj.data : Array.isArray(preList.data) ? preList.data : [];
      for (const item of items) {
        const fn = item;
        if (fn.name === FUNCTION_NAME && fn.id) {
          const delResp = await http.delete(`${functionsPath}/${fn.id}`, "admin-key");
          if (delResp.status === 204 || delResp.status === 200) {
            steps.push({
              name: "pre-cleanup: DELETE canary-function (existed from previous run)",
              status: "pass",
              durationMs: delResp.durationMs,
              detail: "Stale function cleaned up"
            });
          }
        }
      }
    }
    const createResp = await http.request("POST", functionsPath, {
      body: {
        name: FUNCTION_NAME,
        source_code: FUNCTION_SOURCE,
        handler_name: "handle"
      },
      auth: "admin-key",
      timeoutMs: 30000
    });
    steps.push(stepFromResponse14("POST .../functions (create)", createResp, 201, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      const inner = obj.data ?? obj;
      if (!inner || typeof inner !== "object")
        return "Response missing 'data' wrapper";
      const fn = inner;
      if (!fn.id)
        return "Response missing 'id' field";
      if (fn.name !== FUNCTION_NAME) {
        return `name mismatch: expected "${FUNCTION_NAME}", got "${fn.name}"`;
      }
      functionId = String(fn.id);
      return null;
    }));
    if (!functionId) {
      return buildResult14(steps, checkStart, "Cannot proceed without function ID");
    }
    const createData = createResp.data?.data;
    if (createData) {
      const lastStep = steps[steps.length - 1];
      if (lastStep.status === "pass") {
        const compiled = createData.compiled_at ? "yes" : "no";
        lastStep.detail = `version=${createData.version}, runtime=${createData.runtime}, compiled=${compiled}`;
      }
    }
    const listResp = await http.get(functionsPath, "admin-key");
    steps.push(stepFromResponse14("GET .../functions (verify in list)", listResp, 200, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      const items = Array.isArray(obj.data) ? obj.data : [];
      let found = false;
      for (const item of items) {
        const fn = item;
        if (String(fn.id) === functionId) {
          found = true;
          break;
        }
      }
      if (!found)
        return `Function ${functionId} not found in list`;
      return null;
    }));
    const getResp = await http.get(`${functionsPath}/${functionId}`, "admin-key");
    steps.push(stepFromResponse14(`GET .../functions/${functionId} (verify fields)`, getResp, 200, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      const inner = obj.data ?? obj;
      if (!inner || typeof inner !== "object")
        return "Response missing 'data' wrapper";
      const fn = inner;
      if (String(fn.id) !== functionId) {
        return `ID mismatch: expected ${functionId}, got ${fn.id}`;
      }
      if (fn.name !== FUNCTION_NAME) {
        return `name mismatch: expected "${FUNCTION_NAME}", got "${fn.name}"`;
      }
      if (fn.runtime !== "typescript") {
        return `runtime mismatch: expected "typescript", got "${fn.runtime}"`;
      }
      if (fn.handler_name !== "handle") {
        return `handler_name mismatch: expected "handle", got "${fn.handler_name}"`;
      }
      return null;
    }));
    const deleteResp = await http.delete(`${functionsPath}/${functionId}`, "admin-key");
    steps.push(stepFromResponse14(`DELETE .../functions/${functionId} (delete)`, deleteResp, 204));
    if (deleteResp.status === 204) {
      functionId = null;
    }
  } catch (err) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err)
    });
  } finally {
    if (functionId) {
      try {
        const cleanupResp = await http.delete(`${functionsPath}/${functionId}`, "admin-key");
        steps.push(stepFromResponse14(`DELETE .../functions/${functionId} (finally cleanup)`, cleanupResp, [204, 404]));
      } catch (cleanupErr) {
        steps.push({
          name: "cleanup: delete function",
          status: "fail",
          durationMs: 0,
          error: `Cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
        });
      }
    }
  }
  return buildResult14(steps, checkStart);
}
function buildResult14(steps, checkStart, errorMsg) {
  const totalDuration = Math.round(performance.now() - checkStart);
  let hasFail = false;
  let hasSkip = false;
  let hasPass = false;
  for (const step of steps) {
    if (step.status === "fail")
      hasFail = true;
    else if (step.status === "skip")
      hasSkip = true;
    else
      hasPass = true;
  }
  const status = hasFail ? "fail" : !hasPass && hasSkip ? "skip" : hasSkip ? "warn" : "pass";
  return {
    name: "functions",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg
  };
}

// src/canary/checks/deploy-health.ts
var TWEETY_HEALTH_URL = "https://tweety.kapable.run/health";
var TIMEOUT_MS = 5000;
async function deployHealthCheck(_http) {
  const steps = [];
  const checkStart = performance.now();
  try {
    const controller = new AbortController;
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const fetchStart = performance.now();
    let status = 0;
    let rawText = "";
    let data = null;
    let fetchError;
    try {
      const resp = await fetch(TWEETY_HEALTH_URL, {
        signal: controller.signal,
        headers: { Accept: "application/json" }
      });
      status = resp.status;
      rawText = await resp.text();
      try {
        data = JSON.parse(rawText);
      } catch {}
    } catch (err) {
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
    const httpStep = {
      name: `GET ${TWEETY_HEALTH_URL}`,
      status: "pass",
      durationMs: fetchDuration
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
    const bodyStep = {
      name: "Response has valid body",
      status: "pass",
      durationMs: 0
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
    const latencyStep = {
      name: "Response time < 5000ms",
      status: "pass",
      durationMs: fetchDuration
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
  } catch (err) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return buildResult15(steps, checkStart);
}
function buildResult15(steps, checkStart) {
  const totalDuration = Math.round(performance.now() - checkStart);
  let hasFail = false;
  let hasSkip = false;
  let hasPass = false;
  for (const step of steps) {
    if (step.status === "fail")
      hasFail = true;
    else if (step.status === "skip")
      hasSkip = true;
    else
      hasPass = true;
  }
  const status = hasFail ? "fail" : !hasPass && hasSkip ? "skip" : hasSkip ? "warn" : "pass";
  return {
    name: "deploy-health",
    status,
    durationMs: totalDuration,
    steps
  };
}

// src/canary/checks/auth-flow.ts
function stepFromResponse15(name, resp, expectedStatus, validate) {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const step = {
    name,
    status: "pass",
    durationMs: resp.durationMs
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
async function authFlowCheck(http) {
  const steps = [];
  const checkStart = performance.now();
  const ts = Date.now();
  const email = `canary-${ts}@test.kapable.dev`;
  const password = `CanaryP@ss${ts}!`;
  const orgName = `canary-org-${ts}`;
  let sessionToken = null;
  try {
    const orgSlug = `canary-org-${ts}`;
    const signupResp = await http.request("POST", "/v1/auth/signup", {
      body: { email, password, name: "Canary Bird", org_name: orgName, org_slug: orgSlug },
      auth: "none"
    });
    steps.push(stepFromResponse15("POST /v1/auth/signup", signupResp, [200, 201], (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      if (!obj.token && !obj.session_token)
        return "Response missing token";
      return null;
    }));
    if (signupResp.error || signupResp.status !== 200 && signupResp.status !== 201) {
      return buildResult16(steps, checkStart, "Cannot proceed without signup");
    }
    const loginResp = await http.request("POST", "/v1/auth/login", {
      body: { email, password, org_slug: orgSlug },
      auth: "none"
    });
    steps.push(stepFromResponse15("POST /v1/auth/login", loginResp, 200, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      const token = obj.token ?? obj.session_token;
      if (!token)
        return "Response missing token";
      sessionToken = token;
      return null;
    }));
    if (!sessionToken) {
      return buildResult16(steps, checkStart, "Cannot proceed without session token");
    }
    const sessionResp = await http.request("GET", "/v1/auth/session", {
      auth: "none",
      headers: { Authorization: `Bearer ${sessionToken}` }
    });
    steps.push(stepFromResponse15("GET /v1/auth/session (verify)", sessionResp, 200, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      const respEmail = obj.email ?? obj.user?.email;
      if (respEmail && respEmail !== email)
        return `Email mismatch: expected ${email}, got ${respEmail}`;
      return null;
    }));
  } catch (err) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return buildResult16(steps, checkStart);
}
function buildResult16(steps, checkStart, errorMsg) {
  const totalDuration = Math.round(performance.now() - checkStart);
  let hasFail = false;
  let hasSkip = false;
  let hasPass = false;
  for (const step of steps) {
    if (step.status === "fail")
      hasFail = true;
    else if (step.status === "skip")
      hasSkip = true;
    else
      hasPass = true;
  }
  const status = hasFail ? "fail" : !hasPass && hasSkip ? "skip" : hasSkip ? "warn" : "pass";
  return {
    name: "auth-flow",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg
  };
}

// src/canary/checks/app-lifecycle.ts
var APP_SLUG = "canary-smoke";
var APP_NAME = "Canary Smoke";
var FRAMEWORK = "bun-server";
var DEPLOY_POLL_INTERVAL_MS = 5000;
var DEPLOY_TIMEOUT_MS = 120000;
var SUBDOMAIN_TIMEOUT_MS = 30000;
var SUBDOMAIN_RETRY_INTERVAL_MS = 3000;
var SUBDOMAIN_URL = `https://${APP_SLUG}.kapable.run/health`;
function stepFromResponse16(name, resp, expectedStatus, validate) {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const step = {
    name,
    status: "pass",
    durationMs: resp.durationMs
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
async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function appLifecycleCheck(http) {
  const steps = [];
  const checkStart = performance.now();
  let appId = null;
  try {
    const listResp = await http.get("/v1/apps", "admin-key");
    if (!listResp.error && listResp.data) {
      const wrapper = listResp.data;
      const appsArray = wrapper.data ?? wrapper;
      const apps = Array.isArray(appsArray) ? appsArray : [];
      for (const app of apps) {
        const obj = app;
        if (obj.slug === APP_SLUG) {
          const existingId = String(obj.id);
          const envDelResp = await http.delete(`/v1/apps/${existingId}/environments/production`, "admin-key");
          let delResp = envDelResp;
          let cleanupOk = false;
          for (let attempt = 0;attempt < 5; attempt++) {
            await sleep(3000);
            delResp = await http.delete(`/v1/apps/${existingId}`, "admin-key");
            if (!delResp.error || delResp.status === 404) {
              cleanupOk = true;
              break;
            }
          }
          steps.push({
            name: `pre-cleanup: DELETE /v1/apps/${existingId}`,
            status: cleanupOk ? "pass" : "fail",
            durationMs: delResp.durationMs + envDelResp.durationMs + listResp.durationMs,
            detail: cleanupOk ? "Orphan cleaned up" : `env-del=${envDelResp.status}, app-del=${delResp.status}`,
            error: cleanupOk ? undefined : delResp.error || `app-del returned ${delResp.status}`
          });
          break;
        }
      }
    }
    const createResp = await http.request("POST", "/v1/apps", {
      body: { name: APP_NAME, slug: APP_SLUG, framework: FRAMEWORK },
      auth: "admin-key"
    });
    steps.push(stepFromResponse16("POST /v1/apps (create canary-smoke)", createResp, [200, 201], (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      if (!obj.id)
        return "Response missing 'id' field";
      appId = String(obj.id);
      return null;
    }));
    if (!appId) {
      return buildResult17(steps, checkStart, "Cannot proceed without app ID");
    }
    const getResp = await http.get(`/v1/apps/${appId}`, "admin-key");
    steps.push(stepFromResponse16(`GET /v1/apps/${appId} (verify env)`, getResp, 200, (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      const envs = obj.environments;
      if (!envs || !Array.isArray(envs) || envs.length === 0)
        return "No environments found";
      const prodEnv = envs[0];
      if (prodEnv.name !== "production")
        return `Expected env name 'production', got '${prodEnv.name}'`;
      return null;
    }));
    const deployResp = await http.request("POST", `/v1/apps/${appId}/environments/production/deploy`, { auth: "admin-key" });
    let deploymentId = null;
    steps.push(stepFromResponse16("POST .../deploy (trigger)", deployResp, [200, 201, 202], (data) => {
      if (!data || typeof data !== "object")
        return "Response is not an object";
      const obj = data;
      const id = obj.id ?? obj.deployment_id;
      if (!id)
        return "Response missing deployment ID";
      deploymentId = String(id);
      return null;
    }));
    if (!deploymentId) {
      return buildResult17(steps, checkStart, "Cannot proceed without deployment ID");
    }
    const pollStart = performance.now();
    let deployStatus = "pending";
    let pollCount = 0;
    while (performance.now() - pollStart < DEPLOY_TIMEOUT_MS) {
      await sleep(DEPLOY_POLL_INTERVAL_MS);
      pollCount++;
      const pollResp = await http.get(`/v1/apps/${appId}/environments/production/deployments/${deploymentId}`, "admin-key");
      if (pollResp.error)
        continue;
      if (pollResp.data && typeof pollResp.data === "object") {
        const obj = pollResp.data;
        deployStatus = String(obj.status ?? "unknown");
        if (deployStatus === "success" || deployStatus === "failed" || deployStatus === "error") {
          break;
        }
      }
    }
    const pollDuration = Math.round(performance.now() - pollStart);
    const pollStep = {
      name: `Poll deployment (${pollCount} polls)`,
      status: deployStatus === "success" ? "pass" : "fail",
      durationMs: pollDuration,
      detail: `status=${deployStatus}`
    };
    if (deployStatus !== "success") {
      pollStep.error = `Deploy ended with status '${deployStatus}'`;
    }
    steps.push(pollStep);
    if (deployStatus !== "success") {
      return buildResult17(steps, checkStart, "Deploy did not succeed");
    }
    const subdomainStart = performance.now();
    let subdomainOk = false;
    let lastSubError = "";
    let subRetries = 0;
    while (performance.now() - subdomainStart < SUBDOMAIN_TIMEOUT_MS) {
      subRetries++;
      try {
        const controller = new AbortController;
        const timer = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(SUBDOMAIN_URL, {
          signal: controller.signal,
          headers: { Accept: "application/json" }
        });
        clearTimeout(timer);
        if (resp.status === 200) {
          subdomainOk = true;
          break;
        }
        lastSubError = `status=${resp.status}`;
      } catch (err) {
        lastSubError = err instanceof Error ? err.message : String(err);
      }
      await sleep(SUBDOMAIN_RETRY_INTERVAL_MS);
    }
    const subdomainDuration = Math.round(performance.now() - subdomainStart);
    const subStep = {
      name: `GET ${SUBDOMAIN_URL} (verify live)`,
      status: subdomainOk ? "pass" : "fail",
      durationMs: subdomainDuration,
      detail: subdomainOk ? `OK after ${subRetries} attempt(s)` : undefined
    };
    if (!subdomainOk) {
      subStep.error = `Subdomain not reachable after ${subRetries} attempts: ${lastSubError}`;
    }
    steps.push(subStep);
  } catch (err) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err)
    });
  } finally {
    if (appId) {
      try {
        await http.delete(`/v1/apps/${appId}/environments/production`, "admin-key");
        let delResp = null;
        for (let attempt = 0;attempt < 5; attempt++) {
          await sleep(3000);
          delResp = await http.delete(`/v1/apps/${appId}`, "admin-key");
          if (!delResp.error || delResp.status === 404 || delResp.status === 200 || delResp.status === 204) {
            break;
          }
        }
        if (delResp) {
          steps.push(stepFromResponse16(`DELETE /v1/apps/${appId} (cleanup)`, delResp, [200, 204, 404]));
        }
      } catch (cleanupErr) {
        steps.push({
          name: "cleanup: delete app",
          status: "fail",
          durationMs: 0,
          error: `Cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
        });
      }
    }
  }
  return buildResult17(steps, checkStart);
}
function buildResult17(steps, checkStart, errorMsg) {
  const totalDuration = Math.round(performance.now() - checkStart);
  let hasFail = false;
  let hasSkip = false;
  let hasPass = false;
  for (const step of steps) {
    if (step.status === "fail")
      hasFail = true;
    else if (step.status === "skip")
      hasSkip = true;
    else
      hasPass = true;
  }
  const status = hasFail ? "fail" : !hasPass && hasSkip ? "skip" : hasSkip ? "warn" : "pass";
  return {
    name: "app-lifecycle",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg
  };
}

// src/canary/runner.ts
var registry = [
  { name: "health", fn: healthCheck },
  { name: "data-crud", fn: dataCrudCheck },
  { name: "toggles", fn: togglesCheck },
  { name: "tokens", fn: tokensCheck },
  { name: "secrets", fn: secretsCheck },
  { name: "documents", fn: documentsCheck },
  { name: "webhooks", fn: webhooksCheck },
  { name: "schedules", fn: schedulesCheck },
  { name: "ai-chat", fn: aiChatCheck },
  { name: "ai-image", fn: aiImageCheck },
  { name: "ai-voice", fn: aiVoiceCheck },
  { name: "audit-logs", fn: auditLogsCheck },
  { name: "usage", fn: usageCheck },
  { name: "storage", fn: storageCheck },
  { name: "functions", fn: functionsCheck },
  { name: "deploy-health", fn: deployHealthCheck },
  { name: "auth-flow", fn: authFlowCheck },
  { name: "app-lifecycle", fn: appLifecycleCheck }
];
async function runAllChecks() {
  const http = createHttpClient();
  const reportStart = performance.now();
  const checks = [];
  for (const entry of registry) {
    let result;
    try {
      result = await entry.fn(http);
    } catch (err) {
      result = {
        name: entry.name,
        status: "fail",
        durationMs: 0,
        steps: [],
        error: `Unhandled: ${err instanceof Error ? err.message : String(err)}`
      };
    }
    checks.push(result);
  }
  const totalDurationMs = Math.round(performance.now() - reportStart);
  let pass = 0;
  let fail = 0;
  let warn = 0;
  let skip = 0;
  for (const check of checks) {
    if (check.status === "pass")
      pass++;
    else if (check.status === "fail")
      fail++;
    else if (check.status === "warn")
      warn++;
    else
      skip++;
  }
  return {
    timestamp: new Date().toISOString(),
    totalDurationMs,
    summary: { pass, fail, warn, skip, total: checks.length },
    checks
  };
}
async function runCheck(name) {
  let target = null;
  for (const entry of registry) {
    if (entry.name === name) {
      target = entry;
      break;
    }
  }
  if (!target) {
    return null;
  }
  const http = createHttpClient();
  try {
    return await target.fn(http);
  } catch (err) {
    return {
      name: target.name,
      status: "fail",
      durationMs: 0,
      steps: [],
      error: `Unhandled: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}
function getCheckNames() {
  const names = [];
  for (const entry of registry) {
    names.push(entry.name);
  }
  return names;
}

// src/index.ts
var port = Number(process.env.PORT) || 3000;
var hostname = "0.0.0.0";
var lastReport = null;
var isRunning = false;
var runningStartedAt = 0;
var MAX_LOCK_DURATION_MS = 120000;
function acquireLock() {
  if (isRunning) {
    if (Date.now() - runningStartedAt > MAX_LOCK_DURATION_MS) {
      console.warn(`[tweety] Force-clearing stale canary lock (held for ${Math.round((Date.now() - runningStartedAt) / 1000)}s)`);
      isRunning = false;
    } else {
      return false;
    }
  }
  isRunning = true;
  runningStartedAt = Date.now();
  return true;
}
function buildDashboardHtml() {
  const reportJson = lastReport ? JSON.stringify(lastReport) : "null";
  const checkNames = getCheckNames();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tweety -- Kapable Canary</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
      background: #0a0a0a;
      color: #e5e5e5;
      min-height: 100vh;
      padding: 2rem;
    }
    .header {
      text-align: center;
      margin-bottom: 2rem;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid #262626;
    }
    .header h1 { font-size: 2rem; margin-bottom: 0.25rem; }
    .header .bird { color: #fbbf24; font-size: 2.5rem; display: inline-block; margin-bottom: 0.5rem; }
    .header .subtitle { color: #737373; font-size: 0.9rem; }
    .controls {
      text-align: center;
      margin-bottom: 2rem;
    }
    .btn {
      background: #1d4ed8;
      color: #fff;
      border: none;
      padding: 0.6rem 1.5rem;
      border-radius: 6px;
      font-size: 0.9rem;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.15s;
    }
    .btn:hover { background: #2563eb; }
    .btn:disabled { background: #374151; cursor: not-allowed; color: #9ca3af; }
    .btn-sm {
      padding: 0.3rem 0.8rem;
      font-size: 0.75rem;
      margin-left: 0.5rem;
    }
    .no-report {
      text-align: center;
      color: #737373;
      padding: 3rem;
      border: 1px dashed #262626;
      border-radius: 8px;
    }
    .summary {
      display: flex;
      gap: 1rem;
      justify-content: center;
      margin-bottom: 2rem;
      flex-wrap: wrap;
    }
    .summary-card {
      background: #171717;
      border: 1px solid #262626;
      border-radius: 8px;
      padding: 1rem 1.5rem;
      text-align: center;
      min-width: 100px;
    }
    .summary-card .value { font-size: 1.8rem; font-weight: bold; }
    .summary-card .label { font-size: 0.75rem; color: #737373; text-transform: uppercase; margin-top: 0.25rem; }
    .status-pass { color: #4ade80; }
    .status-fail { color: #f87171; }
    .status-warn { color: #fb923c; }
    .status-skip { color: #fbbf24; }
    .timestamp { text-align: center; color: #737373; font-size: 0.8rem; margin-bottom: 1.5rem; }
    .check {
      background: #171717;
      border: 1px solid #262626;
      border-radius: 8px;
      margin-bottom: 1rem;
      overflow: hidden;
    }
    .check-header {
      display: flex;
      align-items: center;
      padding: 0.8rem 1rem;
      cursor: pointer;
      user-select: none;
      gap: 0.75rem;
    }
    .check-header:hover { background: #1a1a1a; }
    .check-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .dot-pass { background: #4ade80; }
    .dot-fail { background: #f87171; }
    .dot-warn { background: #fb923c; }
    .dot-skip { background: #fbbf24; }
    .check-name { font-weight: 600; flex-grow: 1; }
    .check-duration { color: #737373; font-size: 0.8rem; }
    .check-arrow { color: #737373; font-size: 0.8rem; transition: transform 0.15s; }
    .check-arrow.open { transform: rotate(90deg); }
    .check-steps {
      display: none;
      border-top: 1px solid #262626;
      padding: 0.5rem 0;
    }
    .check-steps.open { display: block; }
    .step {
      display: flex;
      align-items: flex-start;
      padding: 0.4rem 1rem 0.4rem 2.5rem;
      gap: 0.5rem;
      font-size: 0.85rem;
    }
    .step-icon { flex-shrink: 0; width: 16px; text-align: center; }
    .step-name { flex-grow: 1; word-break: break-all; }
    .step-duration { color: #737373; font-size: 0.75rem; flex-shrink: 0; }
    .step-error { color: #f87171; font-size: 0.8rem; padding: 0.2rem 1rem 0.4rem 3rem; word-break: break-all; }
    .step-detail { color: #737373; font-size: 0.8rem; padding: 0.2rem 1rem 0.4rem 3rem; word-break: break-all; }
    .check-error { color: #f87171; font-size: 0.85rem; padding: 0.5rem 1rem; border-top: 1px solid #262626; }
    .footer {
      text-align: center;
      color: #525252;
      font-size: 0.75rem;
      margin-top: 2rem;
      padding-top: 1rem;
      border-top: 1px solid #1a1a1a;
    }
    .footer a { color: #60a5fa; text-decoration: none; }
    .footer a:hover { text-decoration: underline; }
    .loading { display: none; text-align: center; color: #fbbf24; padding: 1rem; }
    .loading.active { display: block; }
  </style>
</head>
<body>
  <div class="header">
    <div class="bird">&#x1F426;</div>
    <h1>Tweety</h1>
    <p class="subtitle">Kapable Platform Canary</p>
  </div>

  <div class="controls">
    <button class="btn" id="runBtn" onclick="runCanary()">Run Canary</button>
    <span style="margin-left: 1rem; color: #525252; font-size: 0.8rem;">
      Checks: ${checkNames.join(", ")}
    </span>
  </div>

  <div class="loading" id="loading">Running canary checks... this may take 30-60s</div>

  <div id="report-container">
    ${lastReport ? "" : '<div class="no-report">No canary report yet. Click "Run Canary" or hit <code>/canary</code> to run.</div>'}
  </div>

  <div class="footer">
    Tweety v0.1.0 &middot; Bun ${Bun.version} &middot;
    <a href="/health">/health</a> &middot;
    <a href="/canary">/canary (JSON)</a>
  </div>

  <script>
    // Initial report data (server-rendered)
    let report = ${reportJson};

    function renderReport(r) {
      if (!r) return;
      report = r;
      const c = document.getElementById('report-container');
      let html = '';

      // Timestamp
      html += '<div class="timestamp">Report from ' + new Date(r.timestamp).toLocaleString() + ' (' + r.totalDurationMs + 'ms total)</div>';

      // Summary cards
      html += '<div class="summary">';
      html += '<div class="summary-card"><div class="value status-pass">' + r.summary.pass + '</div><div class="label">Pass</div></div>';
      html += '<div class="summary-card"><div class="value status-fail">' + r.summary.fail + '</div><div class="label">Fail</div></div>';
      html += '<div class="summary-card"><div class="value status-warn">' + r.summary.warn + '</div><div class="label">Warn</div></div>';
      html += '<div class="summary-card"><div class="value status-skip">' + r.summary.skip + '</div><div class="label">Skip</div></div>';
      html += '<div class="summary-card"><div class="value" style="color:#e5e5e5">' + r.summary.total + '</div><div class="label">Total</div></div>';
      html += '</div>';

      // Checks
      for (let i = 0; i < r.checks.length; i++) {
        const ch = r.checks[i];
        const dotClass = 'dot-' + ch.status;
        html += '<div class="check">';
        html += '<div class="check-header" onclick="toggleSteps(' + i + ')">';
        html += '<div class="check-dot ' + dotClass + '"></div>';
        html += '<span class="check-name">' + escHtml(ch.name) + '</span>';
        html += '<span class="check-duration">' + ch.durationMs + 'ms</span>';
        html += '<span class="check-arrow" id="arrow-' + i + '">&#9654;</span>';
        html += '</div>';

        if (ch.error) {
          html += '<div class="check-error">' + escHtml(ch.error) + '</div>';
        }

        html += '<div class="check-steps" id="steps-' + i + '">';
        for (let j = 0; j < ch.steps.length; j++) {
          const st = ch.steps[j];
          const icon = st.status === 'pass' ? '<span style="color:#4ade80">&#10003;</span>'
                     : st.status === 'fail' ? '<span style="color:#f87171">&#10007;</span>'
                     : st.status === 'warn' ? '<span style="color:#fb923c">&#9888;</span>'
                     : '<span style="color:#fbbf24">&#9679;</span>';
          html += '<div class="step">';
          html += '<span class="step-icon">' + icon + '</span>';
          html += '<span class="step-name">' + escHtml(st.name) + '</span>';
          html += '<span class="step-duration">' + st.durationMs + 'ms</span>';
          html += '</div>';
          if (st.error) {
            html += '<div class="step-error">' + escHtml(st.error) + '</div>';
          }
          if (st.detail) {
            html += '<div class="step-detail">' + escHtml(st.detail) + '</div>';
          }
        }
        html += '</div>';
        html += '</div>';
      }

      c.innerHTML = html;
    }

    function toggleSteps(idx) {
      const el = document.getElementById('steps-' + idx);
      const arrow = document.getElementById('arrow-' + idx);
      if (el) {
        el.classList.toggle('open');
      }
      if (arrow) {
        arrow.classList.toggle('open');
      }
    }

    function escHtml(s) {
      if (!s) return '';
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    async function runCanary() {
      const btn = document.getElementById('runBtn');
      const loading = document.getElementById('loading');
      btn.disabled = true;
      btn.textContent = 'Running...';
      loading.classList.add('active');

      try {
        const resp = await fetch('/canary');
        const text = await resp.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error(resp.status + ' \u2014 ' + text.slice(0, 200));
        }
        if (data.error) {
          throw new Error(data.error);
        }
        renderReport(data);
      } catch (err) {
        const c = document.getElementById('report-container');
        c.innerHTML = '<div class="no-report" style="border-color:#f87171;color:#f87171">Error running canary: ' + escHtml(err.message) + '</div>';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Run Canary';
        loading.classList.remove('active');
      }
    }

    // Render initial report if available
    if (report) {
      renderReport(report);
    }
  </script>
</body>
</html>`;
}
var server = Bun.serve({
  port,
  hostname,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/") {
      return new Response(buildDashboardHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }
    if (path === "/health") {
      return Response.json({
        status: "ok",
        app: "tweety",
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      });
    }
    if (path === "/canary") {
      if (!acquireLock()) {
        return Response.json({ error: "Canary is already running. Please wait for it to finish." }, { status: 429 });
      }
      try {
        const report = await runAllChecks();
        lastReport = report;
        return Response.json(report);
      } finally {
        isRunning = false;
      }
    }
    const checkMatch = path.match(/^\/canary\/([a-z0-9-]+)$/);
    if (checkMatch) {
      const checkName = checkMatch[1];
      if (!acquireLock()) {
        return Response.json({ error: "Canary is already running. Please wait for it to finish." }, { status: 429 });
      }
      try {
        const result = await runCheck(checkName);
        if (!result) {
          return Response.json({ error: `Check "${checkName}" not found. Available: ${getCheckNames().join(", ")}` }, { status: 404 });
        }
        return Response.json(result);
      } finally {
        isRunning = false;
      }
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
});
console.log(`Tweety canary running on ${hostname}:${port}`);
console.log(`  Dashboard: http://localhost:${port}/`);
console.log(`  Health:    http://localhost:${port}/health`);
console.log(`  Canary:    http://localhost:${port}/canary`);
console.log(`  Checks:    ${getCheckNames().join(", ")}`);
var envVars = ["KAPABLE_API_URL", "KAPABLE_API_KEY", "KAPABLE_ADMIN_KEY", "KAPABLE_ORG_ID", "KAPABLE_PROJECT_ID"];
for (const name of envVars) {
  const val = process.env[name];
  if (val) {
    console.log(`  ${name}: set (${val.slice(0, 8)}...)`);
  } else {
    console.warn(`  ${name}: NOT SET`);
  }
}
