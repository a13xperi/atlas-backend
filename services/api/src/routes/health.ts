import { Router, type Request, type Response, type NextFunction } from "express";
import {
  checkAnthropic,
  checkDb,
  checkDisk,
  checkMemory,
  checkOpenAI,
  checkRedis,
  checkXai,
  getAppVersion,
  type HealthCheckResult,
} from "../lib/health-checks";
import { prisma } from "../lib/prisma";
import { getRedis } from "../lib/redis";
import { rateLimit } from "../middleware/rateLimit";
import { logger } from "../lib/logger";

const FULL_CHECK_TIMEOUT_MS = 2_000;

const fullHealthRateLimiter = rateLimit(6, 60 * 1000, "health-full");

function requireAdminToken(req: Request, res: Response, next: NextFunction) {
  const token = process.env.ADMIN_HEALTH_TOKEN;
  if (!token) {
    logger.warn("ADMIN_HEALTH_TOKEN is not set; /health/full is inaccessible");
    return res.status(503).json({ error: "Health diagnostics unavailable" });
  }
  const header = req.headers["x-admin-token"];
  if (header !== token) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function settledResultToCheck(result: PromiseSettledResult<HealthCheckResult>): HealthCheckResult {
  if (result.status === "fulfilled") {
    return result.value;
  }

  return {
    status: "error",
    latencyMs: FULL_CHECK_TIMEOUT_MS,
    error: result.reason instanceof Error ? result.reason.message : String(result.reason),
  };
}

export const healthRouter = Router();

healthRouter.use((_req, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex");
  res.setHeader("Cache-Control", "no-store");
  next();
});

healthRouter.get("/health", async (_req, res) => {
  try {
    let database: "ok" | "error" = "ok";
    let cache: "ok" | "unavailable" = "unavailable";

    try {
      await prisma.$queryRaw`SELECT 1`;
      database = "ok";
    } catch {
      database = "error";
    }

    try {
      const redis = getRedis();
      if (!redis) {
        throw new Error("Redis unavailable");
      }

      await redis.ping();
      cache = "ok";
    } catch {
      cache = "unavailable";
    }

    res.status(database === "error" ? 503 : 200).json({
      status: "ok",
      version: getAppVersion(),
      uptime: process.uptime(),
      database,
      cache,
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(500).json({ error: "Failed to run health check" });
  }
});

healthRouter.get("/health/full", fullHealthRateLimiter, requireAdminToken, async (_req, res) => {
  try {
    const settledChecks = await Promise.allSettled([
      checkDb(FULL_CHECK_TIMEOUT_MS),
      checkRedis(FULL_CHECK_TIMEOUT_MS),
      checkOpenAI(FULL_CHECK_TIMEOUT_MS),
      checkAnthropic(FULL_CHECK_TIMEOUT_MS),
      checkXai(FULL_CHECK_TIMEOUT_MS),
      checkMemory(FULL_CHECK_TIMEOUT_MS),
      checkDisk(FULL_CHECK_TIMEOUT_MS),
    ]);

    const checks = {
      db: settledResultToCheck(settledChecks[0]),
      redis: settledResultToCheck(settledChecks[1]),
      openai: settledResultToCheck(settledChecks[2]),
      anthropic: settledResultToCheck(settledChecks[3]),
      xai: settledResultToCheck(settledChecks[4]),
      memory: settledResultToCheck(settledChecks[5]),
      disk: settledResultToCheck(settledChecks[6]),
    };

    const status =
      checks.db.status === "error"
        ? "unhealthy"
        : Object.entries(checks).some(([name, check]) => name !== "db" && check.status === "error")
          ? "degraded"
          : "healthy";

    res.status(status === "unhealthy" ? 503 : 200).json({
      status,
      uptime: process.uptime(),
      version: getAppVersion(),
      checks,
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(500).json({ error: "Failed to run full health diagnostics" });
  }
});
