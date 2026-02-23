/**
 * Status of a check or step execution.
 */
export type CheckStatus = "pass" | "fail" | "warn" | "skip";

/**
 * Result of a single step within a check (e.g. one API call).
 */
export interface StepResult {
  /** Human-readable step name */
  name: string;
  /** Outcome of the step */
  status: CheckStatus;
  /** Wall-clock duration in milliseconds */
  durationMs: number;
  /** Optional detail string (e.g. response summary) */
  detail?: string;
  /** Error message if the step failed */
  error?: string;
}

/**
 * Result of a complete check (group of related steps).
 */
export interface CheckResult {
  /** Check name (used as key in the registry) */
  name: string;
  /** Aggregate status: "pass" if all pass, "warn" if some skip, "fail" if any fail, "skip" if all skip */
  status: CheckStatus;
  /** Total duration for all steps in this check */
  durationMs: number;
  /** Individual step results */
  steps: StepResult[];
  /** Error message if the check itself threw */
  error?: string;
}

/**
 * Summary counters for a canary report.
 */
export interface CanarySummary {
  pass: number;
  fail: number;
  warn: number;
  skip: number;
  total: number;
}

/**
 * Full canary report returned by the runner.
 */
export interface CanaryReport {
  /** ISO timestamp when the report was generated */
  timestamp: string;
  /** Total wall-clock duration for all checks */
  totalDurationMs: number;
  /** Aggregate counters */
  summary: CanarySummary;
  /** Individual check results */
  checks: CheckResult[];
}

/**
 * A check function takes an HttpClient and returns a CheckResult.
 */
export type CheckFn = () => Promise<CheckResult>;
