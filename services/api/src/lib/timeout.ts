import { AppError } from "./errors";

export class TimeoutError extends AppError {
  constructor(label: string, ms: number) {
    super(504, "GATEWAY_TIMEOUT", `${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Race a promise against a timeout. Rejects with TimeoutError if the
 * promise doesn't settle within `ms` milliseconds. The timer is cleared
 * on success to prevent dangling handles.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = "operation",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
