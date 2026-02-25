/**
 * Sylvester Function Call -- browser-based E2E UAT for serverless functions.
 *
 * Tests the function lifecycle through the Console UI:
 *
 *   Console Login -> Navigate to App -> Functions Tab ->
 *   Create Function -> View Details -> Delete -> Verify Gone
 *
 * Rules:
 *   - ALL actions are through the browser UI (Chrome MCP). No direct API calls.
 *   - Reentrant: function is created from scratch each run, cleaned up after.
 *   - Uses unique function name "sylvester-fn-test" to avoid conflicts.
 *
 * Note: The /call endpoint doesn't have a Console UI button yet, so this plan
 * tests the CRUD lifecycle only. The API-level /call test is in Canary and Hector.
 */
import type { E2EStep, E2ECheckPlan } from "./types";

const FUNCTION_NAME = "sylvester-fn-test";
const CONSOLE_URL = "https://console.kapable.dev";
const FUNCTION_SOURCE = 'function handle(input) { return { ok: true, msg: "sylvester" }; }';

const steps: E2EStep[] = [
  // ══════════════════════════════════════════════════════════════════
  // PHASE 1: Console Login
  // ══════════════════════════════════════════════════════════════════

  {
    name: "console-login",
    actions: [
      {
        type: "navigate",
        description: "Navigate to console login page",
        url: `${CONSOLE_URL}/login`,
      },
      {
        type: "type",
        description: "Enter admin email",
        target: "email input",
        value: "{{credentials.email}}",
      },
      {
        type: "type",
        description: "Enter admin password",
        target: "password input",
        value: "{{credentials.password}}",
      },
      {
        type: "type",
        description: "Enter organization slug",
        target: "organization input",
        value: "{{credentials.orgSlug}}",
      },
      {
        type: "click",
        description: "Click Sign In",
        target: "Sign In button",
      },
      {
        type: "wait",
        description: "Wait for redirect",
        delayMs: 3000,
      },
      {
        type: "verify",
        description: "Verify dashboard loaded",
        expect: "URL contains /dashboard or /apps, no login form visible",
      },
    ],
    successCriteria: "Logged into Kapable Console as admin",
    screenshotAfter: true,
    timeoutMs: 15000,
  },

  // ══════════════════════════════════════════════════════════════════
  // PHASE 2: Navigate to App Functions
  // ══════════════════════════════════════════════════════════════════

  {
    name: "navigate-to-functions",
    actions: [
      {
        type: "navigate",
        description: "Navigate to apps list",
        url: `${CONSOLE_URL}/apps`,
      },
      {
        type: "wait",
        description: "Wait for apps list to load",
        delayMs: 2000,
      },
      {
        type: "click",
        description: "Click into the Tweety canary app (or first available app)",
        target: "tweety app card or first app in the list",
      },
      {
        type: "wait",
        description: "Wait for app detail page",
        delayMs: 2000,
      },
      {
        type: "click",
        description: "Click into production environment",
        target: "production environment card or link",
      },
      {
        type: "wait",
        description: "Wait for environment page",
        delayMs: 2000,
      },
      {
        type: "click",
        description: "Click Functions tab",
        target: "Functions tab or Functions link in navigation",
      },
      {
        type: "wait",
        description: "Wait for functions list to load",
        delayMs: 2000,
      },
      {
        type: "verify",
        description: "Verify functions page is visible",
        expect: "Functions list or 'No functions' empty state visible, with a Create Function button",
      },
    ],
    successCriteria: "On the Functions tab of the production environment",
    screenshotAfter: true,
    timeoutMs: 20000,
  },

  // ══════════════════════════════════════════════════════════════════
  // PHASE 3: Pre-cleanup — Delete stale test function if exists
  // ══════════════════════════════════════════════════════════════════

  {
    name: "pre-cleanup",
    actions: [
      {
        type: "conditional",
        description: `Check if stale '${FUNCTION_NAME}' exists from previous run`,
        condition: `Page contains text '${FUNCTION_NAME}'`,
        thenActions: [
          {
            type: "click",
            description: "Click into the stale function",
            target: `${FUNCTION_NAME} row or link`,
          },
          {
            type: "wait",
            description: "Wait for function detail page",
            delayMs: 1500,
          },
          {
            type: "click",
            description: "Click Delete button",
            target: "Delete button or Delete Function button",
          },
          {
            type: "wait",
            description: "Wait for confirmation dialog",
            delayMs: 500,
          },
          {
            type: "click",
            description: "Confirm deletion",
            target: "Delete Permanently button or confirm delete button",
          },
          {
            type: "wait",
            description: "Wait for deletion and redirect back to functions list",
            delayMs: 2000,
          },
          {
            type: "verify",
            description: "Verify stale function is gone",
            expect: `Functions list visible, '${FUNCTION_NAME}' is not present`,
          },
        ],
        elseActions: [
          {
            type: "verify",
            description: "Clean slate — no stale function",
            expect: `Functions list visible, '${FUNCTION_NAME}' is not present`,
          },
        ],
      },
    ],
    successCriteria: "No stale sylvester-fn-test function — clean slate",
    screenshotAfter: true,
    timeoutMs: 15000,
  },

  // ══════════════════════════════════════════════════════════════════
  // PHASE 4: Create Function
  // ══════════════════════════════════════════════════════════════════

  {
    name: "create-function",
    actions: [
      {
        type: "click",
        description: "Click Create Function button",
        target: "Create Function button or New Function button",
      },
      {
        type: "wait",
        description: "Wait for create form or dialog",
        delayMs: 1500,
      },
      {
        type: "type",
        description: "Enter function name",
        target: "function name input or Name input",
        value: FUNCTION_NAME,
      },
      {
        type: "type",
        description: "Enter handler name",
        target: "handler name input or Handler input",
        value: "handle",
      },
      {
        type: "type",
        description: "Enter function source code",
        target: "source code textarea or code editor",
        value: FUNCTION_SOURCE,
      },
      {
        type: "click",
        description: "Submit the form",
        target: "Create button or Save button or submit button",
      },
      {
        type: "wait",
        description: "Wait for creation + WASM compilation (up to 30s)",
        delayMs: 15000,
      },
      {
        type: "verify",
        description: "Verify function was created",
        expect: `Function detail page or functions list shows '${FUNCTION_NAME}', status shows compiled or ready`,
      },
    ],
    successCriteria: "Function created and compiled successfully via Console UI",
    screenshotBefore: true,
    screenshotAfter: true,
    timeoutMs: 45000,
  },

  // ══════════════════════════════════════════════════════════════════
  // PHASE 5: View Function Details
  // ══════════════════════════════════════════════════════════════════

  {
    name: "view-function-details",
    actions: [
      {
        type: "conditional",
        description: "Check if already on function detail page",
        condition: `Page shows '${FUNCTION_NAME}' with details like handler, version, runtime`,
        thenActions: [
          {
            type: "verify",
            description: "Already on detail page — verify fields",
            expect: `Function name is '${FUNCTION_NAME}', handler is 'handle', runtime is 'typescript', version >= 1`,
          },
        ],
        elseActions: [
          {
            type: "click",
            description: "Click into the function from the list",
            target: `${FUNCTION_NAME} row or link`,
          },
          {
            type: "wait",
            description: "Wait for function detail page",
            delayMs: 2000,
          },
          {
            type: "verify",
            description: "Verify function detail fields",
            expect: `Function name is '${FUNCTION_NAME}', handler is 'handle', runtime is 'typescript', version >= 1`,
          },
        ],
      },
    ],
    successCriteria: "Function detail page visible with correct metadata",
    screenshotAfter: true,
    timeoutMs: 10000,
  },

  // ══════════════════════════════════════════════════════════════════
  // PHASE 6: Delete Function (Cleanup)
  // ══════════════════════════════════════════════════════════════════

  {
    name: "delete-function",
    actions: [
      {
        type: "click",
        description: "Click Delete button on function detail page",
        target: "Delete button or Delete Function button",
      },
      {
        type: "wait",
        description: "Wait for confirmation dialog",
        delayMs: 500,
      },
      {
        type: "click",
        description: "Confirm deletion",
        target: "Delete Permanently button or confirm delete button",
      },
      {
        type: "wait",
        description: "Wait for deletion and redirect",
        delayMs: 2000,
      },
      {
        type: "verify",
        description: "Verify function is deleted",
        expect: `Functions list visible, '${FUNCTION_NAME}' is not present`,
      },
    ],
    successCriteria: "Function deleted, functions list is clean",
    screenshotAfter: true,
    timeoutMs: 10000,
  },
];

/** The complete Sylvester E2E function-call check plan. */
export const FUNCTION_CALL_PLAN: E2ECheckPlan = {
  name: "function-call",
  harness: "sylvester",
  steps,
  config: {
    consoleUrl: CONSOLE_URL,
    appSlug: "tweety",
    appName: "Tweety",
    framework: "bun-server",
    subdomainUrl: "https://tweety.kapable.run",
    credentials: {
      email: "admin@kapable.dev",
      orgSlug: "kapable",
    },
    testUser: {
      email: "sylvester-fn-test@kapable.dev",
      name: "Sylvester Function Bot",
    },
    kaitBuildPrompt: "",
  },
};
