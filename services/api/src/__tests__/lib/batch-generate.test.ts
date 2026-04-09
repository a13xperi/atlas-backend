jest.mock("../../lib/prisma", () => ({
  prisma: {
    campaign: {
      create: jest.fn(),
      delete: jest.fn(),
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
    title: "Stablecoins are expanding",
    summary: "Stablecoin supply is climbing into a fresh regime.",
    keyQuote: "Stablecoin supply hit a new all-time high.",
    angle: "prediction",
  },
];

function mockPipelineSuccess(content: string) {
  return {
    ctx: {
      generatedContent: content,
      confidence: 0.8,
      predictedEngagement: 2000,
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
    prisma.campaign.delete.mockResolvedValue({});
    prisma.analyticsEvent.create.mockResolvedValue({});
  });

  it("generates a draft for each insight", async () => {
    testInsights.forEach((insight: Insight, index: number) => {
      mockPipeline.mockResolvedValueOnce(mockPipelineSuccess(`Tweet about ${insight.title}`));
      prisma.tweetDraft.create.mockResolvedValueOnce({
        id: `draft-${index}`,
        content: `Tweet about ${insight.title}`,
      });
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

  it("creates a campaign when requested", async () => {
    testInsights.forEach((insight: Insight, index: number) => {
      mockPipeline.mockResolvedValueOnce(mockPipelineSuccess(`Tweet ${index}`));
      prisma.tweetDraft.create.mockResolvedValueOnce({
        id: `draft-${index}`,
        content: `Tweet ${index}`,
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

  it("links drafts to the campaign in order", async () => {
    mockPipeline.mockResolvedValueOnce(mockPipelineSuccess("Tweet 1"));
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

  it("logs analytics for each generated draft", async () => {
    testInsights.forEach((_insight: Insight, index: number) => {
      mockPipeline.mockResolvedValueOnce(mockPipelineSuccess(`Tweet ${index}`));
      prisma.tweetDraft.create.mockResolvedValueOnce({
        id: `draft-${index}`,
        content: `Tweet ${index}`,
      });
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

  it("continues when one insight fails", async () => {
    mockPipeline.mockRejectedValueOnce(new Error("AI provider error"));
    mockPipeline.mockResolvedValueOnce(mockPipelineSuccess("Tweet 2"));
    mockPipeline.mockResolvedValueOnce(mockPipelineSuccess("Tweet 3"));

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

  it("throws when every insight fails and cleans up the campaign", async () => {
    testInsights.forEach(() => {
      mockPipeline.mockRejectedValueOnce(new Error("AI error"));
    });

    await expect(
      batchGenerateDrafts({
        userId: "user-1",
        insights: testInsights,
        sourceContent: "Content",
        sourceType: "REPORT",
        createCampaign: true,
      }),
    ).rejects.toThrow("Failed to generate any drafts from the provided insights");

    expect(prisma.campaign.delete).toHaveBeenCalledWith({ where: { id: "campaign-1" } });
  });

  it("skips empty pipeline results", async () => {
    mockPipeline.mockResolvedValueOnce({
      ctx: { generatedContent: null, confidence: 0.5, predictedEngagement: 500, stepResults: [] },
      steps: [],
      totalMs: 500,
    });
    mockPipeline.mockResolvedValueOnce(mockPipelineSuccess("Real tweet"));

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

  it("computes score and qualityScore from confidence and engagement", async () => {
    mockPipeline.mockResolvedValueOnce({
      ctx: {
        generatedContent: "High quality tweet",
        confidence: 0.9,
        predictedEngagement: 5000,
        stepResults: [],
      },
      steps: [],
      totalMs: 800,
    });
    prisma.tweetDraft.create.mockResolvedValueOnce({
      id: "draft-1",
      content: "High quality tweet",
    });

    const result = await batchGenerateDrafts({
      userId: "user-1",
      insights: [testInsights[0]],
      sourceContent: "Content",
      sourceType: "REPORT",
    });

    expect(result.drafts[0].score).toBe(0.93);
    expect(result.drafts[0].qualityScore).toBe(93);
  });

  it("passes tone and angle guidance into the pipeline", async () => {
    mockPipeline.mockResolvedValueOnce(mockPipelineSuccess("Tweet"));
    prisma.tweetDraft.create.mockResolvedValueOnce({ id: "draft-1", content: "Tweet" });

    await batchGenerateDrafts({
      userId: "user-1",
      insights: [testInsights[0]],
      sourceContent: "Content",
      sourceType: "REPORT",
      tone: "bold",
    });

    expect(mockPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        sourceType: "REPORT",
        angleInstruction: expect.stringContaining("bold"),
      }),
    );
  });
});
