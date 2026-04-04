const TEST_REDIS_URL = "redis://localhost:6379";
const originalEnv = { ...process.env };

type RedisModule = typeof import("../../lib/redis");

type LoadRedisModuleOptions = {
  redisUrl?: string | null;
  redisConstructor?: unknown;
};

async function loadRedisModule(
  options: LoadRedisModuleOptions = {}
): Promise<{ redisModule: RedisModule; loggerWarn: jest.Mock }> {
  jest.resetModules();

  process.env = {
    ...originalEnv,
    NODE_ENV: "test",
    JWT_SECRET: originalEnv.JWT_SECRET || "test-secret",
    DATABASE_URL: originalEnv.DATABASE_URL || "postgresql://localhost:5432/atlas",
  };

  if (options.redisUrl === null) {
    delete process.env.REDIS_URL;
  } else {
    process.env.REDIS_URL = options.redisUrl || TEST_REDIS_URL;
  }

  const loggerWarn = jest.fn();

  jest.doMock("../../lib/logger", () => ({
    logger: {
      warn: loggerWarn,
    },
  }));

  if (options.redisConstructor) {
    jest.doMock("ioredis", () => ({
      __esModule: true,
      default: options.redisConstructor,
    }));
  } else {
    jest.doMock("ioredis", () => {
      const RedisMock = jest.requireActual("ioredis-mock");
      return {
        __esModule: true,
        default: RedisMock,
      };
    });
  }

  const redisModule = require("../../lib/redis") as RedisModule;

  return { redisModule, loggerWarn };
}

describe("redis cache helpers", () => {
  jest.setTimeout(20000);

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("stores and retrieves cached values with a TTL", async () => {
    const { redisModule } = await loadRedisModule();
    const { getCached, getRedis, setCache } = redisModule;

    await setCache("draft:123", "cached draft", 1);

    const client = getRedis() as {
      ttl: (key: string) => Promise<number>;
    } | null;

    expect(client).not.toBeNull();
    await expect(getCached("draft:123")).resolves.toBe("cached draft");
    await expect(client!.ttl("draft:123")).resolves.toBeGreaterThan(-1);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    await expect(getCached("draft:123")).resolves.toBeNull();
  });

  it("returns null on a cache miss", async () => {
    const { redisModule } = await loadRedisModule();

    await expect(redisModule.getCached("missing:key")).resolves.toBeNull();
  });

  it("supports cache invalidation by deleting keys from the shared Redis client", async () => {
    const { redisModule } = await loadRedisModule();
    const { getCached, getRedis, setCache } = redisModule;

    await setCache("research:btc", "cached payload", 60);

    const client = getRedis() as {
      del: (key: string) => Promise<number>;
    } | null;

    expect(client).not.toBeNull();
    await expect(client!.del("research:btc")).resolves.toBe(1);
    await expect(getCached("research:btc")).resolves.toBeNull();
  });

  it("preserves JSON payloads for object serialization and deserialization", async () => {
    const { redisModule } = await loadRedisModule();
    const { getCached, setCache } = redisModule;

    const cachedObject = {
      userId: "user-123",
      traits: ["macro", "defi"],
      preferences: {
        tone: "sharp",
        includeTickers: true,
      },
    };

    await setCache("profile:user-123", JSON.stringify(cachedObject), 120);

    const cachedValue = await getCached("profile:user-123");

    expect(cachedValue).not.toBeNull();
    expect(JSON.parse(cachedValue!)).toEqual(cachedObject);
  });

  it("keeps prefixed namespaces isolated from each other", async () => {
    const { redisModule } = await loadRedisModule();
    const { getCached, getRedis, setCache } = redisModule;

    await setCache("research:eth", "research result", 300);
    await setCache("trending:eth", "trending result", 300);

    await expect(getCached("research:eth")).resolves.toBe("research result");
    await expect(getCached("trending:eth")).resolves.toBe("trending result");

    const client = getRedis() as {
      del: (key: string) => Promise<number>;
    } | null;

    await client!.del("research:eth");

    await expect(getCached("research:eth")).resolves.toBeNull();
    await expect(getCached("trending:eth")).resolves.toBe("trending result");
  });

  it("reuses a single Redis client instance for cache operations", async () => {
    const { redisModule } = await loadRedisModule();

    const firstClient = redisModule.getRedis();
    const secondClient = redisModule.getRedis();

    expect(firstClient).toBe(secondClient);
  });

  it("gracefully disables caching when REDIS_URL is not configured", async () => {
    const { redisModule } = await loadRedisModule({ redisUrl: null });
    const { getCached, getRedis, setCache } = redisModule;

    expect(getRedis()).toBeNull();
    await expect(getCached("any:key")).resolves.toBeNull();
    await expect(setCache("any:key", "value", 60)).resolves.toBeUndefined();
  });

  it("returns null and logs a warning when Redis construction fails", async () => {
    const throwingRedis = jest.fn().mockImplementation(() => {
      throw new Error("redis unavailable");
    });

    const { redisModule, loggerWarn } = await loadRedisModule({
      redisConstructor: throwingRedis,
    });

    expect(redisModule.getRedis()).toBeNull();
    expect(throwingRedis).toHaveBeenCalledWith(TEST_REDIS_URL);
    expect(loggerWarn).toHaveBeenCalledWith("Redis connection failed — caching disabled");
  });

  it("returns null when Redis.get rejects", async () => {
    const { redisModule } = await loadRedisModule();
    const client = redisModule.getRedis() as unknown as {
      get: jest.Mock;
    } | null;

    client!.get = jest.fn().mockRejectedValueOnce(new Error("connection lost"));

    await expect(redisModule.getCached("alerts:feed")).resolves.toBeNull();
  });

  it("swallows Redis.set failures so cache writes stay non-fatal", async () => {
    const { redisModule } = await loadRedisModule();
    const client = redisModule.getRedis() as unknown as {
      set: jest.Mock;
    } | null;

    client!.set = jest.fn().mockRejectedValueOnce(new Error("write failed"));

    await expect(redisModule.setCache("alerts:feed", "payload", 60)).resolves.toBeUndefined();
    await expect(redisModule.getCached("alerts:feed")).resolves.toBeNull();
  });
});
