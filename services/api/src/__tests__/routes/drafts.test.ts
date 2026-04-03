/**
 * Drafts routes test suite
 * Tests: CRUD routes, POST /generate, POST /from-article, POST /reply, POST /:id/regenerate
 * Mocks: Prisma, pipeline (runGenerationPipeline), research, fetch, JWT
 */

import request from "supertest";
import express from "express";
import { draftsRouter } from "../../routes/drafts";
import { requestIdMiddleware } from "../../middleware/requestId";
import { expectErrorResponse, expectSuccessResponse } from "../helpers/response";

// --- Mocks ---

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
    tweetDraft: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    voiceProfile: {
      findUnique: jest.fn(),
    },
    savedBlend: {
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

jest.mock("../../lib/research", () => ({
  conductResearch: jest.fn(),
}));

import { prisma } from "../../lib/prisma";
import { runGenerationPipeline } from "../../lib/pipeline";
import { conductResearch } from "../../lib/research";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockRunPipeline = runGenerationPipeline as jest.Mock;
const mockConductResearch = conductResearch as jest.Mock;
const originalFetch = global.fetch;
const mockFetch = jest.fn();

// --- App setup ---

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/drafts", draftsRouter);

const AUTH = "Bearer mock_token";

const responseData = (res: any) => expectSuccessResponse<any>(res.body);
const responseError = (res: any, message?: string) => expectErrorResponse(res.body, message);
const responseMessage = (res: any) => res.body.details?.message;

const mockDraft = {
  id: "draft-1",
  userId: "user-123",
  content: "Hello crypto world!",
  status: "DRAFT",
  sourceType: "MANUAL",
  sourceContent: null,
  blendId: null,
  feedback: null,
  confidence: 0.8,
  predictedEngagement: 1500,
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockVoiceProfile = {
  id: "vp-1",
  userId: "user-123",
  humor: 50,
  formality: 50,
  brevity: 50,
  contrarianTone: 30,
  maturity: "INTERMEDIATE",
};

// --- GET / ---

beforeAll(() => {
  process.env.JWT_SECRET = "test-secret";
  global.fetch = mockFetch as typeof fetch;
});

beforeEach(() => {
  (mockPrisma.tweetDraft.findMany as jest.Mock).mockReset();
  (mockPrisma.tweetDraft.findFirst as jest.Mock).mockReset();
  (mockPrisma.tweetDraft.count as jest.Mock).mockReset();
  (mockPrisma.tweetDraft.create as jest.Mock).mockReset();
  (mockPrisma.tweetDraft.update as jest.Mock).mockReset();
  (mockPrisma.tweetDraft.delete as jest.Mock).mockReset();
  (mockPrisma.user.findUnique as jest.Mock).mockReset();
  (mockPrisma.savedBlend.findFirst as jest.Mock).mockReset();
  (mockPrisma.analyticsEvent.create as jest.Mock).mockReset();
  mockRunPipeline.mockReset();
  mockConductResearch.mockReset();
  mockFetch.mockReset();
  delete process.env.TWITTER_BEARER_TOKEN;
});

afterAll(() => {
  delete process.env.JWT_SECRET;
  delete process.env.TWITTER_BEARER_TOKEN;
  global.fetch = originalFetch;
});

describe("GET /api/drafts", () => {
  it("returns 401 without auth token", async () => {
    const res = await request(app).get("/api/drafts");
    expect(res.status).toBe(401);
  });

  it("returns list of drafts for authenticated user", async () => {
    (mockPrisma.tweetDraft.findMany as jest.Mock).mockResolvedValueOnce([mockDraft]);

    const res = await request(app)
      .get("/api/drafts")
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(responseData(res).drafts).toHaveLength(1);
    expect(responseData(res).drafts[0].id).toBe("draft-1");
  });

  it("computes lastAction for posted, approved, edited, and fresh drafts", async () => {
    const createdAt = new Date("2026-04-03T10:00:00.000Z");

    (mockPrisma.tweetDraft.findMany as jest.Mock).mockResolvedValueOnce([
      { ...mockDraft, id: "posted-draft", status: "POSTED", createdAt, updatedAt: createdAt },
      { ...mockDraft, id: "approved-draft", status: "APPROVED", createdAt, updatedAt: createdAt },
      {
        ...mockDraft,
        id: "edited-draft",
        status: "DRAFT",
        createdAt,
        updatedAt: new Date(createdAt.getTime() + 61_000),
      },
      {
        ...mockDraft,
        id: "fresh-draft",
        status: "DRAFT",
        createdAt,
        updatedAt: new Date(createdAt.getTime() + 60_000),
      },
    ]);

    const res = await request(app)
      .get("/api/drafts")
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(responseData(res).drafts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "posted-draft", lastAction: "posted" }),
        expect.objectContaining({ id: "approved-draft", lastAction: "approved" }),
        expect.objectContaining({ id: "edited-draft", lastAction: "edited" }),
        expect.objectContaining({ id: "fresh-draft", lastAction: "draft" }),
      ])
    );
  });

  it("passes status filter to Prisma", async () => {
    (mockPrisma.tweetDraft.findMany as jest.Mock).mockResolvedValueOnce([]);

    await request(app)
      .get("/api/drafts?status=POSTED")
      .set("Authorization", AUTH);

    expect(mockPrisma.tweetDraft.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "POSTED" }),
      })
    );
  });

  it("uses default pagination (limit=20, offset=0)", async () => {
    (mockPrisma.tweetDraft.findMany as jest.Mock).mockResolvedValueOnce([]);

    await request(app)
      .get("/api/drafts")
      .set("Authorization", AUTH);

    expect(mockPrisma.tweetDraft.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20, skip: 0 })
    );
  });

  it("returns 500 when listing drafts fails", async () => {
    (mockPrisma.tweetDraft.findMany as jest.Mock).mockRejectedValueOnce(new Error("db down"));

    const res = await request(app)
      .get("/api/drafts")
      .set("Authorization", AUTH);

    expect(res.status).toBe(500);
    responseError(res, "Failed to load drafts");
    expect(responseMessage(res)).toBe("db down");
  });
});

