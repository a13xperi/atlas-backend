/**
 * Content Extraction test suite
 * Tests extractInsights function — insight parsing, validation, and error handling
 * Mocks: provider router (complete)
 */

jest.mock("../../lib/providers", () => ({
  complete: jest.fn(),
}));

import { extractInsights } from "../../lib/content-extraction";
import { complete } from "../../lib/providers";

const mockComplete = complete as jest.Mock;

function mockAIResponse(content: string) {
  mockComplete.mockResolvedValueOnce({ content, provider: "anthropic", model: "claude", latencyMs: 100 });
}

const sampleInsights = [
  {
    title: "BTC dominance rising fast",
    summary: "Bitcoin dominance hit 58%, highest since 2021, squeezing altcoin liquidity.",
    keyQuote: "BTC dominance reached 58.2% this week, the highest level since April 2021.",
    angle: "data highlight",
  },
  {
    title: "ETH underperformance is structural",
    summary: "Ethereum's fee revenue dropped 40% QoQ while L2s captured the growth.",
    keyQuote: "Ethereum L1 fees declined to $1.2B in Q1, a 40% drop from Q4.",
    angle: "contrarian take",
  },
  {
    title: "DeFi yields compressing to TradFi levels",
    summary: "Average DeFi yield now sits at 3.2%, barely above US Treasury rates.",
    keyQuote: "The average DeFi lending rate compressed to 3.2%, converging with the 10Y Treasury.",
    angle: "prediction",
  },
  {
    title: "Stablecoin supply as a leading indicator",
    summary: "Total stablecoin market cap crossed $200B, historically preceding major rallies.",
    keyQuote: "Stablecoin supply hit $203B, a new all-time high and a reliable precursor to bull runs.",
    angle: "practical advice",
  },
];

describe("extractInsights", () => {
  beforeEach(() => {
    mockComplete.mockReset();
  });

  it("extracts insights from content and returns structured array", async () => {
    mockAIResponse(JSON.stringify(sampleInsights));

    const result = await extractInsights("This is a long research report about crypto markets. ".repeat(10));
    expect(result).toHaveLength(4);
    expect(result[0].title).toBe("BTC dominance rising fast");
    expect(result[0].angle).toBe("data highlight");
  });

  it("calls the provider with research task type", async () => {
    mockAIResponse(JSON.stringify(sampleInsights.slice(0, 3)));

    await extractInsights("A long research article about DeFi and crypto lending markets. ".repeat(5));
    expect(mockComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: "research",
        temperature: 0.4,
      }),
    );
  });

  it("returns between 1 and 7 insights", async () => {
    // Return 10 insights — should be clamped to 7
    const manyInsights = Array.from({ length: 10 }, (_, i) => ({
      title: `Insight ${i}`,
      summary: `Summary ${i}`,
      keyQuote: `Quote ${i}`,
      angle: "data highlight",
    }));
    mockAIResponse(JSON.stringify(manyInsights));

    const result = await extractInsights("Very long content with many angles. ".repeat(20));
    expect(result.length).toBeLessThanOrEqual(7);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("handles markdown-fenced JSON response", async () => {
    const fenced = "```json\n" + JSON.stringify(sampleInsights.slice(0, 3)) + "\n```";
    mockAIResponse(fenced);

    const result = await extractInsights("Content about crypto markets for analysis. ".repeat(5));
    expect(result).toHaveLength(3);
  });

  it("defaults unknown angles to 'explainer'", async () => {
    const withBadAngle = [
      { ...sampleInsights[0], angle: "unknown_angle_type" },
    ];
    mockAIResponse(JSON.stringify(withBadAngle));

    const result = await extractInsights("Long-form content for extraction. ".repeat(5));
    expect(result[0].angle).toBe("explainer");
  });

  it("throws on content that is too short", async () => {
    await expect(extractInsights("Too short")).rejects.toThrow(
      "Content too short for insight extraction",
    );
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("throws when AI returns invalid JSON", async () => {
    mockAIResponse("This is not JSON at all");

    await expect(
      extractInsights("A long article about blockchain technology and its applications. ".repeat(5)),
    ).rejects.toThrow("Failed to parse insight extraction response as JSON");
  });

  it("throws when AI returns non-array JSON", async () => {
    mockAIResponse(JSON.stringify({ not: "an array" }));

    await expect(
      extractInsights("A lengthy discussion about cryptocurrency regulations. ".repeat(5)),
    ).rejects.toThrow("Insight extraction response is not an array");
  });

  it("throws when no valid insights are in the response", async () => {
    mockAIResponse(JSON.stringify([{ bad: "structure" }, { also: "bad" }]));

    await expect(
      extractInsights("An extensive report on tokenomics and governance. ".repeat(5)),
    ).rejects.toThrow("No valid insights extracted from content");
  });

  it("filters out malformed insight objects", async () => {
    const mixed = [
      sampleInsights[0],
      { title: "Missing fields" }, // missing summary, keyQuote, angle
      sampleInsights[1],
    ];
    mockAIResponse(JSON.stringify(mixed));

    const result = await extractInsights("Content about DeFi protocols and yield farming. ".repeat(5));
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("BTC dominance rising fast");
    expect(result[1].title).toBe("ETH underperformance is structural");
  });
});
