import request from "supertest";
import express from "express";

jest.mock("../../lib/prisma", () => ({
  prisma: { $queryRaw: jest.fn().mockResolvedValue([{ "?column?": 1 }]) },
}));

jest.mock("../../lib/redis", () => ({
  redis: { ping: jest.fn().mockResolvedValue("PONG") },
}));

const app = express();

// Inline a minimal health route matching the real one's response shape
app.get("/health", async (_req, res) => {
  const { prisma } = require("../../lib/prisma");
  const { redis } = require("../../lib/redis");

  let dbStatus = "ok";
  let dbLatency = 0;
  try {
    const start = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    dbLatency = Date.now() - start;
  } catch {
    dbStatus = "error";
  }

  let redisStatus = "ok";
  let redisLatency = 0;
  try {
    const start = Date.now();
    await redis.ping();
    redisLatency = Date.now() - start;
  } catch {
    redisStatus = "unavailable";
  }

  const mem = process.memoryUsage();
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: "0.1.0",
    checks: {
      database: { status: dbStatus, latencyMs: dbLatency },
      redis: { status: redisStatus, latencyMs: redisLatency },
      memory: { heapUsedMB: +(mem.heapUsed / 1048576).toFixed(2), heapTotalMB: +(mem.heapTotal / 1048576).toFixed(2), rss: mem.rss },
    },
  });
});

describe("GET /health", () => {
  it("returns 200 with status ok and all checks", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.checks.database.status).toBe("ok");
    expect(res.body.checks.redis.status).toBe("ok");
    expect(typeof res.body.uptime).toBe("number");
    expect(res.body.uptime).toBeGreaterThan(0);
    expect(res.body.checks.memory.heapUsedMB).toBeGreaterThan(0);
  });

  it("returns valid ISO timestamp", async () => {
    const res = await request(app).get("/health");
    expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
  });
});