describe("GET /api/drafts/stats", () => {
  it("returns per-user draft counts", async () => {
    (mockPrisma.tweetDraft.count as jest.Mock)
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);

    const res = await request(app)
      .get("/api/drafts/stats")
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(responseData(res)).toEqual({
      total: 7,
      drafts: 3,
      approved: 2,
      posted: 1,
      archived: 1,
    });
    expect(mockPrisma.tweetDraft.count).toHaveBeenNthCalledWith(1, {
      where: { userId: "user-123" },
    });
    expect(mockPrisma.tweetDraft.count).toHaveBeenNthCalledWith(2, {
      where: { userId: "user-123", status: "DRAFT" },
    });
    expect(mockPrisma.tweetDraft.count).toHaveBeenNthCalledWith(3, {
      where: { userId: "user-123", status: "APPROVED" },
    });
    expect(mockPrisma.tweetDraft.count).toHaveBeenNthCalledWith(4, {
      where: { userId: "user-123", status: "POSTED" },
    });
    expect(mockPrisma.tweetDraft.count).toHaveBeenNthCalledWith(5, {
      where: { userId: "user-123", status: "ARCHIVED" },
    });
  });

  it("returns 500 when loading stats fails", async () => {
    (mockPrisma.tweetDraft.count as jest.Mock).mockRejectedValueOnce(new Error("db down"));

    const res = await request(app)
      .get("/api/drafts/stats")
      .set("Authorization", AUTH);

    expect(res.status).toBe(500);
    responseError(res, "Failed to load draft stats");
    expect(responseMessage(res)).toBe("db down");
  });
});

