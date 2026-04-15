/**
 * jwt-revocation test suite (C-6)
 *
 * Covers:
 *   - revokeJti writes the key with the requested TTL
 *   - revokeJti is a no-op for empty/expired entries
 *   - isJtiRevoked returns true when the key is present, false when absent
 *   - isJtiRevoked fails open when the live Redis call throws
 *   - remainingTtlSeconds clamps to 0 for already-expired exp claims
 *
 * Mocks: ../redis (so we never touch a real ioredis client) and ../logger.
 */

const setMock = jest.fn();
const getMock = jest.fn();

jest.mock("../../lib/redis", () => ({
  getRedis: jest.fn(() => ({
    set: setMock,
    get: getMock,
  })),
}));

jest.mock("../../lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  revokeJti,
  isJtiRevoked,
  remainingTtlSeconds,
} from "../../lib/jwt-revocation";

beforeEach(() => {
  setMock.mockReset();
  getMock.mockReset();
  setMock.mockResolvedValue("OK");
  getMock.mockResolvedValue(null);
});

describe("revokeJti", () => {
  it("writes the jti with the requested TTL", async () => {
    const ok = await revokeJti("abc123", 3600);
    expect(ok).toBe(true);
    expect(setMock).toHaveBeenCalledWith("jwt:revoked:abc123", "1", "EX", 3600);
  });

  it("is a no-op for an empty jti", async () => {
    const ok = await revokeJti("", 3600);
    expect(ok).toBe(false);
    expect(setMock).not.toHaveBeenCalled();
  });

  it("treats a non-positive TTL as already expired", async () => {
    const ok = await revokeJti("abc123", 0);
    expect(ok).toBe(true);
    expect(setMock).not.toHaveBeenCalled();
  });

  it("returns false when the Redis write throws", async () => {
    setMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const ok = await revokeJti("abc123", 3600);
    expect(ok).toBe(false);
  });
});

describe("isJtiRevoked", () => {
  it("returns false when no jti is supplied", async () => {
    expect(await isJtiRevoked(undefined)).toBe(false);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("returns false when the key is absent from Redis", async () => {
    getMock.mockResolvedValueOnce(null);
    expect(await isJtiRevoked("abc123")).toBe(false);
    expect(getMock).toHaveBeenCalledWith("jwt:revoked:abc123");
  });

  it("returns true when the key is present in Redis", async () => {
    getMock.mockResolvedValueOnce("1");
    expect(await isJtiRevoked("abc123")).toBe(true);
  });

  it("fails OPEN when the Redis lookup throws", async () => {
    getMock.mockRejectedValueOnce(new Error("connection lost"));
    expect(await isJtiRevoked("abc123")).toBe(false);
  });
});

describe("remainingTtlSeconds", () => {
  it("returns the difference between exp and now", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const ttl = remainingTtlSeconds(future);
    // Allow ±2s for clock drift between the call sites.
    expect(ttl).toBeGreaterThan(3597);
    expect(ttl).toBeLessThanOrEqual(3600);
  });

  it("clamps already-expired exp values to 0", () => {
    const past = Math.floor(Date.now() / 1000) - 100;
    expect(remainingTtlSeconds(past)).toBe(0);
  });

  it("returns 0 for an undefined exp", () => {
    expect(remainingTtlSeconds(undefined)).toBe(0);
  });
});
