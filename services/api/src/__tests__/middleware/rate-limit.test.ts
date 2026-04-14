import express, { RequestHandler } from "express";
import request from "supertest";

type RedisExecResult = Array<[Error | null, number]>;

function createApp(limiter: RequestHandler, withUserId = false) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());

  if (withUserId) {
    app.use((req, _res, next) => {
      const header = req.headers.authorization;
      if (header?.startsWith("Bearer ")) {
        (req as express.Request & { userId?: string }).userId = header.slice("Bearer ".length);
      }
      next();
    });
  }

  app.get("/limited", limiter, (_req, res) => {
    res.json({ ok: true });
  });

  return app;
}

function createRedisClient(execResult: RedisExecResult) {
  const multi = {
    incr: jest.fn().mockReturnThis(),
    pttl: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(execResult),
  };

  return {
    multi: jest.fn(() => multi),
    pexpire: jest.fn().mockResolvedValue(1),
  };
}

function loadRateLimitModule(options?: {
  redisClient?: {
    multi: jest.Mock;
    pexpire: jest.Mock;
  } | null;
}) {
  jest.resetModules();

  const getRedis = jest.fn(() => options?.redisClient ?? null);

  jest.doMock("../../lib/redis", () => ({
    getRedis,
  }));

  const rateLimitModule = require("../../middleware/rate-limit") as typeof import("../../middleware/rate-limit");

  return {
    ...rateLimitModule,
    getRedis,
  };
}

describe("rate-limit middleware", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it("allows requests under the limit with the in-memory fallback", async () => {
    const { clearRateLimitStore, createRateLimit } = loadRateLimitModule();
    clearRateLimitStore();

    const app = createApp(
      createRateLimit({ name: "unit", max: 2, windowMs: 60_000 }),
    );

    const first = await request(app).get("/limited").set("X-Forwarded-For", "1.1.1.1");
    const second = await request(app).get("/limited").set("X-Forwarded-For", "1.1.1.1");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it("returns 429 with Retry-After once the limit is exceeded", async () => {
    const { clearRateLimitStore, createRateLimit } = loadRateLimitModule();
    clearRateLimitStore();

    const app = createApp(
      createRateLimit({ name: "unit", max: 2, windowMs: 60_000 }),
    );

    await request(app).get("/limited").set("X-Forwarded-For", "2.2.2.2");
    await request(app).get("/limited").set("X-Forwarded-For", "2.2.2.2");
    const limited = await request(app).get("/limited").set("X-Forwarded-For", "2.2.2.2");

    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      error: "Rate limit exceeded",
      retryAfter: expect.any(Number),
    });
    expect(Number(limited.headers["retry-after"])).toBe(limited.body.retryAfter);
  });

  it("keeps different IP buckets independent", async () => {
    const { clearRateLimitStore, createRateLimit } = loadRateLimitModule();
    clearRateLimitStore();

    const app = createApp(
      createRateLimit({ name: "unit", max: 1, windowMs: 60_000 }),
    );

    const firstIp = await request(app).get("/limited").set("X-Forwarded-For", "3.3.3.3");
    const secondIp = await request(app).get("/limited").set("X-Forwarded-For", "4.4.4.4");
    const firstIpAgain = await request(app).get("/limited").set("X-Forwarded-For", "3.3.3.3");

    expect(firstIp.status).toBe(200);
    expect(secondIp.status).toBe(200);
    expect(firstIpAgain.status).toBe(429);
  });

  it("uses the Redis ttl when the bucket already exists", async () => {
    const redisClient = createRedisClient([[null, 3], [null, 1_500]]);
    const { createRateLimit } = loadRateLimitModule({ redisClient });

    const app = createApp(
      createRateLimit({ name: "unit", max: 2, windowMs: 60_000 }),
    );

    const limited = await request(app).get("/limited").set("X-Forwarded-For", "5.5.5.5");

    expect(limited.status).toBe(429);
    expect(limited.body.retryAfter).toBe(2);
    expect(redisClient.multi).toHaveBeenCalledTimes(1);
    expect(redisClient.pexpire).not.toHaveBeenCalled();
  });

  it("initializes Redis expiry when the key is missing a ttl", async () => {
    const redisClient = createRedisClient([[null, 1], [null, -1]]);
    const { createRateLimit } = loadRateLimitModule({ redisClient });

    const app = createApp(
      createRateLimit({ name: "unit", max: 2, windowMs: 60_000 }),
    );

    const res = await request(app).get("/limited").set("X-Forwarded-For", "6.6.6.6");

    expect(res.status).toBe(200);
    expect(redisClient.pexpire).toHaveBeenCalledWith("rate-limit:unit:6.6.6.6", 60_000);
  });

  it("keys the ai preset by userId before falling back to IP", async () => {
    const { aiLimiter, clearRateLimitStore } = loadRateLimitModule();
    clearRateLimitStore();

    const app = createApp(aiLimiter, true);

    for (let i = 0; i < 60; i += 1) {
      const res = await request(app)
        .get("/limited")
        .set("X-Forwarded-For", "7.7.7.7")
        .set("Authorization", "Bearer user-a");

      expect(res.status).toBe(200);
    }

    const otherUser = await request(app)
      .get("/limited")
      .set("X-Forwarded-For", "7.7.7.7")
      .set("Authorization", "Bearer user-b");
    const limited = await request(app)
      .get("/limited")
      .set("X-Forwarded-For", "7.7.7.7")
      .set("Authorization", "Bearer user-a");

    expect(otherUser.status).toBe(200);
    expect(limited.status).toBe(429);
  });

  it("skips rate limiting entirely when NODE_ENV is test", async () => {
    process.env.NODE_ENV = "test";

    const { clearRateLimitStore, createRateLimit, getRedis } = loadRateLimitModule();
    clearRateLimitStore();

    const app = createApp(
      createRateLimit({ name: "unit", max: 1, windowMs: 60_000 }),
    );

    const first = await request(app).get("/limited").set("X-Forwarded-For", "8.8.8.8");
    const second = await request(app).get("/limited").set("X-Forwarded-For", "8.8.8.8");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(getRedis).not.toHaveBeenCalled();
  });
});
