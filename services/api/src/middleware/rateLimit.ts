import { Request, Response, NextFunction } from "express";
import { config } from "../lib/config";
import { buildErrorResponse } from "./requestId";
import { getRedis } from "../lib/redis";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// In-memory fallback store
const memStore = new Map<string, RateLimitEntry>();

/** Clear all rate limit entries — used in tests. */
export function clearRateLimitStore() {
  memStore.clear();
}

// Clean up expired entries every 5 minutes (skip in test to avoid open handles)
if (config.NODE_ENV !== "test") {
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of memStore) {
      if (entry.resetAt <= now) memStore.delete(key);
    }
  }, 5 * 60 * 1000);
  cleanup.unref();
}

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : req.ip;
  return ip || "unknown";
}

async function redisIncr(key: string, windowMs: number): Promise<{ count: number; ttl: number } | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const multi = redis.multi();
    multi.incr(key);
    multi.pttl(key);
    const results = await multi.exec();
    if (!results) return null;
    const count = results[0][1] as number;
    const ttl = results[1][1] as number;
    if (ttl < 0) {
      await redis.pexpire(key, windowMs);
    }
    return { count, ttl: ttl > 0 ? ttl : windowMs };
  } catch {
    return null;
  }
}

function memIncr(key: string, windowMs: number): { count: number; remaining: number; resetAt: number } {
  const now = Date.now();
  const entry = memStore.get(key);

  if (!entry || entry.resetAt <= now) {
    const resetAt = now + windowMs;
    memStore.set(key, { count: 1, resetAt });
    return { count: 1, remaining: 0, resetAt };
  }

  entry.count++;
  return { count: entry.count, remaining: 0, resetAt: entry.resetAt };
}

function setRateLimitHeaders(
  res: Response,
  maxRequests: number,
  count: number,
  resetAt: number
) {
  res.setHeader("X-RateLimit-Limit", maxRequests);
  res.setHeader("X-RateLimit-Remaining", Math.max(0, maxRequests - count));
  res.setHeader("X-RateLimit-Reset", Math.ceil(resetAt / 1000));
}

/**
 * Rate limiter factory. Keys by client IP + path.
 * Uses Redis if available, falls back to in-memory.
 */
export function rateLimit(maxRequests: number, windowMs: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = `rl:${getClientIp(req)}:${req.baseUrl}${req.path}`;

    const redisResult = await redisIncr(key, windowMs);

    if (redisResult) {
      const { count, ttl } = redisResult;
      setRateLimitHeaders(res, maxRequests, count, Date.now() + ttl);
      if (count > maxRequests) {
        const retryAfter = Math.ceil(ttl / 1000);
        res.setHeader("Retry-After", retryAfter);
        return res.status(429).json(
          buildErrorResponse(req, "Too many requests. Please try again later.")
        );
      }
      return next();
    }

    // Fallback to in-memory
    const { count, resetAt } = memIncr(key, windowMs);
    setRateLimitHeaders(res, maxRequests, count, resetAt);

    if (count > maxRequests) {
      const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
      res.setHeader("Retry-After", retryAfter);
      return res.status(429).json(
        buildErrorResponse(req, "Too many requests. Please try again later.")
      );
    }

    next();
  };
}

/**
 * Per-user rate limiter. Keys by userId (from auth middleware).
 * Falls back to IP if userId not available.
 */
export function rateLimitByUser(maxRequests: number, windowMs: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = (req as any).userId || getClientIp(req);
    const key = `rl:user:${userId}:${req.baseUrl}${req.path}`;

    const redisResult = await redisIncr(key, windowMs);

    if (redisResult) {
      const { count, ttl } = redisResult;
      setRateLimitHeaders(res, maxRequests, count, Date.now() + ttl);
      if (count > maxRequests) {
        res.setHeader("Retry-After", Math.ceil(ttl / 1000));
        return res.status(429).json(
          buildErrorResponse(req, "Too many requests. Please try again later.")
        );
      }
      return next();
    }

    const { count, resetAt } = memIncr(key, windowMs);
    setRateLimitHeaders(res, maxRequests, count, resetAt);

    if (count > maxRequests) {
      res.setHeader("Retry-After", Math.ceil((resetAt - Date.now()) / 1000));
      return res.status(429).json(
        buildErrorResponse(req, "Too many requests. Please try again later.")
      );
    }

    next();
  };
}
