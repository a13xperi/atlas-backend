import { parsePagination } from "../../lib/pagination";

describe("parsePagination", () => {
  it("returns default pagination when query params are missing", () => {
    expect(parsePagination({})).toEqual({ take: 20, skip: 0 });
  });

  it("uses custom query values when provided", () => {
    expect(parsePagination({ limit: "15", offset: "4" })).toEqual({ take: 15, skip: 4 });
  });

  it("clamps limit and offset into the allowed range", () => {
    expect(parsePagination({ limit: "999", offset: "-8" })).toEqual({ take: 100, skip: 0 });
    expect(parsePagination({ limit: "0", offset: "2" })).toEqual({ take: 1, skip: 2 });
  });

  it("falls back to defaults for invalid input", () => {
    expect(parsePagination({ limit: "abc", offset: "" }, { limit: 12, offset: 3 })).toEqual({
      take: 12,
      skip: 3,
    });
  });
});
