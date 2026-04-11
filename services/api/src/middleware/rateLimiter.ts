import { Request, Response, NextFunction } from "express";
import { config } from "../lib/config";
import { getRedis } from "../lib/redis";
import { buildErrorResponse } from "./requestId";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

type KeyResolver = (req: Request) => string;

const memStore = new Map<string, RateLimitEntry>();

export function clearRateLimitStore() {
  memStore.clear();
}

if (config.NODE_ENV !== "test") {
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of memStore) {
      if (entry.resetAt <= now) {
        memStore.delete(key);
      }
    }
  }, 5 * 60 * 1000);
  cleanup.unref();
}

async function redisIncr(key: string, windowMs: number): Promise<{ count: number; ttl: number } | null> {
  const redis = getRedis();
  if (!redis) {
    return null;
  }

  try {
    const multi = redis.multi();
    multi.incr(key);
    multi.pttl(key);
    const results = await multi.exec();

    if (!results) {
      return null;
    }

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

function memIncr(key: string, windowMs: number): { count: number; resetAt: number } {
  const now = Date.now();
  const entry = memStore.get(key);

  if (!entry || entry.resetAt <= now) {
    const resetAt = now + windowMs;
    memStore.set(key, { count: 1, resetAt });
    return { count: 1, resetAt };
  }

  entry.count += 1;
  return { count: entry.count, resetAt: entry.resetAt };
}

function setRateLimitHeaders(res: Response, maxRequests: number, count: number, resetAt: number) {
  res.setHeader("X-RateLimit-Limit", maxRequests);
  res.setHeader("X-RateLimit-Remaining", Math.max(0, maxRequests - count));
  res.setHeader("X-RateLimit-Reset", Math.ceil(resetAt / 1000));
}

function createRateLimit(maxRequests: number, windowMs: number, resolveKey: KeyResolver) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = resolveKey(req);
    const redisResult = await redisIncr(key, windowMs);

    if (redisResult) {
      const { count, ttl } = redisResult;
      setRateLimitHeaders(res, maxRequests, count, Date.now() + ttl);

      if (count > maxRequests) {
        res.setHeader("Retry-After", Math.ceil(ttl / 1000));
        return res
          .status(429)
          .json(buildErrorResponse(req, "Too many requests. Please try again later."));
      }

      return next();
    }

    const { count, resetAt } = memIncr(key, windowMs);
    setRateLimitHeaders(res, maxRequests, count, resetAt);

    if (count > maxRequests) {
      res.setHeader("Retry-After", Math.ceil((resetAt - Date.now()) / 1000));
      return res
        .status(429)
        .json(buildErrorResponse(req, "Too many requests. Please try again later."));
    }

    next();
  };
}

/**
 * IP-based rate limiter.
 *
 * @param namespace Optional key-space prefix. Use this when stacking multiple
 *   limiters on the same route (e.g. a tight per-route login limit on top of
 *   the general auth router limit) so each limiter keeps its own counter.
 *   Limiters that share a namespace share a counter, which causes the two
 *   windows to collide and the tighter one to be silently ignored.
 */
export function rateLimit(maxRequests: number, windowMs: number, namespace?: string) {
  const prefix = namespace ? `rl:${namespace}` : "rl";
  return createRateLimit(
    maxRequests,
    windowMs,
    (req) => `${prefix}:${req.ip ?? "unknown"}:${req.baseUrl}${req.path}`,
  );
}

export function rateLimitByUser(maxRequests: number, windowMs: number) {
  return createRateLimit(
    maxRequests,
    windowMs,
    (req) => `rl:user:${(req as any).userId || (req.ip ?? "unknown")}:${req.baseUrl}${req.path}`,
  );
}
