import { readFileSync } from "fs";
import * as fsPromises from "fs/promises";
import path from "path";
import { prisma } from "./prisma";
import { getRedis } from "./redis";
import { logger } from "./logger";

export type HealthCheckStatus = "ok" | "error" | "skipped";

export interface HealthCheckResult {
  status: HealthCheckStatus;
  latencyMs: number;
  error?: string;
  [key: string]: unknown;
}

type CheckPayload<T extends Record<string, unknown>> = T & {
  status?: Extract<HealthCheckStatus, "ok" | "skipped">;
  error?: string;
};

let cachedVersion: string | null = null;

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function getPackageJsonPath(): string {
  return path.resolve(process.cwd(), "package.json");
}

export function getAppVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }

  try {
    const contents = readFileSync(getPackageJsonPath(), "utf8");
    const parsed = JSON.parse(contents) as { version?: string };
    cachedVersion = parsed.version || "unknown";
  } catch {
    cachedVersion = process.env.npm_package_version || "unknown";
  }

  return cachedVersion;
}

export async function runCheck<T extends Record<string, unknown>>(
  name: string,
  fn: () => Promise<CheckPayload<T>>,
  timeoutMs: number,
): Promise<HealthCheckResult & T> {
  const startedAt = Date.now();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${name} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);

    return {
      latencyMs: Date.now() - startedAt,
      ...result,
      status: result.status ?? "ok",
    };
  } catch (error) {
    return {
      status: "error",
      latencyMs: Date.now() - startedAt,
      error: formatError(error),
    } as HealthCheckResult & T;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export async function checkDb(timeoutMs = 2_000): Promise<HealthCheckResult> {
  const startedAt = Date.now();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);

    return { status: "ok", latencyMs: Date.now() - startedAt };
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : String(error) }, "Database health check failed");
    return { status: "error", latencyMs: Date.now() - startedAt, error: "db_unreachable" };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export async function checkRedis(timeoutMs = 2_000): Promise<HealthCheckResult> {
  const startedAt = Date.now();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    if (!process.env.REDIS_URL) {
      return { status: "skipped", latencyMs: Date.now() - startedAt };
    }

    const redis = getRedis();
    if (!redis) {
      throw new Error("Redis client unavailable");
    }

    await Promise.race([
      redis.ping(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);

    return { status: "ok", latencyMs: Date.now() - startedAt };
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : String(error) }, "Redis health check failed");
    return { status: "error", latencyMs: Date.now() - startedAt, error: "redis_unreachable" };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export function checkOpenAI(timeoutMs = 2_000): Promise<HealthCheckResult> {
  return runCheck("openai", async () => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { status: "skipped" };
    }

    const response = await fetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`OpenAI responded with ${response.status}`);
    }

    return {};
  }, timeoutMs);
}

export function checkAnthropic(timeoutMs = 2_000): Promise<HealthCheckResult> {
  return runCheck("anthropic", async () => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return { status: "skipped" };
    }

    const response = await fetch("https://api.anthropic.com/v1/models", {
      method: "GET",
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Anthropic responded with ${response.status}`);
    }

    return {};
  }, timeoutMs);
}

export function checkXai(timeoutMs = 2_000): Promise<HealthCheckResult> {
  return runCheck("xai", async () => {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      return { status: "skipped" };
    }

    const response = await fetch("https://api.x.ai/v1/models", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`xAI responded with ${response.status}`);
    }

    return {};
  }, timeoutMs);
}

export function checkMemory(timeoutMs = 2_000): Promise<HealthCheckResult> {
  return runCheck("memory", async () => {
    const usage = process.memoryUsage();

    return {
      rssBytes: usage.rss,
      heapTotalBytes: usage.heapTotal,
      heapUsedBytes: usage.heapUsed,
      externalBytes: usage.external,
      arrayBuffersBytes: usage.arrayBuffers,
    };
  }, timeoutMs);
}

export function checkDisk(timeoutMs = 2_000): Promise<HealthCheckResult> {
  return runCheck("disk", async () => {
    if (typeof fsPromises.statfs !== "function") {
      return { status: "skipped" };
    }

    const stats = await fsPromises.statfs(process.cwd());
    const blockSize = Number(stats.bsize);
    const freeBlocks = Number(stats.bavail ?? stats.bfree);
    const totalBlocks = Number(stats.blocks);

    return {
      freeBytes: blockSize * freeBlocks,
      totalBytes: blockSize * totalBlocks,
    };
  }, timeoutMs);
}