describe("GET /api/drafts/history", () => {
  it("returns the 20 most recent drafts with characterCount", async () => {
    const createdAt = new Date("2026-04-03T12:00:00.000Z");
    (mockPrisma.tweetDraft.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: "draft-history-1",
        content: "Alpha thread",
        status: "POSTED",
        createdAt,
      },
    ]);

    const res = await request(app)
      .get("/api/drafts/history")
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(mockPrisma.tweetDraft.findMany).toHaveBeenCalledWith({
      where: { userId: "user-123" },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        content: true,
        status: true,
        createdAt: true,
      },
    });

    expect(responseData(res).drafts).toEqual([
      {
        id: "draft-history-1",
        content: "Alpha thread",
        status: "POSTED",
        createdAt: createdAt.toISOString(),
        characterCount: "Alpha thread".length,
      },
    ]);
  });

  it("returns 500 when loading draft history fails", async () => {
    (mockPrisma.tweetDraft.findMany as jest.Mock).mockRejectedValueOnce(new Error("db down"));

    const res = await request(app)
      .get("/api/drafts/history")
      .set("Authorization", AUTH);

    expect(res.status).toBe(500);
    responseError(res, "Failed to load draft history");
  });
});

describe("GET /api/drafts/team", () => {
  it("uses default pagination for team drafts", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ role: "MANAGER" });
    (mockPrisma.tweetDraft.findMany as jest.Mock).mockResolvedValueOnce([]);

    const res = await request(app)
      .get("/api/drafts/team")
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(mockPrisma.tweetDraft.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50, skip: 0 })
    );
  });
});

// --- GET /:id ---

describe("GET /api/drafts/:id", () => {
  it("returns 404 when draft not found", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(null);

    const res = await request(app)
      .get("/api/drafts/nonexistent")
      .set("Authorization", AUTH);

    expect(res.status).toBe(404);
    responseError(res, "Draft not found");
  });

  it("returns draft when found", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(mockDraft);

    const res = await request(app)
      .get("/api/drafts/draft-1")
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(responseData(res).draft.id).toBe("draft-1");
    expect(responseData(res).draft.lastAction).toBe("draft");
  });

  it("returns 500 when loading a draft fails", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockRejectedValueOnce(new Error("db down"));

    const res = await request(app)
      .get("/api/drafts/draft-1")
      .set("Authorization", AUTH);

    expect(res.status).toBe(500);
    responseError(res, "Failed to get draft");
    expect(responseMessage(res)).toBe("db down");
  });
});

// --- POST / ---

describe("POST /api/drafts", () => {
  it("returns 400 when content is missing", async () => {
    const res = await request(app)
      .post("/api/drafts")
      .set("Authorization", AUTH)
      .send({});

    expect(res.status).toBe(400);
    responseError(res, "Invalid request");
  });

  it("creates draft and logs analytics event", async () => {
    (mockPrisma.tweetDraft.create as jest.Mock).mockResolvedValueOnce(mockDraft);
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValueOnce({});

    const res = await request(app)
      .post("/api/drafts")
      .set("Authorization", AUTH)
      .send({ content: "Hello crypto world!", sourceType: "MANUAL" });

    expect(res.status).toBe(200);
    expect(responseData(res).draft.content).toBe("Hello crypto world!");
    expect(mockPrisma.analyticsEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "DRAFT_CREATED" }),
      })
    );
  });

  it("returns 500 when creating a draft fails", async () => {
    (mockPrisma.tweetDraft.create as jest.Mock).mockRejectedValueOnce(new Error("db down"));

    const res = await request(app)
      .post("/api/drafts")
      .set("Authorization", AUTH)
      .send({ content: "Hello crypto world!" });

    expect(res.status).toBe(500);
    responseError(res, "Failed to create draft");
    expect(responseMessage(res)).toBe("db down");
  });
});

// --- PATCH /:id ---

