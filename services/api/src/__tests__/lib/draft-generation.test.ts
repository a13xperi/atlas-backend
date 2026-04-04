jest.mock("../../lib/prisma", () => ({
  prisma: {
    tweetDraft: {
      create: jest.fn(),
      findFirst: jest.fn(),
    },
    analyticsEvent: {
      create: jest.fn(),
    },
  },
}));

jest.mock("../../lib/pipeline", () => ({
  runGenerationPipeline: jest.fn(),
}));

import { prisma } from "../../lib/prisma";
import { runGenerationPipeline } from "../../lib/pipeline";
import {
  generateDraftFromSource,
  normalizeGeneratedTweet,
  refineDraftFromExisting,
  refineLatestDraftForUser,
  regenerateDraftFromExisting,
} from "../../lib/draft-generation";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockRunGenerationPipeline = runGenerationPipeline as jest.Mock;
const mockTweetDraftCreate = mockPrisma.tweetDraft.create as unknown as jest.Mock;
const mockTweetDraftFindFirst = mockPrisma.tweetDraft.findFirst as unknown as jest.Mock;
const mockAnalyticsCreate = mockPrisma.analyticsEvent.create as unknown as jest.Mock;

describe("draft-generation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("generates a draft, caps it at 280 chars, and logs analytics", async () => {
    const generatedContent = "x".repeat(300);
    const normalized = normalizeGeneratedTweet(generatedContent);
    mockRunGenerationPipeline.mockResolvedValueOnce({
      ctx: {
        generatedContent,
        confidence: 0.84,
        predictedEngagement: 1900,
        stepResults: [],
      },
      steps: [],
      totalMs: 120,
    });
    mockTweetDraftCreate.mockResolvedValueOnce({
      id: "draft-1",
      userId: "user-1",
      content: normalized,
      version: 1,
    } as any);
    mockAnalyticsCreate.mockResolvedValue({} as any);

    const result = await generateDraftFromSource({
      userId: "user-1",
      sourceContent: "A raw idea about BTC strength",
      sourceType: "MANUAL",
      timeoutLabel: "telegram-draft",
    });

    expect(mockRunGenerationPipeline).toHaveBeenCalledWith({
      userId: "user-1",
      sourceContent: "A raw idea about BTC strength",
      sourceType: "MANUAL",
      blendId: undefined,
      feedback: undefined,
      replyAngle: undefined,
    });
    expect(mockTweetDraftCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        content: normalized,
        sourceType: "MANUAL",
        sourceContent: "A raw idea about BTC strength",
        version: 1,
      }),
    });
    expect(mockAnalyticsCreate).toHaveBeenCalledWith({
      data: { userId: "user-1", type: "DRAFT_CREATED" },
    });
    expect(result.pipeline.ctx.generatedContent).toBe(normalized);
  });

  it("regenerates from an existing draft and logs feedback analytics when provided", async () => {
    mockRunGenerationPipeline.mockResolvedValueOnce({
      ctx: {
        generatedContent: "A sharper second pass.",
        confidence: 0.9,
        predictedEngagement: 2200,
        stepResults: [],
      },
      steps: [],
      totalMs: 90,
    });
    mockTweetDraftCreate.mockResolvedValueOnce({
      id: "draft-2",
      userId: "user-1",
      content: "A sharper second pass.",
      version: 2,
    } as any);
    mockAnalyticsCreate.mockResolvedValue({} as any);

    await regenerateDraftFromExisting({
      userId: "user-1",
      existing: {
        content: "Original draft",
        sourceType: "ARTICLE",
        sourceContent: "Long-form article text",
        blendId: "blend-1",
        feedback: null,
        version: 1,
      },
      feedback: "Make it punchier",
      timeoutLabel: "regenerate-pipeline",
    });

    expect(mockRunGenerationPipeline).toHaveBeenCalledWith({
      userId: "user-1",
      sourceContent: "Long-form article text",
      sourceType: "ARTICLE",
      blendId: "blend-1",
      feedback: "Make it punchier",
    });
    expect(mockTweetDraftCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        version: 2,
        feedback: "Make it punchier",
      }),
    });
    expect(mockAnalyticsCreate).toHaveBeenCalledTimes(2);
  });

  it("refines the latest draft for a user and preserves version history", async () => {
    mockTweetDraftFindFirst.mockResolvedValueOnce({
      id: "draft-9",
      userId: "user-1",
      content: "ETH fees keep compressing.",
      sourceType: "MANUAL",
      sourceContent: "ETH fees keep compressing.",
      blendId: null,
      feedback: null,
      version: 3,
      createdAt: new Date(),
    } as any);
    mockRunGenerationPipeline.mockResolvedValueOnce({
      ctx: {
        generatedContent:
          "ETH fees are compressing fast. Market still hasn't priced the second-order effects.",
        confidence: 0.88,
        predictedEngagement: 1700,
        stepResults: [],
      },
      steps: [],
      totalMs: 95,
    });
    mockTweetDraftCreate.mockResolvedValueOnce({
      id: "draft-10",
      userId: "user-1",
      content:
        "ETH fees are compressing fast. Market still hasn't priced the second-order effects.",
      version: 4,
    } as any);
    mockAnalyticsCreate.mockResolvedValue({} as any);

    await refineLatestDraftForUser({
      userId: "user-1",
      instruction: "Make it more contrarian",
      timeoutLabel: "telegram-refine",
    });

    expect(mockTweetDraftFindFirst).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: { createdAt: "desc" },
    });
    expect(mockRunGenerationPipeline).toHaveBeenCalledWith({
      userId: "user-1",
      sourceContent:
        'Original draft: "ETH fees keep compressing."\n\nRefinement instruction: Make it more contrarian',
      sourceType: "MANUAL",
      blendId: undefined,
      feedback: "Make it more contrarian",
    });
    expect(mockTweetDraftCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        version: 4,
        feedback: "Make it more contrarian",
      }),
    });
  });

  it("keeps short tweets unchanged after normalization", () => {
    expect(normalizeGeneratedTweet("  clean tweet  ")).toBe("clean tweet");
  });

  it("refines a specific draft and logs both analytics events", async () => {
    mockRunGenerationPipeline.mockResolvedValueOnce({
      ctx: {
        generatedContent: "Tighter refined draft",
        confidence: 0.81,
        predictedEngagement: 1400,
        stepResults: [],
      },
      steps: [],
      totalMs: 75,
    });
    mockTweetDraftCreate.mockResolvedValueOnce({
      id: "draft-11",
      userId: "user-1",
      content: "Tighter refined draft",
      version: 5,
    } as any);
    mockAnalyticsCreate.mockResolvedValue({} as any);

    await refineDraftFromExisting({
      userId: "user-1",
      existing: {
        content: "Verbose draft",
        sourceType: "MANUAL",
        sourceContent: "Verbose draft",
        blendId: null,
        feedback: null,
        version: 4,
      },
      instruction: "Trim the filler",
      timeoutLabel: "refine-pipeline",
    });

    expect(mockAnalyticsCreate).toHaveBeenCalledTimes(2);
  });
});
