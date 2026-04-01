/**
 * Research lib test suite
 * Tests conductResearch function
 * Mocks: provider router (complete), Redis cache
 */

jest.mock("../../lib/providers", () => ({
  complete: jest.fn(),
}));

jest.mock("../../lib/redis", () => ({
  getCached: jest.fn(),
  setCache: jest.fn(),
}));

import { conductResearch } from "../../lib/research";
import { complete } from "../../lib/providers";
import { getCached, setCache } from "../../lib/redis";

const mockComplete = complete as jest.Mock;
const mockGetCached = getCached as jest.Mock;
const mockSetCache = setCache as jest.Mock;

const mockResearchResult = {
  summary: "BTC is bullish",
  keyFacts: ["Price up 10%", "Volume increasing"],
  sentiment: "bullish",
  relatedTopics: ["ETH", "DeFi"],
  sources: ["CoinDesk"],
  confidence: 0.9,
};

describe("conductResearch", () => {
  beforeEach(() => {
    mockComplete.mockReset();
    mockGetCached.mockResolvedValue(null);
    mockSetCache.mockResolvedValue(undefined);
  });

  it("returns cached result when available", async () => {
    mockGetCached.mockResolvedValueOnce(JSON.stringify(mockResearchResult));

    const result = await conductResearch({ query: "BTC analysis" });
    expect(result.summary).toBe("BTC is bullish");
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("calls provider when no cache hit", async () => {
    mockComplete.mockResolvedValueOnce({
      content: JSON.stringify(mockResearchResult),
      providerId: "anthropic",
    });

    const result = await conductResearch({ query: "BTC analysis" });
    expect(result.summary).toBe("BTC is bullish");
    expect(mockComplete).toHaveBeenCalledWith(
      expect.objectContaining({ taskType: "research" })
    );
  });

  it("caches result after fetching from provider", async () => {
    mockComplete.mockResolvedValueOnce({
      content: JSON.stringify(mockResearchResult),
      providerId: "anthropic",
    });

    await conductResearch({ query: "BTC analysis" });
    expect(mockSetCache).toHaveBeenCalledWith(
      expect.stringContaining("research:"),
      expect.any(String),
      900
    );
  });

  it("includes context in user message when provided", async () => {
    mockComplete.mockResolvedValueOnce({
      content: JSON.stringify(mockResearchResult),
      providerId: "anthropic",
    });

    await conductResearch({ query: "BTC analysis", context: "REPORT" });

    const callArgs = mockComplete.mock.calls[0][0];
    const userMessage = callArgs.messages.find((m: any) => m.role === "user").content;
    expect(userMessage).toContain("[Source type: REPORT]");
  });

  it("normalizes confidence to 0-1 range", async () => {
    const result = { ...mockResearchResult, confidence: 5.0 };
    mockComplete.mockResolvedValueOnce({
      content: JSON.stringify(result),
      providerId: "anthropic",
    });

    const r = await conductResearch({ query: "test" });
    expect(r.confidence).toBeLessThanOrEqual(1.0);
  });

  it("handles missing optional fields gracefully", async () => {
    const minimalResult = { summary: "test", sentiment: "neutral", confidence: 0.5 };
    mockComplete.mockResolvedValueOnce({
      content: JSON.stringify(minimalResult),
      providerId: "anthropic",
    });

    const r = await conductResearch({ query: "test" });
    expect(Array.isArray(r.keyFacts)).toBe(true);
    expect(Array.isArray(r.relatedTopics)).toBe(true);
    expect(Array.isArray(r.sources)).toBe(true);
  });

  it("throws when provider returns empty content", async () => {
    mockComplete.mockResolvedValueOnce({
      content: null,
      providerId: "anthropic",
    });

    await expect(conductResearch({ query: "test" })).rejects.toThrow("Empty response from provider");
  });
});
