import { Prisma } from "@prisma/client";
import { config } from "./config";

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static notFound(message = "Resource not found"): AppError {
    return new AppError(404, "NOT_FOUND", message);
  }

  static conflict(message = "Resource already exists"): AppError {
    return new AppError(409, "CONFLICT", message);
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError(400, "BAD_REQUEST", message, details);
  }

  static forbidden(message = "Forbidden"): AppError {
    return new AppError(403, "FORBIDDEN", message);
  }

  static unauthorized(message = "Unauthorized"): AppError {
    return new AppError(401, "UNAUTHORIZED", message);
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

const PRISMA_ERROR_MAP: Record<string, { status: number; code: string; message: string }> = {
  P2002: { status: 409, code: "UNIQUE_CONSTRAINT_VIOLATION", message: "A record with this value already exists" },
  P2025: { status: 404, code: "RECORD_NOT_FOUND", message: "Record not found" },
  P2003: { status: 400, code: "FOREIGN_KEY_VIOLATION", message: "Referenced record does not exist" },
};

export function mapPrismaError(err: Prisma.PrismaClientKnownRequestError): AppError {
  const mapped = PRISMA_ERROR_MAP[err.code];
  if (mapped) {
    const target = (err.meta?.target as string[])?.join(", ");
    const message = target ? `${mapped.message} (${target})` : mapped.message;
    return new AppError(mapped.status, mapped.code, message);
  }
  return new AppError(500, "DATABASE_ERROR", "An unexpected database error occurred");
}

export function isPrismaError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError;
}

export interface ErrorResponse {
  error: string;
  code: string;
  message: string;
  requestId?: string;
  details?: unknown;
}

export function formatErrorResponse(
  err: unknown,
  requestId?: string
): { statusCode: number; body: ErrorResponse } {
  if (isAppError(err)) {
    return {
      statusCode: err.statusCode,
      body: {
        error: err.message,
        code: err.code,
        message: err.message,
        requestId,
        ...(err.details && config.NODE_ENV !== "production" ? { details: err.details } : {}),
      },
    };
  }

  if (isPrismaError(err)) {
    const appErr = mapPrismaError(err);
    return formatErrorResponse(appErr, requestId);
  }

  // ZodError
  if (err && typeof err === "object" && "issues" in err) {
    return {
      statusCode: 400,
      body: {
        error: "Validation error",
        code: "VALIDATION_ERROR",
        message: "Invalid request data",
        requestId,
        details: (err as any).issues,
      },
    };
  }

  // Generic error — strip stack in production
  const message = err instanceof Error ? err.message : "Internal server error";
  return {
    statusCode: 500,
    body: {
      error: "Internal server error",
      code: "INTERNAL_ERROR",
      message: config.NODE_ENV === "production" ? "Internal server error" : message,
      requestId,
    },
  };
}
