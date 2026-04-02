import { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    const userId = (req as any).userId;

    logger.info({
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration,
      requestId: req.requestId,
      ...(userId ? { userId } : {}),
      contentLength: res.get("content-length"),
    }, `${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });

  next();
}
