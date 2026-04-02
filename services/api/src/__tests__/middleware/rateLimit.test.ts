/**
 * Rate limit middleware test suite
 * Tests: in-memory limiting, window expiry, Redis-backed limiting, authenticated user bucketing
 * Mocks: Redis accessor, config
 */

import express, { RequestHandler } from "express";
import request from "supertest";
import { requestIdMiddleware } from "../../middleware/requestId";

type RedisExecResult = [[null, number], [null, number]];

function createIpLimitedApp(limiter: RequestHandler) {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.get("/limited", limiter, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

function createUserLimitedApp(limiter: RequestHandler) {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use((req, _res, next) => {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      (req as any).userId = header.slice("Bearer ".length);
    }
    next();
  });
  app.get("/limited", limiter, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

function loadRateLimitModule(options?: {
  redisClient?: {
    multi: jest.Mock;
    pexpire: jest.Mock;
  } | null;
}) {
  jest.resetModules();

  const getRedis = jest.fn(() => options?.redisClient ?? null);

  jest.doMock("../../lib/config", () => ({
    config: {
      NODE_ENV: "test",
    },
  }));

  jest.doMock("../../lib/redis", () => ({
    getRedis,
  }));

  const rateLimitModule = require("../../middleware/rateLimit") as typeof import("../../middleware/rateLimit");

  return {
    ...rateLimitModule,
    getRedis,
  };
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

describe("rateLimit middleware", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("returns 429 after exceeding the in-memory request limit", async () => {
    const { rateLimit, clearRateLimitStore } = loadRateLimitModule();
    clearRateLimitStore();
    const app = createIpLimitedApp(rateLimit(2, 60 * 1000));

    const first = await request(app).get("/limited").set("X-Forwarded-For", "1.1.1.1");
    const second = await request(app).get("/limited").set("X-Forwarded-For", "1.1.1.1");
    const third = await request(app).get("/limited").set("X-Forwarded-For", "1.1.1.1");

    expect(first.status).toBe(200);
    expect(first.headers["x-ratelimit-limit"]).toBe("2");
    expect(first.headers["x-ratelimit-remaining"]).toBe("1");
    expect(second.status).toBe(200);
    expect(second.headers["x-ratelimit-remaining"]).toBe("0");
    expect(third.status).toBe(429);
    expect(third.body.error).toBe("Too many requests. Please try again later.");
    expect(third.body.requestId).toBe(third.headers["x-request-id"]);
    expect(third.headers["retry-after"]).toEqual(expect.any(String));
  });

  it("resets the in-memory window after expiry", async () => {
    const { rateLimit, clearRateLimitStore } = loadRateLimitModule();
    clearRateLimitStore();
    const nowSpy = jest.spyOn(Date, "now");
    let currentTime = 1_000;
    nowSpy.mockImplementation(() => currentTime);

    const app = createIpLimitedApp(rateLimit(1, 1_000));

    const first = await request(app).get("/limited").set("X-Forwarded-For", "2.2.2.2");
    const second = await request(app).get("/limited").set("X-Forwarded-For", "2.2.2.2");
    currentTime += 1_001;
    const third = await request(app).get("/limited").set("X-Forwarded-For", "2.2.2.2");

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(third.status).toBe(200);

    nowSpy.mockRestore();
  });

  it("uses Redis ttl to rate limit when Redis is available", async () => {
    const redisClient = createRedisClient([[null, 3], [null, 1_500]]);
    const { rateLimit } = loadRateLimitModule({ redisClient });
    const app = createIpLimitedApp(rateLimit(2, 60 * 1000));

    const res = await request(app).get("/limited").set("X-Forwarded-For", "3.3.3.3");

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("2");
    expect(redisClient.multi).toHaveBeenCalledTimes(1);
    expect(redisClient.pexpire).not.toHaveBeenCalled();
  });

  it("keys authenticated requests by userId instead of shared IP", async () => {
    const { rateLimitByUser, clearRateLimitStore } = loadRateLimitModule();
    clearRateLimitStore();
    const app = createUserLimitedApp(rateLimitByUser(1, 60 * 1000));

    const firstUser = await request(app)
      .get("/limited")
      .set("X-Forwarded-For", "4.4.4.4")
      .set("Authorization", "Bearer token-a");
    const secondUser = await request(app)
      .get("/limited")
      .set("X-Forwarded-For", "4.4.4.4")
      .set("Authorization", "Bearer token-b");
    const firstUserAgain = await request(app)
      .get("/limited")
      .set("X-Forwarded-For", "4.4.4.4")
      .set("Authorization", "Bearer token-a");

    expect(firstUser.status).toBe(200);
    expect(secondUser.status).toBe(200);
    expect(firstUserAgain.status).toBe(429);
  });

  it("falls back to IP bucketing when userId is not available", async () => {
    const { rateLimitByUser, clearRateLimitStore } = loadRateLimitModule();
    clearRateLimitStore();
    const app = createUserLimitedApp(rateLimitByUser(1, 60 * 1000));

    const first = await request(app).get("/limited").set("X-Forwarded-For", "5.5.5.5");
    const second = await request(app).get("/limited").set("X-Forwarded-For", "5.5.5.5");

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });
});