describe("PATCH /api/drafts/:id", () => {
  it("returns 404 when draft not found", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(null);

    const res = await request(app)
      .patch("/api/drafts/nonexistent")
      .set("Authorization", AUTH)
      .send({ content: "updated" });

    expect(res.status).toBe(404);
  });

  it("updates draft content", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(mockDraft);
    const updated = { ...mockDraft, content: "updated content" };
    (mockPrisma.tweetDraft.update as jest.Mock).mockResolvedValueOnce(updated);

    const res = await request(app)
      .patch("/api/drafts/draft-1")
      .set("Authorization", AUTH)
      .send({ content: "updated content" });

    expect(res.status).toBe(200);
    expect(responseData(res).draft.content).toBe("updated content");
  });

  it("logs FEEDBACK_GIVEN event when feedback is provided", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(mockDraft);
    (mockPrisma.tweetDraft.update as jest.Mock).mockResolvedValueOnce({ ...mockDraft, feedback: "too long" });
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValue({});

    await request(app)
      .patch("/api/drafts/draft-1")
      .set("Authorization", AUTH)
      .send({ feedback: "too long" });

    expect(mockPrisma.analyticsEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "FEEDBACK_GIVEN" }),
      })
    );
  });

  it("logs DRAFT_POSTED event when status is POSTED", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(mockDraft);
    (mockPrisma.tweetDraft.update as jest.Mock).mockResolvedValueOnce({ ...mockDraft, status: "POSTED" });
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValue({});

    await request(app)
      .patch("/api/drafts/draft-1")
      .set("Authorization", AUTH)
      .send({ status: "POSTED" });

    expect(mockPrisma.analyticsEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "DRAFT_POSTED" }),
      })
    );
  });

  it("returns 400 for invalid patch payloads", async () => {
    const res = await request(app)
      .patch("/api/drafts/draft-1")
      .set("Authorization", AUTH)
      .send({ status: "NOT_A_STATUS" });

    expect(res.status).toBe(400);
    responseError(res, "Invalid request");
  });

  it("returns 500 when updating a draft fails", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(mockDraft);
    (mockPrisma.tweetDraft.update as jest.Mock).mockRejectedValueOnce(new Error("db down"));

    const res = await request(app)
      .patch("/api/drafts/draft-1")
      .set("Authorization", AUTH)
      .send({ content: "updated content" });

    expect(res.status).toBe(500);
    responseError(res, "Failed to update draft");
    expect(responseMessage(res)).toBe("db down");
  });
});

describe("PATCH /api/drafts/:id/status", () => {
  it("returns 404 when draft not found", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(null);

    const res = await request(app)
      .patch("/api/drafts/nonexistent/status")
      .set("Authorization", AUTH)
      .send({ status: "posted" });

    expect(res.status).toBe(404);
    responseError(res, "Draft not found");
  });

  it("updates draft status and normalizes lowercase values", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(mockDraft);
    (mockPrisma.tweetDraft.update as jest.Mock).mockResolvedValueOnce({ ...mockDraft, status: "ARCHIVED" });

    const res = await request(app)
      .patch("/api/drafts/draft-1/status")
      .set("Authorization", AUTH)
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    expect(mockPrisma.tweetDraft.update).toHaveBeenCalledWith({
      where: { id: "draft-1" },
      data: { status: "ARCHIVED" },
    });
    expect(responseData(res).draft.status).toBe("ARCHIVED");
  });

  it("logs DRAFT_POSTED when status is POSTED", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(mockDraft);
    (mockPrisma.tweetDraft.update as jest.Mock).mockResolvedValueOnce({ ...mockDraft, status: "POSTED" });
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValue({});

    await request(app)
      .patch("/api/drafts/draft-1/status")
      .set("Authorization", AUTH)
      .send({ status: "posted" });

    expect(mockPrisma.analyticsEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "DRAFT_POSTED" }),
      })
    );
  });

  it("returns 400 for invalid status payloads", async () => {
    const res = await request(app)
      .patch("/api/drafts/draft-1/status")
      .set("Authorization", AUTH)
      .send({ status: "copied" });

    expect(res.status).toBe(400);
    responseError(res, "Invalid request");
  });

  it("returns 500 when updating draft status fails", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(mockDraft);
    (mockPrisma.tweetDraft.update as jest.Mock).mockRejectedValueOnce(new Error("db down"));

    const res = await request(app)
      .patch("/api/drafts/draft-1/status")
      .set("Authorization", AUTH)
      .send({ status: "POSTED" });

    expect(res.status).toBe(500);
    responseError(res, "Failed to update draft status");
  });
});

