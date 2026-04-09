jest.mock("../../lib/providers", () => ({
  completeWith: jest.fn(),
}));

import { extractInsights } from "../../lib/content-extraction";
import { completeWith } from "../../lib/providers";

const mockCompleteWith = completeWith as jest.Mock;

function mockAIResponse(content: string) {
  mockCompleteWith.mockResolvedValueOnce({
    content,
    provider: "anthropic",
    model: "claude",
    latencyMs: 100,
  });
}

const sampleInsights = [
  {
    title: "BTC dominance rising fast",
    summary: "Bitcoin dominance hit 58%, squeezing altcoin liquidity.",
    keyQuote: "BTC dominance reached 58.2% this week.",
    angle: "data highlight",
  },
  {
    title: "ETH underperformance is structural",
    summary: "Ethereum fee revenue dropped while L2s captured the growth.",
    keyQuote: "Ethereum L1 fees declined 40% quarter over quarter.",
    angle: "contrarian take",
  },
  {
    title: "Stablecoins signal the next move",
    summary: "Stablecoin supply expansion is front-running risk appetite.",
    keyQuote: "Stablecoin market cap crossed $200B.",
    angle: "prediction",
  },
];

describe("extractInsights", () => {
  beforeEach(() => {
    mockCompleteWith.mockReset();
  });

  it("extracts structured insights from content", async () => {
    mockAIResponse(JSON.stringify(sampleInsights));

    const result = await extractInsights("This is a long research report about crypto markets. ".repeat(10));

    expect(result).toHaveLength(3);
    expect(result[0].title).toBe("BTC dominance rising fast");
    expect(result[0].angle).toBe("data highlight");
  });

  it("calls Anthropic directly through the provider layer", async () => {
    mockAIResponse(JSON.stringify(sampleInsights));

    await extractInsights("A long research article about DeFi and crypto lending markets. ".repeat(5), {
      limit: 2,
    });

    expect(mockCompleteWith).toHaveBeenCalledWith(
      "anthropic",
      expect.objectContaining({
        taskType: "research",
        temperature: 0.4,
      }),
    );
  });

  it("clamps the response to the requested limit", async () => {
    mockAIResponse(JSON.stringify(sampleInsights));

    const result = await extractInsights("A long article about market structure. ".repeat(10), {
      limit: 2,
    });

    expect(result).toHaveLength(2);
  });

  it("handles markdown-fenced JSON", async () => {
    mockAIResponse(`\`\`\`json\n${JSON.stringify(sampleInsights)}\n\`\`\``);

    const result = await extractInsights("Detailed article content for extraction. ".repeat(6));

    expect(result).toHaveLength(3);
  });

  it("defaults unknown angles to explainer", async () => {
    mockAIResponse(
      JSON.stringify([{ ...sampleInsights[0], angle: "unrecognized-angle" }]),
    );

    const result = await extractInsights("Content about token design and demand. ".repeat(5));

    expect(result[0].angle).toBe("explainer");
  });

  it("throws on short content", async () => {
    await expect(extractInsights("Too short")).rejects.toThrow(
      "Content too short for insight extraction",
    );
    expect(mockCompleteWith).not.toHaveBeenCalled();
  });

  it("throws on invalid JSON", async () => {
    mockAIResponse("not json");

    await expect(
      extractInsights("A long article about regulation and market structure. ".repeat(5)),
    ).rejects.toThrow("Failed to parse insight extraction response as JSON");
  });

  it("throws when the response is not an array", async () => {
    mockAIResponse(JSON.stringify({ insights: "nope" }));

    await expect(
      extractInsights("A lengthy discussion about onchain metrics. ".repeat(5)),
    ).rejects.toThrow("Insight extraction response is not an array");
  });

  it("filters malformed insights and throws when none remain", async () => {
    mockAIResponse(JSON.stringify([{ bad: "structure" }]));

    await expect(
      extractInsights("An extensive report on tokenomics and governance. ".repeat(5)),
    ).rejects.toThrow("No valid insights extracted from content");
  });
});
