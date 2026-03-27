/**
 * Generate lib test suite
 * Tests generateTweet function and confidence/engagement heuristics
 * Mocks: OpenAI client
 */

jest.mock("../../lib/openai", () => ({
  getOpenAIClient: jest.fn(),
}));

jest.mock("../../lib/prompt", () => ({
  buildTweetPrompt: jest.fn().mockReturnValue({
    system: "You are Atlas",
    userMessage: "Write a tweet about BTC",
  }),
}));

import { generateTweet } from "../../lib/generate";
import { getOpenAIClient } from "../../lib/openai";

const mockGetClient = getOpenAIClient as jest.Mock;

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

const baseParams = {
  voiceProfile: {
    humor: 50,
    formality: 50,
    brevity: 50,
    contrarianTone: 50,
    maturity: "INTERMEDIATE",
  },
  sourceContent: "Bitcoin is at an all-time high",
  sourceType: "REPORT",
};

describe("generateTweet", () => {
  it("calls OpenAI and returns tweet content", async () => {
    const client = makeOpenAIClient("BTC just hit $100k. We called it.");
    mockGetClient.mockReturnValue(client);

    const result = await generateTweet(baseParams);
    expect(result.content).toBe("BTC just hit $100k. We called it.");
    expect(client.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o" })
    );
  });

  it("returns empty string when OpenAI returns no content", async () => {
    const client = makeOpenAIClient("");
    mockGetClient.mockReturnValue(client);

    const result = await generateTweet(baseParams);
    expect(result.content).toBe("");
  });

  it("returns confidence between 0.1 and 0.99", async () => {
    const client = makeOpenAIClient("Short tweet");
    mockGetClient.mockReturnValue(client);

    const result = await generateTweet(baseParams);
    expect(result.confidence).toBeGreaterThanOrEqual(0.1);
    expect(result.confidence).toBeLessThanOrEqual(0.99);
  });

  it("returns a positive predictedEngagement number", async () => {
    const client = makeOpenAIClient("BTC tweet");
    mockGetClient.mockReturnValue(client);

    const result = await generateTweet(baseParams);
    expect(result.predictedEngagement).toBeGreaterThan(0);
  });

  it("boosts confidence for ADVANCED maturity", async () => {
    const client = makeOpenAIClient("A good 200-char tweet".padEnd(200, " x"));
    mockGetClient.mockReturnValue(client);

    const advanced = { ...baseParams, voiceProfile: { ...baseParams.voiceProfile, maturity: "ADVANCED" } };
    const intermediate = { ...baseParams, voiceProfile: { ...baseParams.voiceProfile, maturity: "INTERMEDIATE" } };

    // Reset mock for each call
    mockGetClient
      .mockReturnValueOnce(makeOpenAIClient("A 200-char tweet".padEnd(200, "x")))
      .mockReturnValueOnce(makeOpenAIClient("A 200-char tweet".padEnd(200, "x")));

    const advancedResult = await generateTweet(advanced);
    const intermediateResult = await generateTweet(intermediate);
    expect(advancedResult.confidence).toBeGreaterThan(intermediateResult.confidence);
  });

  it("penalizes confidence for content over 280 chars", async () => {
    const longContent = "x".repeat(300);
    const shortContent = "Short tweet";

    mockGetClient
      .mockReturnValueOnce(makeOpenAIClient(longContent))
      .mockReturnValueOnce(makeOpenAIClient(shortContent));

    const longResult = await generateTweet(baseParams);
    const shortResult = await generateTweet(baseParams);
    expect(longResult.confidence).toBeLessThan(shortResult.confidence);
  });

  it("boosts engagement for TRENDING_TOPIC source type", async () => {
    mockGetClient
      .mockReturnValueOnce(makeOpenAIClient("tweet"))
      .mockReturnValueOnce(makeOpenAIClient("tweet"));

    const trending = { ...baseParams, sourceType: "TRENDING_TOPIC" };
    const manual = { ...baseParams, sourceType: "MANUAL" };

    const trendingResult = await generateTweet(trending);
    const manualResult = await generateTweet(manual);
    expect(trendingResult.predictedEngagement).toBeGreaterThan(manualResult.predictedEngagement);
  });

  it("boosts confidence when feedback is provided", async () => {
    const client = makeOpenAIClient("Refined tweet");
    mockGetClient
      .mockReturnValueOnce(makeOpenAIClient("tweet"))
      .mockReturnValueOnce(makeOpenAIClient("tweet"));

    const withFeedback = { ...baseParams, feedback: "Make it more concise" };
    const withoutFeedback = { ...baseParams };

    const withResult = await generateTweet(withFeedback);
    const withoutResult = await generateTweet(withoutFeedback);
    expect(withResult.confidence).toBeGreaterThan(withoutResult.confidence);
  });
});
