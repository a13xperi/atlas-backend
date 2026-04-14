import request from "supertest";
import express from "express";
import { statfs } from "fs/promises";
import { healthRouter } from "../../routes/health";
import { requestIdMiddleware } from "../../middleware/requestId";

jest.mock("../../lib/prisma", () => ({
  prisma: { $queryRaw: jest.fn().mockResolvedValue([{ "?column?": 1 }]) },
}));

jest.mock("../../lib/redis", () => ({
  getRedis: jest.fn(() => null),
}));

jest.mock("fs/promises", () => ({
  statfs: jest.fn(),
}));

import { prisma } from "../../lib/prisma";
import { getRedis } from "../../lib/redis";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockGetRedis = getRedis as jest.MockedFunction<typeof getRedis>;
const mockStatfs = statfs as jest.MockedFunction<typeof statfs>;
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use(healthRouter);

const originalFetch = global.fetch;

beforeAll(() => {
  global.fetch = mockFetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.REDIS_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.XAI_API_KEY;

  mockPrisma.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  mockGetRedis.mockReturnValue(null);
  mockStatfs.mockResolvedValue({
    type: 0,
    bsize: 4_096,
    blocks: 1_000,
    bfree: 500,
    bavail: 400,
    files: 1_000,
    ffree: 500,
  } as Awaited<ReturnType<typeof statfs>>);
  mockFetch.mockReset();
});

describe("health routes", () => {
  it("returns the existing basic /health payload", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.database).toBe("ok");
    expect(res.body.cache).toBe("unavailable");
    expect(res.body.version).toBe("0.1.0");
    expect(typeof res.body.uptime).toBe("number");
    expect(res.body.uptime).toBeGreaterThan(0);
  });

  it("reports healthy when required checks pass and optional checks are skipped", async () => {
    const res = await request(app).get("/health/full");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("healthy");
    expect(res.body.checks.db.status).toBe("ok");
    expect(res.body.checks.redis.status).toBe("skipped");
    expect(res.body.checks.openai.status).toBe("skipped");
    expect(res.body.checks.anthropic.status).toBe("skipped");
    expect(res.body.checks.xai.status).toBe("skipped");
    expect(res.body.checks.memory.status).toBe("ok");
    expect(res.body.checks.disk.status).toBe("ok");
    expect(res.body.checks.disk.freeBytes).toBe(1_638_400);
  });

  it("returns 503 unhealthy when the database check fails", async () => {
    mockPrisma.$queryRaw.mockRejectedValueOnce(new Error("db unavailable"));

    const res = await request(app).get("/health/full");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unhealthy");
    expect(res.body.checks.db.status).toBe("error");
    expect(res.body.checks.db.error).toBe("db unavailable");
  });

  it("marks redis as skipped when REDIS_URL is absent", async () => {
    const res = await request(app).get("/health/full");

    expect(res.status).toBe(200);
    expect(res.body.checks.redis.status).toBe("skipped");
    expect(mockGetRedis).not.toHaveBeenCalled();
  });

  it("returns degraded when an optional provider fails", async () => {
    process.env.OPENAI_API_KEY = "openai-key";
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response);

    const res = await request(app).get("/health/full");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("degraded");
    expect(res.body.checks.openai.status).toBe("error");
    expect(res.body.checks.openai.error).toBe("OpenAI responded with 500");
  });

  it("times out slow optional checks after two seconds", async () => {
    process.env.OPENAI_API_KEY = "openai-key";
    mockFetch.mockImplementationOnce(
      () => new Promise<Response>(() => undefined),
    );

    const startedAt = Date.now();
    const res = await request(app).get("/health/full");
    const elapsedMs = Date.now() - startedAt;

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("degraded");
    expect(res.body.checks.openai.status).toBe("error");
    expect(res.body.checks.openai.error).toBe("openai timed out after 2000ms");
    expect(elapsedMs).toBeGreaterThanOrEqual(1_900);
    expect(elapsedMs).toBeLessThan(3_500);
  });

  it("returns valid ISO timestamps on the full diagnostics route", async () => {
    const res = await request(app).get("/health/full");

    expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
  });
});
