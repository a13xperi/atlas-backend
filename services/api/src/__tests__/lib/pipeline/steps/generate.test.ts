/**
 * Generate step test suite
 * Mocks: generateTweet from lib/generate
 */

jest.mock("../../../../lib/generate", () => ({
  generateTweet: jest.fn(),
}));

import { generateStep } from "../../../../lib/pipeline/steps/generate";
import { generateTweet } from "../../../../lib/generate";
import type { PipelineContext } from "../../../../lib/pipeline/types";

const mockGenerateTweet = generateTweet as jest.Mock;

function makeContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    userId: "user-123",
    sourceContent: "BTC analysis",
    sourceType: "REPORT",
    voiceProfile: { humor: 50, formality: 50, brevity: 50, contrarianTone: 30, maturity: "INTERMEDIATE" },
    stepResults: [],
    ...overrides,
  };
}

describe("generateStep", () => {
  beforeEach(() => {
    mockGenerateTweet.mockReset();
  });

  it("calls generateTweet with context data", async () => {
    mockGenerateTweet.mockResolvedValueOnce({
      content: "BTC to the moon!",
      confidence: 0.85,
      predictedEngagement: 2000,
    });

    const ctx = makeContext({ researchContext: "BTC is bullish" });
    await generateStep.execute(ctx);

    expect(mockGenerateTweet).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceProfile: expect.objectContaining({ humor: 50 }),
        sourceContent: "BTC analysis",
        sourceType: "REPORT",
        researchContext: "BTC is bullish",
      })
    );
  });

  it("sets generatedContent, confidence, predictedEngagement on context", async () => {
    mockGenerateTweet.mockResolvedValueOnce({
      content: "Tweet content",
      confidence: 0.9,
      predictedEngagement: 1800,
    });

    const ctx = makeContext();
    await generateStep.execute(ctx);

    expect(ctx.generatedContent).toBe("Tweet content");
    expect(ctx.confidence).toBe(0.9);
    expect(ctx.predictedEngagement).toBe(1800);
  });

  it("throws when voiceProfile is missing", async () => {
    const ctx = makeContext({ voiceProfile: undefined });
    await expect(generateStep.execute(ctx)).rejects.toThrow("Voice profile not available");
  });

  it("passes feedback when present", async () => {
    mockGenerateTweet.mockResolvedValueOnce({
      content: "Refined tweet",
      confidence: 0.88,
      predictedEngagement: 1500,
    });

    const ctx = makeContext({ feedback: "make it shorter" });
    await generateStep.execute(ctx);

    expect(mockGenerateTweet).toHaveBeenCalledWith(
      expect.objectContaining({ feedback: "make it shorter" })
    );
  });
});