// --- DELETE /:id ---

describe("DELETE /api/drafts/:id", () => {
  it("returns 404 when draft not found", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(null);

    const res = await request(app)
      .delete("/api/drafts/nonexistent")
      .set("Authorization", AUTH);

    expect(res.status).toBe(404);
  });

  it("deletes draft and returns success", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(mockDraft);
    (mockPrisma.tweetDraft.delete as jest.Mock).mockResolvedValueOnce(mockDraft);

    const res = await request(app)
      .delete("/api/drafts/draft-1")
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(responseData(res).success).toBe(true);
  });

  it("returns 500 when deleting a draft fails", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(mockDraft);
    (mockPrisma.tweetDraft.delete as jest.Mock).mockRejectedValueOnce(new Error("db down"));

    const res = await request(app)
      .delete("/api/drafts/draft-1")
      .set("Authorization", AUTH);

    expect(res.status).toBe(500);
    responseError(res, "Failed to delete draft");
    expect(responseMessage(res)).toBe("db down");
  });
});

// --- POST /generate ---

describe("POST /api/drafts/generate", () => {
  it("returns 400 when required fields are missing", async () => {
    const res = await request(app)
      .post("/api/drafts/generate")
      .set("Authorization", AUTH)
      .send({});

    expect(res.status).toBe(400);
    responseError(res, "Invalid request");
  });

  it("returns 400 when voice profile not found", async () => {
    mockRunPipeline.mockRejectedValueOnce(new Error("Voice profile not found. Complete onboarding first."));

    const res = await request(app)
      .post("/api/drafts/generate")
      .set("Authorization", AUTH)
      .send({ sourceContent: "BTC hits ATH", sourceType: "TWEET" });

    expect(res.status).toBe(400);
    expect(responseError(res).error).toMatch(/Voice profile not found/);
  });

  it("generates tweet, saves draft, logs analytics event", async () => {
    mockRunPipeline.mockResolvedValueOnce({
      ctx: {
        generatedContent: "BTC just hit ATH!",
        confidence: 0.85,
        predictedEngagement: 2000,
        stepResults: [],
      },
      steps: [],
      totalMs: 500,
    });
    (mockPrisma.tweetDraft.create as jest.Mock).mockResolvedValueOnce({
      ...mockDraft,
      content: "BTC just hit ATH!",
    });
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValueOnce({});

    const res = await request(app)
      .post("/api/drafts/generate")
      .set("Authorization", AUTH)
      .send({ sourceContent: "BTC hits ATH", sourceType: "TWEET" });

    expect(res.status).toBe(200);
    expect(responseData(res).draft).toBeDefined();
    expect(mockRunPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-123",
        sourceContent: "BTC hits ATH",
        sourceType: "TWEET",
      })
    );
    expect(mockPrisma.analyticsEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "DRAFT_CREATED" }),
      })
    );
  });

  it("returns 502 when AI generation fails", async () => {
    mockRunPipeline.mockRejectedValueOnce(new Error("OpenAI timeout"));

    const res = await request(app)
      .post("/api/drafts/generate")
      .set("Authorization", AUTH)
      .send({ sourceContent: "BTC hits ATH", sourceType: "TWEET" });

    expect(res.status).toBe(502);
    responseError(res, "AI generation failed");
  });
});

