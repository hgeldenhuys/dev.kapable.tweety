/**
 * Tweety -- Kapable Platform Canary App
 *
 * A Bun HTTP server that exercises the Kapable API to verify platform health.
 * Routes:
 *   GET /         -- Dashboard landing page with last canary report
 *   GET /health   -- Simple JSON health check (backward compat)
 *   GET /canary   -- Run ALL canary checks, return CanaryReport JSON
 *   GET /canary/:name -- Run a single check by name
 */
import type { CanaryReport } from "./canary/types";
import { runAllChecks, runCheck, getCheckNames } from "./canary/runner";

const port = Number(process.env.PORT) || 3000;
const hostname = "0.0.0.0";

/** In-memory storage for the last canary report */
let lastReport: CanaryReport | null = null;
let isRunning = false;
let runningStartedAt = 0;

/** Max time a canary run can hold the lock (2 minutes) */
const MAX_LOCK_DURATION_MS = 120_000;

/** Check if the lock is stale (hung process) and clear it */
function acquireLock(): boolean {
  if (isRunning) {
    // If the lock has been held for too long, force-clear it
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

/**
 * Build the HTML dashboard page.
 */
function buildDashboardHtml(): string {
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
          throw new Error(resp.status + ' — ' + text.slice(0, 200));
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

const server = Bun.serve({
  port,
  hostname,
  idleTimeout: 120, // seconds — WASM compilation can take 14s+, default 10s drops connection
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // GET / -- Dashboard
    if (path === "/") {
      return new Response(buildDashboardHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // GET /health -- Simple health endpoint (backward compat)
    if (path === "/health") {
      return Response.json({
        status: "ok",
        app: "tweety",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
    }

    // GET /canary -- Run all checks
    if (path === "/canary") {
      if (!acquireLock()) {
        return Response.json(
          { error: "Canary is already running. Please wait for it to finish." },
          { status: 429 },
        );
      }

      try {
        const report = await runAllChecks();
        lastReport = report;
        return Response.json(report);
      } finally {
        isRunning = false;
      }
    }

    // GET /canary/:name -- Run a single check
    const checkMatch = path.match(/^\/canary\/([a-z0-9-]+)$/);
    if (checkMatch) {
      const checkName = checkMatch[1];

      if (!acquireLock()) {
        return Response.json(
          { error: "Canary is already running. Please wait for it to finish." },
          { status: 429 },
        );
      }

      try {
        const result = await runCheck(checkName);
        if (!result) {
          return Response.json(
            { error: `Check "${checkName}" not found. Available: ${getCheckNames().join(", ")}` },
            { status: 404 },
          );
        }
        return Response.json(result);
      } finally {
        isRunning = false;
      }
    }

    // 404
    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`Tweety canary running on ${hostname}:${port}`);
console.log(`  Dashboard: http://localhost:${port}/`);
console.log(`  Health:    http://localhost:${port}/health`);
console.log(`  Canary:    http://localhost:${port}/canary`);
console.log(`  Checks:    ${getCheckNames().join(", ")}`);

// Log env var status at startup
const envVars = ["KAPABLE_API_URL", "KAPABLE_API_KEY", "KAPABLE_ADMIN_KEY", "KAPABLE_ORG_ID", "KAPABLE_PROJECT_ID"];
for (const name of envVars) {
  const val = process.env[name];
  if (val) {
    console.log(`  ${name}: set (${val.slice(0, 8)}...)`);
  } else {
    console.warn(`  ${name}: NOT SET`);
  }
}
