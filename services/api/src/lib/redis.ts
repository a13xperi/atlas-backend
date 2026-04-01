import Redis from "ioredis";
import { config } from "./config";

let redis: Redis | null = null;

export function getRedis(): Redis | null {
  if (!redis && config.REDIS_URL) {
    try {
      redis = new Redis(config.REDIS_URL);
    } catch {
      console.warn("Redis connection failed — caching disabled");
      return null;
    }
  }
  return redis;
}

export async function getCached(key: string): Promise<string | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    return await r.get(key);
  } catch {
    return null;
  }
}

export async function setCache(key: string, value: string, ttlSeconds: number): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(key, value, "EX", ttlSeconds);
  } catch {
    // cache failure is non-fatal
  }
}
