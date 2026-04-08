/**
 * Batch Generate test suite
 * Tests batchGenerateDrafts function — draft creation, campaign grouping, error handling
 * Mocks: Prisma, pipeline, logger
 */

jest.mock("../../lib/prisma", () => ({
  prisma: {
    campaign: {
      create: jest.fn(),
    },
    tweetDraft: {
      create: jest.fn(),
    },
    analyticsEvent: {
      create: jest.fn(),
    },
  },
}));

jest.mock("../../lib/pipeline", () => ({
  runGenerationPipeline: jest.fn(),
}));

jest.mock("../../lib/logger", () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

import { batchGenerateDrafts } from "../../lib/batch-generate";
import { runGenerationPipeline } from "../../lib/pipeline";
import type { Insight } from "../../lib/content-extraction";

const { prisma } = require("../../lib/prisma");
const mockPipeline = runGenerationPipeline as jest.Mock;

const testInsights: Insight[] = [
  {
    title: "BTC dominance rising",
    summary: "Bitcoin dominance hit 58%.",
    keyQuote: "BTC dominance reached 58.2%.",
    angle: "data highlight",
  },
  {
    title: "ETH underperforming",
    summary: "Ethereum fees dropped 40%.",
    keyQuote: "Ethereum L1 fees declined to $1.2B.",
    angle: "contrarian take",
  },
  {
    title: "DeFi yields compressing",
    summary: "DeFi yield at 3.2%.",
    keyQuote: "Average DeFi rate compressed to 3.2%.",
    angle: "prediction",
  },
];

function mockPipelineSuccess(content: string, index: number) {
  return {
    ctx: {
      generatedContent: content,
      confidence: 0.8,
      predictedEngagement: 2000,
      finalVoiceDimensions: { humor: 50, formality: 50, brevity: 50, contrarianTone: 50 },
      stepResults: [],
    },
    steps: [],
    totalMs: 1000,
  };
}

describe("batchGenerateDrafts", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.campaign.create.mockResolvedValue({
      id: "campaign-1",
      name: "Test Campaign",
    });
    prisma.analyticsEvent.create.mockResolvedValue({});
  });

  it("generates a draft for each insight", async () => {
    const drafts = testInsights.map((_, i) => ({
      id: `draft-${i}`,
      content: `Tweet about ${testInsights[i].title}`,
    }));

    testInsights.forEach((insight, i) => {
      mockPipeline.mockResolvedValueOnce(
        mockPipelineSuccess(`Tweet about ${insight.title}`, i),
      );
      prisma.tweetDraft.create.mockResolvedValueOnce(drafts[i]);
    });

    const result = await batchGenerateDrafts({
      userId: "user-1",
      insights: testInsights,
      sourceContent: "Long report content",
      sourceType: "REPORT",
    });

    expect(result.drafts).toHaveLength(3);
    expect(result.drafts[0].content).toBe("Tweet about BTC dominance rising");
    expect(result.drafts[0].angle).toBe("data highlight");
    expect(result.campaign).toBeUndefined();
    expect(mockPipeline).toHaveBeenCalledTimes(3);
  });

  it("creates a campaign when createCampaign is true", async () => {
    testInsights.forEach((insight, i) => {
      mockPipeline.mockResolvedValueOnce(
        mockPipelineSuccess(`Tweet ${i}`, i),
      );
      prisma.tweetDraft.create.mockResolvedValueOnce({
        id: `draft-${i}`,
        content: `Tweet ${i}`,
      });
    });

    const result = await batchGenerateDrafts({
      userId: "user-1",
      insights: testInsights,
      sourceContent: "Long report content",
      sourceType: "REPORT",
      createCampaign: true,
      campaignTitle: "Crypto Market Q1 Report",
    });

    expect(prisma.campaign.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        name: "Crypto Market Q1 Report",
      }),
    });
    expect(result.campaign).toEqual({ id: "campaign-1", title: "Test Campaign" });
  });

  it("links drafts to campaign when campaign is created", async () => {
    mockPipeline.mockResolvedValueOnce(mockPipelineSuccess("Tweet 1", 0));
    prisma.tweetDraft.create.mockResolvedValueOnce({ id: "draft-1", content: "Tweet 1" });

    await batchGenerateDrafts({
      userId: "user-1",
      insights: [testInsights[0]],
      sourceContent: "Report content",
      sourceType: "REPORT",
      createCampaign: true,
    });

    expect(prisma.tweetDraft.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        campaignId: "campaign-1",
        sortOrder: 1,
      }),
    });
  });

  it("logs analytics events for each draft", async () => {
    testInsights.forEach((_, i) => {
      mockPipeline.mockResolvedValueOnce(mockPipelineSuccess(`Tweet ${i}`, i));
      prisma.tweetDraft.create.mockResolvedValueOnce({ id: `draft-${i}`, content: `Tweet ${i}` });
    });

    await batchGenerateDrafts({
      userId: "user-1",
      insights: testInsights,
      sourceContent: "Content",
      sourceType: "ARTICLE",
    });

    expect(prisma.analyticsEvent.create).toHaveBeenCalledTimes(3);
    expect(prisma.analyticsEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        type: "DRAFT_CREATED",
        metadata: expect.objectContaining({ batchGeneration: true }),
      }),
    });
  });

  it("continues generating when one insight fails", async () => {
    // First insight fails, second and third succeed
    mockPipeline.mockRejectedValueOnce(new Error("AI provider error"));
    mockPipeline.mockResolvedValueOnce(mockPipelineSuccess("Tweet 2", 1));
    mockPipeline.mockResolvedValueOnce(mockPipelineSuccess("Tweet 3", 2));

    prisma.tweetDraft.create.mockResolvedValueOnce({ id: "draft-2", content: "Tweet 2" });
    prisma.tweetDraft.create.mockResolvedValueOnce({ id: "draft-3", content: "Tweet 3" });

    const result = await batchGenerateDrafts({
      userId: "user-1",
      insights: testInsights,
      sourceContent: "Content",
      sourceType: "REPORT",
    });

    expect(result.drafts).toHaveLength(2);
    expect(mockPipeline).toHaveBeenCalledTimes(3);
  });

  it("throws when all insights fail to generate", async () => {
    testInsights.forEach(() => {
      mockPipeline.mockRejectedValueOnce(new Error("AI error"));
    });

    await expect(
      batchGenerateDrafts({
        userId: "user-1",
        insights: testInsights,
        sourceContent: "Content",
        sourceType: "REPORT",
      }),
    ).rejects.toThrow("Failed to generate any drafts from the provided insights");
  });

  it("skips insights where pipeline returns no content", async () => {
    mockPipeline.mockResolvedValueOnce({
      ctx: { generatedContent: null, confidence: 0.5, predictedEngagement: 500, stepResults: [] },
      steps: [],
      totalMs: 500,
    });
    mockPipeline.mockResolvedValueOnce(mockPipelineSuccess("Real tweet", 1));

    prisma.tweetDraft.create.mockResolvedValueOnce({ id: "draft-1", content: "Real tweet" });

    const result = await batchGenerateDrafts({
      userId: "user-1",
      insights: testInsights.slice(0, 2),
      sourceContent: "Content",
      sourceType: "ARTICLE",
    });

    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0].content).toBe("Real tweet");
  });

  it("computes quality score from confidence and engagement", async () => {
    mockPipeline.mockResolvedValueOnce({
      ctx: {
        generatedContent: "High quality tweet",
        confidence: 0.9,
        predictedEngagement: 5000,
        finalVoiceDimensions: null,
        stepResults: [],
      },
      steps: [],
      totalMs: 800,
    });
    prisma.tweetDraft.create.mockResolvedValueOnce({ id: "draft-1", content: "High quality tweet" });

    const result = await batchGenerateDrafts({
      userId: "user-1",
      insights: [testInsights[0]],
      sourceContent: "Content",
      sourceType: "REPORT",
    });

    // confidence 0.9 * 50 = 45, engagement min(5000/200, 50) = 25 → total 70
    expect(result.drafts[0].qualityScore).toBe(70);
  });

  it("passes angleInstruction to pipeline for each insight", async () => {
    mockPipeline.mockResolvedValueOnce(mockPipelineSuccess("Tweet", 0));
    prisma.tweetDraft.create.mockResolvedValueOnce({ id: "draft-1", content: "Tweet" });

    await batchGenerateDrafts({
      userId: "user-1",
      insights: [testInsights[0]],
      sourceContent: "Content",
      sourceType: "REPORT",
    });

    expect(mockPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        sourceType: "REPORT",
        angleInstruction: expect.stringContaining("data highlight"),
      }),
    );
  });
});
