import crypto from "crypto";
import { NextFunction, Request, Response } from "express";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const requestId = crypto.randomUUID();

  req.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);

  next();
}

export function buildErrorResponse(
  req: Request,
  error: string,
  options?: {
    details?: unknown;
    message?: string;
  }
) {
  return {
    error,
    message: options?.message ?? error,
    requestId: req.requestId,
    ...(options?.details !== undefined ? { details: options.details } : {}),
  };
}

export {};
