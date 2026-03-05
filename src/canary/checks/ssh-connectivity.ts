/**
 * SSH Connectivity Check (IMP-318)
 *
 * Verifies that the canary can reach the production server via SSH.
 * This validates that:
 *  - Network connectivity to the production host is intact
 *  - The deploy SSH key is present and accepted
 *  - The SSH daemon on the production host is running
 *
 * Uses ConnectTimeout=5 to fail fast. Uses BatchMode=yes to suppress
 * password prompts (fails immediately if key auth is unavailable).
 *
 * Returns "warn" (not "fail") if SSH keys are absent on the current host,
 * to prevent false alarms in environments without deploy key access
 * (e.g., local development, CI runners without secrets).
 */
import type { HttpClient } from "../http";
import type { CheckResult, StepResult } from "../types";

// SSH target alias. In production the SSH config resolves this to the
// correct IP and user. On dev machines without the alias, the check is skipped.
const SSH_HOST = "kapable-prod";
const SSH_USER = "deploy";
const CONNECT_TIMEOUT_SECS = 5;

// Max time we'll wait for the entire spawn to complete (ms).
// ConnectTimeout handles the network layer; this guards against hang scenarios.
const SPAWN_TIMEOUT_MS = 10_000;

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run an SSH connectivity probe.
 *
 * Command: ssh -o BatchMode=yes -o ConnectTimeout=5
 *              -o StrictHostKeyChecking=accept-new
 *              deploy@kapable-prod exit
 *
 * Exit codes:
 *   0  — SSH connected and "exit" ran successfully
 *   255 — SSH-level failure (network, host key, auth)
 *   other — Shell error on remote
 */
async function runSshProbe(): Promise<SpawnResult> {
  const args = [
    "ssh",
    "-o", `ConnectTimeout=${CONNECT_TIMEOUT_SECS}`,
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "LogLevel=ERROR",
    `${SSH_USER}@${SSH_HOST}`,
    "exit",
  ];

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Race the process against the spawn timeout
  let timedOut = false;
  let exitCode: number | null = null;

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, SPAWN_TIMEOUT_MS);

  try {
    exitCode = await proc.exited;
  } finally {
    clearTimeout(timeoutHandle);
  }

  const [stdoutBuf, stderrBuf] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
  ]);

  return {
    exitCode: timedOut ? null : exitCode,
    stdout: stdoutBuf.trim(),
    stderr: stderrBuf.trim(),
    timedOut,
  };
}

export async function sshConnectivityCheck(_http: HttpClient): Promise<CheckResult> {
  const steps: StepResult[] = [];
  const checkStart = performance.now();

  // Step 1: Verify ssh binary is available
  const whichStart = performance.now();
  let sshAvailable = false;
  try {
    const whichProc = Bun.spawn(["which", "ssh"], { stdout: "pipe", stderr: "pipe" });
    const whichCode = await whichProc.exited;
    sshAvailable = whichCode === 0;
  } catch {
    sshAvailable = false;
  }

  const whichDuration = Math.round(performance.now() - whichStart);
  const sshBinaryStep: StepResult = {
    name: "ssh binary present",
    status: sshAvailable ? "pass" : "skip",
    durationMs: whichDuration,
    detail: sshAvailable ? "ssh found in PATH" : undefined,
    error: sshAvailable ? undefined : "ssh not found in PATH — skipping connectivity probe",
  };
  steps.push(sshBinaryStep);

  if (!sshAvailable) {
    return buildResult("ssh-connectivity", steps, checkStart);
  }

  // Step 2: Probe SSH connectivity
  const probeStart = performance.now();
  const result = await runSshProbe();
  const probeDuration = Math.round(performance.now() - probeStart);

  const connectStep: StepResult = {
    name: `ssh ${SSH_USER}@${SSH_HOST} exit`,
    status: "pass",
    durationMs: probeDuration,
  };

  if (result.timedOut) {
    connectStep.status = "fail";
    connectStep.error = `SSH probe timed out after ${SPAWN_TIMEOUT_MS}ms`;
  } else if (result.exitCode === 255) {
    // Exit code 255: SSH-level failure (network, bad host key, auth refused).
    // Distinguish "no key available" (auth failure) from actual unreachability.
    const isAuthFailure =
      result.stderr.includes("Permission denied") ||
      result.stderr.includes("publickey") ||
      result.stderr.includes("authentication failed");

    if (isAuthFailure) {
      // Key not present or not accepted — warn, don't fail (CI/dev environment)
      connectStep.status = "warn";
      connectStep.error = "SSH key auth not available — deploy key may not be configured on this host";
      connectStep.detail = result.stderr.slice(0, 200);
    } else {
      connectStep.status = "fail";
      connectStep.error = `SSH connection failed (exit 255): ${result.stderr.slice(0, 200) || "no error detail"}`;
    }
  } else if (result.exitCode !== 0) {
    connectStep.status = "fail";
    connectStep.error = `SSH exited with code ${result.exitCode}: ${result.stderr.slice(0, 200)}`;
  } else {
    // Exit 0: connected and ran "exit" successfully
    connectStep.detail = `Connected to ${SSH_HOST} in ${probeDuration}ms`;
  }

  steps.push(connectStep);

  // Step 3: Latency check — warn if SSH handshake took longer than 3000ms
  const latencyStep: StepResult = {
    name: `SSH round-trip latency < ${CONNECT_TIMEOUT_SECS * 1000}ms`,
    status: "pass",
    durationMs: probeDuration,
  };

  if (result.timedOut) {
    latencyStep.status = "fail";
    latencyStep.error = "Timed out — latency check skipped";
  } else if (connectStep.status === "pass" && probeDuration > 3000) {
    latencyStep.status = "warn";
    latencyStep.error = `SSH latency ${probeDuration}ms exceeds 3000ms warning threshold`;
  } else if (connectStep.status === "pass") {
    latencyStep.detail = `${probeDuration}ms`;
  } else {
    latencyStep.status = "skip";
    latencyStep.detail = "Skipped — connection step did not pass";
  }

  steps.push(latencyStep);

  return buildResult("ssh-connectivity", steps, checkStart);
}

function buildResult(name: string, steps: StepResult[], checkStart: number): CheckResult {
  const totalDuration = Math.round(performance.now() - checkStart);
  let hasFail = false;
  let hasWarn = false;
  let hasPass = false;
  let hasSkip = false;

  for (const step of steps) {
    if (step.status === "fail") hasFail = true;
    else if (step.status === "warn") hasWarn = true;
    else if (step.status === "pass") hasPass = true;
    else hasSkip = true;
  }

  const status = hasFail
    ? "fail"
    : hasWarn
    ? "warn"
    : !hasPass && hasSkip
    ? "skip"
    : "pass";

  return { name, status, durationMs: totalDuration, steps };
}
