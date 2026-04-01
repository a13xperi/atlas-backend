/**
 * Generate lib test suite
 * Tests generateTweet function and confidence/engagement heuristics
 * Mocks: provider router (complete), prompt builder
 */

jest.mock("../../lib/providers", () => ({
  complete: jest.fn(),
}));

jest.mock("../../lib/prompt", () => ({
  buildTweetPrompt: jest.fn().mockReturnValue({
    system: "You are Atlas",
    userMessage: "Write a tweet about BTC",
  }),
}));

import { generateTweet } from "../../lib/generate";
import { complete } from "../../lib/providers";

const mockComplete = complete as jest.Mock;

function mockContent(content: string) {
  mockComplete.mockResolvedValueOnce({ content, providerId: "openai" });
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
  beforeEach(() => {
    mockComplete.mockReset();
  });

  it("calls provider router and returns tweet content", async () => {
    mockContent("BTC just hit $100k. We called it.");

    const result = await generateTweet(baseParams);
    expect(result.content).toBe("BTC just hit $100k. We called it.");
    expect(mockComplete).toHaveBeenCalledWith(
      expect.objectContaining({ taskType: "tweet_generation" })
    );
  });

  it("returns empty string when provider returns no content", async () => {
    mockContent("");

    const result = await generateTweet(baseParams);
    expect(result.content).toBe("");
  });

  it("returns confidence between 0.1 and 0.99", async () => {
    mockContent("Short tweet");

    const result = await generateTweet(baseParams);
    expect(result.confidence).toBeGreaterThanOrEqual(0.1);
    expect(result.confidence).toBeLessThanOrEqual(0.99);
  });

  it("returns a positive predictedEngagement number", async () => {
    mockContent("BTC tweet");

    const result = await generateTweet(baseParams);
    expect(result.predictedEngagement).toBeGreaterThan(0);
  });

  it("boosts confidence for ADVANCED maturity", async () => {
    const padded = "A 200-char tweet".padEnd(200, "x");
    mockContent(padded);
    mockContent(padded);

    const advanced = { ...baseParams, voiceProfile: { ...baseParams.voiceProfile, maturity: "ADVANCED" } };
    const intermediate = { ...baseParams, voiceProfile: { ...baseParams.voiceProfile, maturity: "INTERMEDIATE" } };

    const advancedResult = await generateTweet(advanced);
    const intermediateResult = await generateTweet(intermediate);
    expect(advancedResult.confidence).toBeGreaterThan(intermediateResult.confidence);
  });

  it("penalizes confidence for content over 280 chars", async () => {
    mockContent("x".repeat(300));
    mockContent("Short tweet");

    const longResult = await generateTweet(baseParams);
    const shortResult = await generateTweet(baseParams);
    expect(longResult.confidence).toBeLessThan(shortResult.confidence);
  });

  it("boosts engagement for TRENDING_TOPIC source type", async () => {
    mockContent("tweet");
    mockContent("tweet");

    const trending = { ...baseParams, sourceType: "TRENDING_TOPIC" };
    const manual = { ...baseParams, sourceType: "MANUAL" };

    const trendingResult = await generateTweet(trending);
    const manualResult = await generateTweet(manual);
    expect(trendingResult.predictedEngagement).toBeGreaterThan(manualResult.predictedEngagement);
  });

  it("boosts confidence when feedback is provided", async () => {
    mockContent("tweet");
    mockContent("tweet");

    const withFeedback = { ...baseParams, feedback: "Make it more concise" };
    const withoutFeedback = { ...baseParams };

    const withResult = await generateTweet(withFeedback);
    const withoutResult = await generateTweet(withoutFeedback);
    expect(withResult.confidence).toBeGreaterThan(withoutResult.confidence);
  });
});
