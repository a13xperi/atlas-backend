import { withTimeout, TimeoutError } from "../../lib/timeout";

describe("TimeoutError", () => {
  it("has status 504 and GATEWAY_TIMEOUT code", () => {
    const err = new TimeoutError("test-op", 5000);
    expect(err.statusCode).toBe(504);
    expect(err.code).toBe("GATEWAY_TIMEOUT");
    expect(err.message).toBe("test-op timed out after 5000ms");
    expect(err.name).toBe("TimeoutError");
  });
});

describe("withTimeout", () => {
  it("resolves when promise completes within limit", async () => {
    const result = await withTimeout(
      Promise.resolve("ok"),
      1000,
      "fast",
    );
    expect(result).toBe("ok");
  });

  it("throws TimeoutError when promise exceeds limit", async () => {
    const makeSlow = () => new Promise((resolve) => setTimeout(resolve, 200));
    await expect(withTimeout(makeSlow(), 50, "slow-op")).rejects.toThrow(TimeoutError);
    await expect(withTimeout(makeSlow(), 50, "slow-op")).rejects.toThrow(/slow-op timed out/);
  });

  it("propagates the original error if promise rejects before timeout", async () => {
    const failing = Promise.reject(new Error("boom"));
    await expect(withTimeout(failing, 1000, "fail")).rejects.toThrow("boom");
  });

  it("cleans up timer on success (no dangling handles)", async () => {
    const spy = jest.spyOn(global, "clearTimeout");
    await withTimeout(Promise.resolve(42), 5000, "cleanup");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