describe("POST /api/drafts/from-article", () => {
  it("returns 400 when articleUrl is missing", async () => {
    const res = await request(app)
      .post("/api/drafts/from-article")
      .set("Authorization", AUTH)
      .send({});

    expect(res.status).toBe(400);
    responseError(res, "Invalid request");
  });

  it("uses articleText directly when provided", async () => {
    mockRunPipeline.mockResolvedValueOnce({
      ctx: {
        generatedContent: "Bitcoin upside still looks underpriced if the bid stays this sticky.",
        confidence: 0.83,
        predictedEngagement: 1800,
        stepResults: [],
      },
      steps: [],
      totalMs: 350,
    });

    const res = await request(app)
      .post("/api/drafts/from-article")
      .set("Authorization", AUTH)
      .send({
        articleUrl: "https://www.example.com/articles/btc-outlook?utm_source=x",
        articleText: "Bitcoin demand keeps broadening while exchange balances remain tight.",
      });

    expect(res.status).toBe(200);
    expect(responseData(res)).toEqual({
      draft:
        "Bitcoin upside still looks underpriced if the bid stays this sticky. https://www.example.com/articles/btc-outlook",
      sourceUrl: "https://www.example.com/articles/btc-outlook",
      characterCount:
        "Bitcoin upside still looks underpriced if the bid stays this sticky. https://www.example.com/articles/btc-outlook"
          .length,
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockConductResearch).not.toHaveBeenCalled();
    expect(mockRunPipeline).toHaveBeenCalledWith({
      userId: "user-123",
      sourceContent: "Bitcoin demand keeps broadening while exchange balances remain tight.",
      sourceType: "ARTICLE",
    });
  });

  it("fetches the article and researches key points when articleText is not provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: () => "text/html; charset=utf-8",
      },
      text: async () =>
        "<html><body><article><h1>ETH treasury adoption</h1><p>Public companies are still absorbing ETH supply faster than the market expected.</p></article></body></html>",
    } as any);
    mockConductResearch.mockResolvedValueOnce({
      summary: "ETH treasury demand is broadening beyond the early adopters.",
      keyFacts: ["Public companies are adding ETH", "Supply remains tight"],
      sentiment: "bullish",
      relatedTopics: [],
      sources: ["https://example.com/eth-treasury"],
      confidence: 0.91,
    });
    mockRunPipeline.mockResolvedValueOnce({
      ctx: {
        generatedContent: "ETH treasury demand keeps widening faster than consensus expects.",
        confidence: 0.87,
        predictedEngagement: 1900,
        stepResults: [],
      },
      steps: [],
      totalMs: 420,
    });

    const res = await request(app)
      .post("/api/drafts/from-article")
      .set("Authorization", AUTH)
      .send({
        articleUrl: "https://example.com/eth-treasury?ref=feed",
      });

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith("https://example.com/eth-treasury?ref=feed");
    expect(mockConductResearch).toHaveBeenCalledWith({
      query: expect.stringContaining("Public companies are still absorbing ETH supply"),
      context: "ARTICLE",
    });
    expect(mockRunPipeline).toHaveBeenCalledWith({
      userId: "user-123",
      sourceContent: expect.stringContaining("Summary: ETH treasury demand is broadening beyond the early adopters."),
      sourceType: "ARTICLE",
    });
    expect(responseData(res)).toEqual({
      draft: "ETH treasury demand keeps widening faster than consensus expects. https://example.com/eth-treasury",
      sourceUrl: "https://example.com/eth-treasury",
      characterCount:
        "ETH treasury demand keeps widening faster than consensus expects. https://example.com/eth-treasury".length,
    });
  });

  it("truncates the generated post so the source URL still fits under 280 characters", async () => {
    const generatedContent = "a".repeat(260);
    mockRunPipeline.mockResolvedValueOnce({
      ctx: {
        generatedContent,
        confidence: 0.79,
        predictedEngagement: 1400,
        stepResults: [],
      },
      steps: [],
      totalMs: 300,
    });

    const res = await request(app)
      .post("/api/drafts/from-article")
      .set("Authorization", AUTH)
      .send({
        articleUrl: "https://example.com/very-long-article",
        articleText: "Macro liquidity is shifting faster than price is discounting.",
      });

    expect(res.status).toBe(200);
    expect(responseData(res).characterCount).toBeLessThanOrEqual(280);
    expect(responseData(res).draft.endsWith("https://example.com/very-long-article")).toBe(true);
  });

  it("returns 400 when voice profile is missing", async () => {
    mockRunPipeline.mockRejectedValueOnce(new Error("Voice profile not found. Complete onboarding first."));

    const res = await request(app)
      .post("/api/drafts/from-article")
      .set("Authorization", AUTH)
      .send({
        articleUrl: "https://example.com/btc-article",
        articleText: "BTC adoption keeps compounding through every pullback.",
      });

    expect(res.status).toBe(400);
    responseError(res, "Voice profile not found. Complete onboarding first.");
  });
});

