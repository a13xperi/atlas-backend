import { logger } from "./logger";

interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** HTTP status codes that should trigger a retry */
  retryableStatuses?: number[];
}

const DEFAULTS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  retryableStatuses: [429, 500, 502, 503, 504],
};

function isRetryable(err: unknown, statuses: number[]): boolean {
  if (err == null || typeof err !== "object") return false;

  // Google Generative AI errors expose .status
  const status =
    (err as { status?: number }).status ??
    (err as { statusCode?: number }).statusCode ??
    (err as { response?: { status?: number } }).response?.status;

  if (status && statuses.includes(status)) return true;

  // OpenAI SDK wraps rate-limit errors in APIError with .status
  const name = (err as { name?: string }).name ?? "";
  if (name === "RateLimitError" || name === "InternalServerError") return true;

  // Network-level errors
  const code = (err as { code?: string }).code;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND") return true;

  return false;
}

function jitteredDelay(base: number, attempt: number, max: number): number {
  const exponential = base * 2 ** attempt;
  const capped = Math.min(exponential, max);
  // Add ±25% jitter
  return capped * (0.75 + Math.random() * 0.5);
}

/**
 * Retry an async function with exponential backoff + jitter.
 * Only retries on transient HTTP errors (429, 5xx) and network failures.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  opts?: RetryOptions,
): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs, retryableStatuses } = {
    ...DEFAULTS,
    ...opts,
  };

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt === maxRetries || !isRetryable(err, retryableStatuses)) {
        break;
      }

      const delay = jitteredDelay(baseDelayMs, attempt, maxDelayMs);
      logger.warn(
        { attempt: attempt + 1, maxRetries, delayMs: Math.round(delay), label },
        `[retry] ${label} — attempt ${attempt + 1} failed, retrying in ${Math.round(delay)}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
