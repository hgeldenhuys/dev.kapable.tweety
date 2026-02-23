/**
 * HTTP helper wrapping fetch() with auth, timing, and error handling
 * for Kapable API calls.
 */

export type AuthMode = "api-key" | "admin-key" | "none";

export interface HttpResponse<T = unknown> {
  /** HTTP status code */
  status: number;
  /** Parsed response body (JSON) or null on parse failure */
  data: T | null;
  /** Raw response text (useful when JSON parse fails) */
  rawText: string;
  /** Wall-clock duration in milliseconds */
  durationMs: number;
  /** Error string if the request itself failed */
  error?: string;
}

export interface HttpClientConfig {
  baseUrl: string;
  apiKey: string;
  adminKey: string;
  /** Timeout per request in milliseconds (default 10000) */
  timeoutMs?: number;
}

/**
 * Lightweight HTTP client for canary API calls.
 * No external dependencies -- uses built-in fetch.
 */
export class HttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly adminKey: string;
  private readonly timeoutMs: number;

  constructor(config: HttpClientConfig) {
    // Strip trailing slash from base URL
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.adminKey = config.adminKey;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  /**
   * Issue an HTTP request to the Kapable API.
   *
   * @param method - HTTP method
   * @param path - Path relative to base URL (must start with /)
   * @param options - Optional body and auth mode
   */
  async request<T = unknown>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      auth?: AuthMode;
      headers?: Record<string, string>;
    },
  ): Promise<HttpResponse<T>> {
    const auth = options?.auth ?? "none";
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      "Accept": "application/json",
      ...options?.headers,
    };

    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    if (auth === "api-key") {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    } else if (auth === "admin-key") {
      headers["x-api-key"] = this.adminKey;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const start = performance.now();
    let status = 0;
    let rawText = "";
    let data: T | null = null;
    let error: string | undefined;

    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      status = resp.status;
      rawText = await resp.text();

      try {
        data = JSON.parse(rawText) as T;
      } catch {
        // Response was not JSON -- keep rawText for diagnosis
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        error = `Request timed out after ${this.timeoutMs}ms`;
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

  /** Convenience: GET */
  async get<T = unknown>(path: string, auth: AuthMode = "none"): Promise<HttpResponse<T>> {
    return this.request<T>("GET", path, { auth });
  }

  /** Convenience: POST with JSON body */
  async post<T = unknown>(path: string, body: unknown, auth: AuthMode = "api-key"): Promise<HttpResponse<T>> {
    return this.request<T>("POST", path, { body, auth });
  }

  /** Convenience: PUT with JSON body */
  async put<T = unknown>(path: string, body: unknown, auth: AuthMode = "api-key"): Promise<HttpResponse<T>> {
    return this.request<T>("PUT", path, { body, auth });
  }

  /** Convenience: PATCH with JSON body */
  async patch<T = unknown>(path: string, body: unknown, auth: AuthMode = "api-key"): Promise<HttpResponse<T>> {
    return this.request<T>("PATCH", path, { body, auth });
  }

  /** Convenience: DELETE */
  async delete<T = unknown>(path: string, auth: AuthMode = "api-key"): Promise<HttpResponse<T>> {
    return this.request<T>("DELETE", path, { auth });
  }
}

/**
 * Create an HttpClient from environment variables.
 * Logs warnings for missing variables but does not throw.
 */
export function createHttpClient(): HttpClient {
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
