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

import { logger } from "../../lib/logger";
import { isJtiRevoked, revokeJti } from "../../lib/jwt-revocation";

const mockLogger = logger as jest.Mocked<typeof logger>;

beforeEach(() => {
  jest.clearAllMocks();
  setMock.mockReset();
  getMock.mockReset();
});

describe("jwt revocation fail-open behavior", () => {
  it("isJtiRevoked returns false when redis.get throws", async () => {
    getMock.mockRejectedValueOnce(new Error("connection lost"));

    await expect(isJtiRevoked("abc123")).resolves.toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: "connection lost", jti: "abc123" }),
      "jti lookup failed — treating as not-revoked (fail-open)",
    );
  });

  it("revokeJti returns false on redis error but does not throw", async () => {
    setMock.mockRejectedValueOnce(new Error("write failed"));

    await expect(revokeJti("abc123", 3600)).resolves.toBe(false);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: "write failed", jti: "abc123" }),
      "Failed to revoke jti",
    );
  });
});