describe("POST /api/drafts/reply", () => {
  it("returns 400 when tweetUrl and tweetText are both missing", async () => {
    const res = await request(app)
      .post("/api/drafts/reply")
      .set("Authorization", AUTH)
      .send({});

    expect(res.status).toBe(400);
    responseError(res, "Invalid request");
  });

  it("fetches tweet content from x.com and generates a contextual reply", async () => {
    process.env.TWITTER_BEARER_TOKEN = "twitter-token";
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          text: "ETH ETF demand still looks underpriced relative to how sticky these inflows are.",
        },
      }),
    } as any);
    mockRunPipeline.mockResolvedValueOnce({
      ctx: {
        generatedContent: "Yep. The market's still pricing the headline, not the durability of the bid.",
        confidence: 0.84,
        predictedEngagement: 1700,
        stepResults: [],
      },
      steps: [],
      totalMs: 320,
    });

    const res = await request(app)
      .post("/api/drafts/reply")
      .set("Authorization", AUTH)
      .send({
        tweetUrl: "https://x.com/atlas/status/1908123456789012345?s=20",
        angle: "highlight that the market is underestimating persistent flows",
      });

    expect(res.status).toBe(200);
    expect(responseData(res).reply).toBe("Yep. The market's still pricing the headline, not the durability of the bid.");
    expect(responseData(res).originalTweet).toBe(
      "ETH ETF demand still looks underpriced relative to how sticky these inflows are."
    );
    expect(responseData(res).characterCount).toBe(responseData(res).reply.length);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.twitter.com/2/tweets/1908123456789012345?tweet.fields=text",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer twitter-token",
        }),
      })
    );
    expect(mockRunPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-123",
        sourceContent: "ETH ETF demand still looks underpriced relative to how sticky these inflows are.",
        sourceType: "TWEET",
        feedback: expect.stringContaining("direct reply"),
      })
    );
    expect(mockRunPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        feedback: expect.stringContaining("highlight that the market is underestimating persistent flows"),
      })
    );
  });

  it("falls back to tweetText when the tweet cannot be fetched", async () => {
    mockRunPipeline.mockResolvedValueOnce({
      ctx: {
        generatedContent: "True, but the re-rate probably comes from positioning catching up, not the first print.",
        confidence: 0.81,
        predictedEngagement: 1500,
        stepResults: [],
      },
      steps: [],
      totalMs: 280,
    });

    const res = await request(app)
      .post("/api/drafts/reply")
      .set("Authorization", AUTH)
      .send({
        tweetUrl: "https://twitter.com/atlas/status/1908123456789012345",
        tweetText: "SOL is getting repriced faster than most people expected.",
      });

    expect(res.status).toBe(200);
    expect(responseData(res).originalTweet).toBe("SOL is getting repriced faster than most people expected.");
    expect(mockRunPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceContent: "SOL is getting repriced faster than most people expected.",
      })
    );
  });

  it("returns 400 for invalid tweet URLs when no fallback text is provided", async () => {
    const res = await request(app)
      .post("/api/drafts/reply")
      .set("Authorization", AUTH)
      .send({
        tweetUrl: "https://example.com/atlas/status/1908123456789012345",
      });

    expect(res.status).toBe(400);
    responseError(res, "Invalid tweet URL");
  });

  it("returns 502 when tweet fetch fails and no fallback text is provided", async () => {
    const res = await request(app)
      .post("/api/drafts/reply")
      .set("Authorization", AUTH)
      .send({
        tweetUrl: "https://x.com/atlas/status/1908123456789012345",
      });

    expect(res.status).toBe(502);
    responseError(res, "Failed to fetch tweet content — provide tweetText as fallback");
  });
});

