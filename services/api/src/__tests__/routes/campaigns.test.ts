import request from "supertest";
import express from "express";
import { campaignsRouter } from "../../routes/campaigns";
import { requestIdMiddleware } from "../../middleware/requestId";
import { expectErrorResponse, expectSuccessResponse } from "../helpers/response";

jest.mock("../../middleware/auth", () => ({
  authenticate: jest.fn((req: any, res: any, next: any) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "Missing authorization token" });
    req.userId = "user-123";
    next();
  }),
  AuthRequest: {},
}));

jest.mock("../../lib/supabase", () => ({ supabaseAdmin: null }));

jest.mock("../../lib/prisma", () => ({
  prisma: {
    campaign: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      deleteMany: jest.fn(),
    },
    researchResult: {
      findFirst: jest.fn(),
    },
    tweetDraft: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

jest.mock("../../lib/content-extraction", () => ({
  extractInsights: jest.fn(),
}));

jest.mock("../../lib/batch-generate", () => ({
  batchGenerateDrafts: jest.fn(),
}));

import { prisma } from "../../lib/prisma";
import { extractInsights } from "../../lib/content-extraction";
import { batchGenerateDrafts } from "../../lib/batch-generate";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockExtractInsights = extractInsights as jest.Mock;
const mockBatchGenerateDrafts = batchGenerateDrafts as jest.Mock;

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/campaigns", campaignsRouter);

const AUTH = { Authorization: "Bearer mock_token" };

beforeAll(() => {
  process.env.JWT_SECRET = "test-secret";
});

afterAll(() => {
  delete process.env.JWT_SECRET;
});

describe("POST /api/campaigns/generate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).post("/api/campaigns/generate").send({
      contentId: "res-1",
      angles: 3,
      tone: "professional",
      userId: "user-123",
    });

    expect(res.status).toBe(401);
  });

  it("generates a campaign from stored research content", async () => {
    (mockPrisma.researchResult.findFirst as jest.Mock).mockResolvedValueOnce({
      id: "res-1",
      userId: "user-123",
      query: "BTC market structure report",
      summary: "BTC dominance is rising while alt liquidity is compressing.",
      keyFacts: ["BTC dominance hit 58%"],
      relatedTopics: ["liquidity", "alts"],
      sources: ["Internal desk note"],
      confidence: 0.88,
      sentiment: "bullish",
      draftId: null,
      createdAt: new Date(),
    } as any);
    mockExtractInsights.mockResolvedValueOnce([
      {
        title: "Dominance is back",
        summary: "BTC is reclaiming attention from the rest of the market.",
        keyQuote: "BTC dominance hit 58%.",
        angle: "data highlight",
      },
    ]);
    mockBatchGenerateDrafts.mockResolvedValueOnce({
      campaign: { id: "campaign-1", title: "BTC market structure report Campaign" },
      drafts: [
        {
          id: "draft-1",
          content: "BTC dominance is doing the talking again.",
          angle: "data highlight",
          score: 0.87,
          qualityScore: 87,
          status: "DRAFT",
        },
      ],
    });

    const res = await request(app)
      .post("/api/campaigns/generate")
      .set(AUTH)
      .send({
        contentId: "res-1",
        angles: 3,
        tone: "professional",
        userId: "user-123",
      });

    expect(res.status).toBe(201);
    const data = expectSuccessResponse<any>(res.body);
    expect(data.campaignId).toBe("campaign-1");
    expect(data.drafts[0]).toEqual({
      id: "draft-1",
      content: "BTC dominance is doing the talking again.",
      angle: "data highlight",
      score: 0.87,
    });
    expect(mockExtractInsights).toHaveBeenCalledWith(
      expect.stringContaining("Summary: BTC dominance is rising"),
      { limit: 3 },
    );
    expect(mockBatchGenerateDrafts).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-123",
        tone: "professional",
        createCampaign: true,
      }),
    );
  });

  it("rejects mismatched user ids", async () => {
    const res = await request(app)
      .post("/api/campaigns/generate")
      .set(AUTH)
      .send({
        contentId: "res-1",
        angles: 3,
        tone: "professional",
        userId: "someone-else",
      });

    expect(res.status).toBe(403);
    expectErrorResponse(res.body, "Forbidden");
  });

  it("returns 404 when the content cannot be resolved", async () => {
    (mockPrisma.researchResult.findFirst as jest.Mock).mockResolvedValueOnce(null);
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(null);

    const res = await request(app)
      .post("/api/campaigns/generate")
      .set(AUTH)
      .send({
        contentId: "missing",
        angles: 3,
        tone: "professional",
        userId: "user-123",
      });

    expect(res.status).toBe(404);
    expectErrorResponse(res.body, "Content not found");
  });
});

describe("GET /api/campaigns/:id/drafts", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns campaign drafts with status", async () => {
    (mockPrisma.campaign.findFirst as jest.Mock).mockResolvedValueOnce({
      id: "campaign-1",
      userId: "user-123",
      drafts: [
        {
          id: "draft-1",
          content: "BTC dominance is doing the talking again.",
          status: "DRAFT",
          sortOrder: 1,
        },
      ],
    } as any);

    const res = await request(app)
      .get("/api/campaigns/campaign-1/drafts")
      .set(AUTH);

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);
    expect(data.drafts).toHaveLength(1);
    expect(data.drafts[0].status).toBe("DRAFT");
  });

  it("returns 404 when the campaign is missing", async () => {
    (mockPrisma.campaign.findFirst as jest.Mock).mockResolvedValueOnce(null);

    const res = await request(app)
      .get("/api/campaigns/missing/drafts")
      .set(AUTH);

    expect(res.status).toBe(404);
    expectErrorResponse(res.body, "Campaign not found");
  });
});
