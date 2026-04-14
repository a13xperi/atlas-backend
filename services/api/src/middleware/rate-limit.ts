import { NextFunction, Request, RequestHandler, Response } from "express";
import { getRedis } from "../lib/redis";

interface MemoryBucket {
  count: number;
  expiresAt: number;
}

export interface CreateRateLimitOptions {
  name: string;
  max: number;
  windowMs: number;
  keyBy?: (req: Request) => string;
}

const memoryBuckets = new Map<string, MemoryBucket>();

function defaultKeyBy(req: Request): string {
  return req.ip || "unknown";
}

export function keyByUserIdOrIp(req: Request): string {
  const userId = (req as Request & { userId?: string }).userId;
  return userId || req.ip || "unknown";
}

function retryAfterFromMs(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

function pruneExpiredMemoryBuckets(now: number) {
  for (const [key, bucket] of memoryBuckets) {
    if (bucket.expiresAt <= now) {
      memoryBuckets.delete(key);
    }
  }
}

function incrementMemoryBucket(
  bucketKey: string,
  windowMs: number,
): { count: number; retryAfter: number } {
  const now = Date.now();

  if (memoryBuckets.size > 1_000) {
    pruneExpiredMemoryBuckets(now);
  }

  const existing = memoryBuckets.get(bucketKey);
  if (!existing || existing.expiresAt <= now) {
    const expiresAt = now + windowMs;
    memoryBuckets.set(bucketKey, { count: 1, expiresAt });
    return { count: 1, retryAfter: retryAfterFromMs(windowMs) };
  }

  existing.count += 1;
  return {
    count: existing.count,
    retryAfter: retryAfterFromMs(existing.expiresAt - now),
  };
}

async function incrementRedisBucket(
  bucketKey: string,
  windowMs: number,
): Promise<{ count: number; retryAfter: number } | null> {
  const redis = getRedis();
  if (!redis) {
    return null;
  }

  try {
    const pipeline = redis.multi();
    pipeline.incr(bucketKey);
    pipeline.pttl(bucketKey);
    const results = await pipeline.exec();

    if (!results) {
      return null;
    }

    const count = Number(results[0]?.[1]);
    let ttlMs = Number(results[1]?.[1]);

    if (!Number.isFinite(count)) {
      return null;
    }

    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      await redis.pexpire(bucketKey, windowMs);
      ttlMs = windowMs;
    }

    return {
      count,
      retryAfter: retryAfterFromMs(ttlMs),
    };
  } catch {
    return null;
  }
}

export function clearRateLimitStore() {
  memoryBuckets.clear();
}

export function createRateLimit({
  name,
  max,
  windowMs,
  keyBy = defaultKeyBy,
}: CreateRateLimitOptions): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (process.env.NODE_ENV === "test") {
      return next();
    }

    const subjectKey = keyBy(req) || defaultKeyBy(req);
    const bucketKey = `rate-limit:${name}:${subjectKey}`;
    const bucket =
      (await incrementRedisBucket(bucketKey, windowMs)) ??
      incrementMemoryBucket(bucketKey, windowMs);

    if (bucket.count > max) {
      res.setHeader("Retry-After", String(bucket.retryAfter));
      return res.status(429).json({
        error: "Rate limit exceeded",
        retryAfter: bucket.retryAfter,
      });
    }

    return next();
  };
}

export function rateLimit(max: number, windowMs: number, name = "ip") {
  return createRateLimit({
    name,
    max,
    windowMs,
  });
}

export function rateLimitByUser(max: number, windowMs: number, name = "user") {
  return createRateLimit({
    name,
    max,
    windowMs,
    keyBy: keyByUserIdOrIp,
  });
}

export const authLimiter = createRateLimit({
  name: "auth",
  max: 10,
  windowMs: 60_000,
});

export const aiLimiter = createRateLimit({
  name: "ai",
  max: 60,
  windowMs: 60_000,
  keyBy: keyByUserIdOrIp,
});

export const defaultLimiter = createRateLimit({
  name: "default",
  max: 300,
  windowMs: 60_000,
  keyBy: keyByUserIdOrIp,
});