// --- POST /:id/regenerate ---

describe("POST /api/drafts/:id/regenerate", () => {
  it("returns 404 when original draft not found", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(null);

    const res = await request(app)
      .post("/api/drafts/nonexistent/regenerate")
      .set("Authorization", AUTH)
      .send({});

    expect(res.status).toBe(404);
    responseError(res, "Draft not found");
  });

  it("returns 400 when original draft has no sourceContent", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce({
      ...mockDraft,
      sourceContent: null,
    });

    const res = await request(app)
      .post("/api/drafts/draft-1/regenerate")
      .set("Authorization", AUTH)
      .send({});

    expect(res.status).toBe(400);
    expect(responseError(res).error).toMatch(/Cannot regenerate a manual draft/);
  });

  it("regenerates with new version number", async () => {
    const existingWithSource = { ...mockDraft, sourceContent: "BTC ATH analysis", version: 1 };
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(existingWithSource);
    mockRunPipeline.mockResolvedValueOnce({
      ctx: {
        generatedContent: "New version!",
        confidence: 0.9,
        predictedEngagement: 2200,
        stepResults: [],
      },
      steps: [],
      totalMs: 400,
    });
    (mockPrisma.tweetDraft.create as jest.Mock).mockResolvedValueOnce({
      ...mockDraft,
      content: "New version!",
      version: 2,
    });
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValue({});

    const res = await request(app)
      .post("/api/drafts/draft-1/regenerate")
      .set("Authorization", AUTH)
      .send({});

    expect(res.status).toBe(200);
    expect(responseData(res).draft.version).toBe(2);
  });

  it("logs FEEDBACK_GIVEN when feedback is provided on regenerate", async () => {
    const existingWithSource = { ...mockDraft, sourceContent: "BTC ATH", version: 1 };
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(existingWithSource);
    mockRunPipeline.mockResolvedValueOnce({
      ctx: {
        generatedContent: "Refined tweet",
        confidence: 0.88,
        predictedEngagement: 1800,
        stepResults: [],
      },
      steps: [],
      totalMs: 300,
    });
    (mockPrisma.tweetDraft.create as jest.Mock).mockResolvedValueOnce({ ...mockDraft, version: 2 });
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValue({});

    await request(app)
      .post("/api/drafts/draft-1/regenerate")
      .set("Authorization", AUTH)
      .send({ feedback: "make it shorter" });

    const feedbackCall = (mockPrisma.analyticsEvent.create as jest.Mock).mock.calls.find(
      (call) => call[0].data.type === "FEEDBACK_GIVEN"
    );
    expect(feedbackCall).toBeDefined();
  });

  it("returns 502 when AI generation fails on regenerate", async () => {
    const existingWithSource = { ...mockDraft, sourceContent: "BTC ATH", version: 1 };
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(existingWithSource);
    mockRunPipeline.mockRejectedValueOnce(new Error("API failure"));

    const res = await request(app)
      .post("/api/drafts/draft-1/regenerate")
      .set("Authorization", AUTH)
      .send({});

    expect(res.status).toBe(502);
    responseError(res, "AI generation failed");
  });
});
