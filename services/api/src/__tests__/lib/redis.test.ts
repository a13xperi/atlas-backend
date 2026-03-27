/**
 * Redis lib test suite
 * Tests getCached and setCache using mocked ioredis.
 * NOTE: The redis singleton is module-scoped; we test via getCached/setCache
 * with ioredis mocked at the jest.mock level.
 */

// Hold references to mock methods so tests can control them
const mockGet = jest.fn();
const mockSet = jest.fn();

jest.mock("ioredis", () => {
  return jest.fn().mockImplementation(() => ({ get: mockGet, set: mockSet }));
});

describe("getCached", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGet.mockReset();
    mockSet.mockReset();
  });

  it("returns null when REDIS_URL is not set", async () => {
    delete process.env.REDIS_URL;
    const { getCached } = await import("../../lib/redis");
    const result = await getCached("any-key");
    expect(result).toBeNull();
  });

  it("returns the cached string value from Redis", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    mockGet.mockResolvedValueOnce("stored_value");
    const { getCached } = await import("../../lib/redis");
    const result = await getCached("my-key");
    expect(result).toBe("stored_value");
    expect(mockGet).toHaveBeenCalledWith("my-key");
  });

  it("returns null when Redis.get throws", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    mockGet.mockRejectedValueOnce(new Error("connection lost"));
    const { getCached } = await import("../../lib/redis");
    const result = await getCached("bad-key");
    expect(result).toBeNull();
  });
});

describe("setCache", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGet.mockReset();
    mockSet.mockReset();
  });

  it("does nothing when REDIS_URL is not set", async () => {
    delete process.env.REDIS_URL;
    const { setCache } = await import("../../lib/redis");
    await expect(setCache("key", "value", 60)).resolves.toBeUndefined();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("calls Redis.set with EX when REDIS_URL is set", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    mockSet.mockResolvedValueOnce("OK");
    const { setCache } = await import("../../lib/redis");
    await setCache("my-key", "my-value", 300);
    expect(mockSet).toHaveBeenCalledWith("my-key", "my-value", "EX", 300);
  });

  it("silently swallows errors from Redis.set", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    mockSet.mockRejectedValueOnce(new Error("write failed"));
    const { setCache } = await import("../../lib/redis");
    await expect(setCache("key", "value", 60)).resolves.toBeUndefined();
  });
});
