import { Request, Response, NextFunction } from "express";
import { buildErrorResponse } from "./requestId";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

/** Clear all rate limit entries — used in tests. */
export function clearRateLimitStore() {
  store.clear();
}

// Clean up expired entries every 5 minutes (skip in test to avoid open handles)
if (process.env.NODE_ENV !== "test") {
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) store.delete(key);
    }
  }, 5 * 60 * 1000);
  cleanup.unref();
}

function getClientKey(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : req.ip;
  return ip || "unknown";
}

/**
 * In-memory rate limiter.
 * @param maxRequests Max requests within the window
 * @param windowMs Time window in milliseconds
 */
export function rateLimit(maxRequests: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${getClientKey(req)}:${req.baseUrl}${req.path}`;
    const now = Date.now();
    const entry = store.get(key);

    if (!entry || entry.resetAt <= now) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      res.setHeader("X-RateLimit-Limit", maxRequests);
      res.setHeader("X-RateLimit-Remaining", maxRequests - 1);
      return next();
    }

    if (entry.count >= maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader("Retry-After", retryAfter);
      res.setHeader("X-RateLimit-Limit", maxRequests);
      res.setHeader("X-RateLimit-Remaining", 0);
      return res.status(429).json(
        buildErrorResponse(req, "Too many requests. Please try again later.")
      );
    }

    entry.count++;
    res.setHeader("X-RateLimit-Limit", maxRequests);
    res.setHeader("X-RateLimit-Remaining", maxRequests - entry.count);
    next();
  };
}
