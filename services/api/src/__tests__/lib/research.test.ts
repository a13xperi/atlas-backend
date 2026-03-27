/**
 * Research lib test suite
 * Tests conductResearch function
 * Mocks: OpenAI client, Redis cache
 */

jest.mock("../../lib/openai", () => ({
  getOpenAIClient: jest.fn(),
}));

jest.mock("../../lib/redis", () => ({
  getCached: jest.fn(),
  setCache: jest.fn(),
}));

import { conductResearch } from "../../lib/research";
import { getOpenAIClient } from "../../lib/openai";
import { getCached, setCache } from "../../lib/redis";

const mockGetClient = getOpenAIClient as jest.Mock;
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

function makeOpenAIClient(content: string) {
  return {
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{ message: { content } }],
        }),
      },
    },
  };
}

describe("conductResearch", () => {
  beforeEach(() => {
    mockGetCached.mockResolvedValue(null);
    mockSetCache.mockResolvedValue(undefined);
  });

  it("returns cached result when available", async () => {
    mockGetCached.mockResolvedValueOnce(JSON.stringify(mockResearchResult));

    const result = await conductResearch({ query: "BTC analysis" });
    expect(result.summary).toBe("BTC is bullish");
    expect(mockGetClient).not.toHaveBeenCalled();
  });

  it("calls OpenAI when no cache hit", async () => {
    const client = makeOpenAIClient(JSON.stringify(mockResearchResult));
    mockGetClient.mockReturnValue(client);

    const result = await conductResearch({ query: "BTC analysis" });
    expect(result.summary).toBe("BTC is bullish");
    expect(client.chat.completions.create).toHaveBeenCalled();
  });

  it("caches result after fetching from OpenAI", async () => {
    const client = makeOpenAIClient(JSON.stringify(mockResearchResult));
    mockGetClient.mockReturnValue(client);

    await conductResearch({ query: "BTC analysis" });
    expect(mockSetCache).toHaveBeenCalledWith(
      expect.stringContaining("research:"),
      expect.any(String),
      900
    );
  });

  it("includes context in user message when provided", async () => {
    const client = makeOpenAIClient(JSON.stringify(mockResearchResult));
    mockGetClient.mockReturnValue(client);

    await conductResearch({ query: "BTC analysis", context: "REPORT" });

    const callArgs = client.chat.completions.create.mock.calls[0][0];
    const userMessage = callArgs.messages.find((m: any) => m.role === "user").content;
    expect(userMessage).toContain("[Source type: REPORT]");
  });

  it("normalizes confidence to 0-1 range", async () => {
    const result = { ...mockResearchResult, confidence: 5.0 };
    const client = makeOpenAIClient(JSON.stringify(result));
    mockGetClient.mockReturnValue(client);

    const r = await conductResearch({ query: "test" });
    expect(r.confidence).toBeLessThanOrEqual(1.0);
  });

  it("handles missing optional fields gracefully", async () => {
    const minimalResult = { summary: "test", sentiment: "neutral", confidence: 0.5 };
    const client = makeOpenAIClient(JSON.stringify(minimalResult));
    mockGetClient.mockReturnValue(client);

    const r = await conductResearch({ query: "test" });
    expect(Array.isArray(r.keyFacts)).toBe(true);
    expect(Array.isArray(r.relatedTopics)).toBe(true);
    expect(Array.isArray(r.sources)).toBe(true);
  });

  it("throws when OpenAI returns empty content", async () => {
    const client = makeOpenAIClient("");
    client.chat.completions.create.mockResolvedValueOnce({ choices: [{ message: { content: null } }] });
    mockGetClient.mockReturnValue(client);

    await expect(conductResearch({ query: "test" })).rejects.toThrow("Empty response from OpenAI");
  });
});
