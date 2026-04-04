jest.mock("../../lib/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

import { withRetry } from "../../lib/retry";

describe("withRetry", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns result on first success", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, "test");
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 and succeeds", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce({ status: 429, message: "rate limited" })
      .mockResolvedValue("ok");

    const result = await withRetry(fn, "test", {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on 500 and succeeds", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce({ status: 500, message: "internal error" })
      .mockResolvedValue("recovered");

    const result = await withRetry(fn, "test", {
      maxRetries: 2,
      baseDelayMs: 1,
      maxDelayMs: 10,
    });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on 503 status", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce({ status: 503, message: "unavailable" })
      .mockRejectedValueOnce({ status: 503, message: "still unavailable" })
      .mockResolvedValue("back");

    const result = await withRetry(fn, "test", {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
    });
    expect(result).toBe("back");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws immediately on non-retryable error", async () => {
    const err = { status: 400, message: "bad request" };
    const fn = jest.fn().mockRejectedValue(err);

    await expect(
      withRetry(fn, "test", { maxRetries: 3, baseDelayMs: 1 }),
    ).rejects.toEqual(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting retries", async () => {
    const err = { status: 429, message: "rate limited" };
    const fn = jest.fn().mockRejectedValue(err);

    await expect(
      withRetry(fn, "test", { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 }),
    ).rejects.toEqual(err);
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("retries on RateLimitError name", async () => {
    const err = Object.assign(new Error("rate limit"), { name: "RateLimitError" });
    const fn = jest
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue("ok");

    const result = await withRetry(fn, "test", {
      maxRetries: 1,
      baseDelayMs: 1,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on ECONNRESET", async () => {
    const err = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const fn = jest
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue("reconnected");

    const result = await withRetry(fn, "test", {
      maxRetries: 1,
      baseDelayMs: 1,
    });
    expect(result).toBe("reconnected");
  });

  it("retries on nested response.status", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce({ response: { status: 502 } })
      .mockResolvedValue("ok");

    const result = await withRetry(fn, "test", {
      maxRetries: 1,
      baseDelayMs: 1,
    });
    expect(result).toBe("ok");
  });

  it("does not retry on 401 unauthorized", async () => {
    const err = { status: 401, message: "unauthorized" };
    const fn = jest.fn().mockRejectedValue(err);

    await expect(
      withRetry(fn, "test", { maxRetries: 3, baseDelayMs: 1 }),
    ).rejects.toEqual(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects maxRetries: 0", async () => {
    const err = { status: 500, message: "error" };
    const fn = jest.fn().mockRejectedValue(err);

    await expect(
      withRetry(fn, "test", { maxRetries: 0, baseDelayMs: 1 }),
    ).rejects.toEqual(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
