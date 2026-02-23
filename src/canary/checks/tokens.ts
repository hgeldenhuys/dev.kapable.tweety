/**
 * JWT Token Lifecycle Check -- creates a token, lists tokens, revokes,
 * and verifies revocation.
 */
import type { HttpClient } from "../http";
import type { CheckResult, StepResult } from "../types";

const TOKENS_PATH = "/v1/tokens";

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

export async function tokensCheck(http: HttpClient): Promise<CheckResult> {
  const steps: StepResult[] = [];
  const checkStart = performance.now();
  let tokenJti: string | null = null;

  try {
    // Step 1: Create a JWT token
    const createResp = await http.post(
      TOKENS_PATH,
      {
        sub: "canary-user",
        scopes: { role: "tester" },
        ttl_seconds: 300,
      },
      "api-key",
    );
    steps.push(
      stepFromResponse("POST /v1/tokens (create token)", createResp, [200, 201], (data) => {
        if (!data || typeof data !== "object") return "Response is not an object";
        const obj = data as Record<string, unknown>;
        // The jti might be at top level or nested
        const jti = obj.jti ?? obj.id ?? (obj as Record<string, Record<string, unknown>>).token?.jti;
        if (!jti) return "Response missing 'jti' or 'id' field";
        tokenJti = String(jti);
        return null;
      }),
    );

    if (!tokenJti) {
      return buildResult(steps, checkStart, "Cannot proceed without token jti");
    }

    // Step 2: List tokens -- verify our token appears
    const listResp = await http.get(TOKENS_PATH, "api-key");
    steps.push(
      stepFromResponse("GET /v1/tokens (list tokens)", listResp, 200, (data) => {
        // Response could be an array or { data: [...] } or { tokens: [...] }
        let tokens: unknown[] = [];
        if (Array.isArray(data)) {
          tokens = data;
        } else if (data && typeof data === "object") {
          const obj = data as Record<string, unknown>;
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
          const tok = t as Record<string, unknown>;
          if (String(tok.jti) === tokenJti || String(tok.id) === tokenJti) {
            found = true;
            break;
          }
        }

        return found ? null : `Token with jti=${tokenJti} not found in list`;
      }),
    );

    // Step 3: Revoke token
    const revokeResp = await http.delete(`${TOKENS_PATH}/${tokenJti}`, "api-key");
    steps.push(
      stepFromResponse(`DELETE /v1/tokens/${tokenJti} (revoke)`, revokeResp, [200, 204]),
    );

    // Step 4: Verify revocation -- token should not appear in active list
    // (or should be marked as revoked)
    const verifyResp = await http.get(TOKENS_PATH, "api-key");
    steps.push(
      stepFromResponse("GET /v1/tokens (verify revoked)", verifyResp, 200, (data) => {
        let tokens: unknown[] = [];
        if (Array.isArray(data)) {
          tokens = data;
        } else if (data && typeof data === "object") {
          const obj = data as Record<string, unknown>;
          const arr = obj.data ?? obj.tokens ?? obj.items;
          if (Array.isArray(arr)) {
            tokens = arr;
          }
        }

        // Token should either not appear or be marked as revoked
        for (const t of tokens) {
          const tok = t as Record<string, unknown>;
          const matchesJti = String(tok.jti) === tokenJti || String(tok.id) === tokenJti;
          if (matchesJti) {
            // If it appears, it should be marked revoked
            if (tok.revoked === true || tok.status === "revoked") {
              return null; // OK -- present but revoked
            }
            return `Token ${tokenJti} still appears in list and is not marked revoked`;
          }
        }

        return null; // Not found in list -- that's valid too
      }),
    );

    // Token is already revoked/cleaned up, so no additional cleanup needed
  } catch (err: unknown) {
    steps.push({
      name: "unexpected error",
      status: "fail",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    });

    // Try to clean up the token if it was created
    if (tokenJti) {
      try {
        await http.delete(`${TOKENS_PATH}/${tokenJti}`, "api-key");
      } catch {
        // Best effort cleanup
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
    name: "tokens",
    status,
    durationMs: totalDuration,
    steps,
    error: errorMsg,
  };
}
