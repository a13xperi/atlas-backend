export type SuccessResponse<T extends Record<string, unknown>, M = unknown> = {
  ok: true;
  data: T;
  meta?: M;
  timestamp: string;
};

export type ErrorResponse<D = unknown> = {
  ok: false;
  error: string;
  details?: D;
  timestamp: string;
};

export function success<T extends Record<string, unknown>>(data: T): SuccessResponse<T>;
export function success<T extends Record<string, unknown>, M>(data: T, meta: M): SuccessResponse<T, M>;
export function success<T extends Record<string, unknown>, M>(
  data: T,
  meta?: M,
): SuccessResponse<T, M> {
  return {
    ok: true,
    data,
    ...(meta !== undefined ? { meta } : {}),
    timestamp: new Date().toISOString(),
  };
}

export function error(message: string): ErrorResponse;
export function error(message: string, status: number): ErrorResponse;
export function error<D>(message: string, status: number, details: D): ErrorResponse<D>;
export function error<D>(message: string, _status?: number, details?: D): ErrorResponse<D> {
  return {
    ok: false,
    error: message,
    ...(details !== undefined ? { details } : {}),
    timestamp: new Date().toISOString(),
  };
}
