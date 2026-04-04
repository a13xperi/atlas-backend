import { error, success } from "../../lib/response";

describe("response helpers", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-04-03T09:15:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("builds a success envelope without meta", () => {
    expect(success({ user: "atlas" })).toEqual({
      ok: true,
      data: { user: "atlas" },
      timestamp: "2026-04-03T09:15:00.000Z",
    });
  });

  it("builds a success envelope with meta", () => {
    expect(success({ drafts: [] }, { total: 0 })).toEqual({
      ok: true,
      data: { drafts: [] },
      meta: { total: 0 },
      timestamp: "2026-04-03T09:15:00.000Z",
    });
  });

  it("builds an error envelope without details", () => {
    expect(error("Draft not found")).toEqual({
      ok: false,
      error: "Draft not found",
      timestamp: "2026-04-03T09:15:00.000Z",
    });
  });

  it("builds an error envelope with details", () => {
    expect(error("Invalid request", 400, [{ field: "content" }])).toEqual({
      ok: false,
      error: "Invalid request",
      details: [{ field: "content" }],
      timestamp: "2026-04-03T09:15:00.000Z",
    });
  });
});
