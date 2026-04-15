import request from "supertest";
import express from "express";
import { draftsRouter } from "../../routes/drafts";
import { requestIdMiddleware } from "../../middleware/requestId";

jest.mock("../../middleware/auth", () => ({
  authenticate: jest.fn((req: any, res: any, next: any) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing authorization token" });
    }

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
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
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

jest.mock("../../lib/content-extraction", () => ({
  extractInsights: jest.fn(),
}));

jest.mock("../../lib/batch-generate", () => ({
  batchGenerateDrafts: jest.fn(),
}));

import { prisma } from "../../lib/prisma";

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/drafts", draftsRouter);

const AUTH = "Bearer mock_token";
const mockFindMany = prisma.tweetDraft.findMany as jest.Mock;
const mockCount = prisma.tweetDraft.count as jest.Mock;

function makeDraft(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `draft-${index}`,
    userId: "user-123",
    content: `Draft ${index}`,
    version: 1,
    status: "DRAFT",
    confidence: 0.8,
    predictedEngagement: 100 + index,
    actualEngagement: null,
    engagementMetrics: null,
    xTweetId: null,
    metricsLastFetchedAt: null,
    sourceType: "MANUAL",
    sourceContent: null,
    blendId: null,
    feedback: null,
    scheduledAt: null,
    campaignId: null,
    sortOrder: null,
    voiceDimensionsSnapshot: null,
    createdAt: new Date(`2026-04-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`),
    updatedAt: new Date(`2026-04-${String((index % 28) + 1).padStart(2, "0")}T12:05:00.000Z`),
    ...overrides,
  };
}

function encodeCursor(id: string, createdAt: string): string {
  return Buffer.from(JSON.stringify({ id, createdAt }), "utf8").toString("base64");
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFindMany.mockResolvedValue([]);
  mockCount.mockResolvedValue(0);
});

describe("GET /api/drafts/history", () => {
  it("returns the first 50 drafts sorted newest-first by default", async () => {
    const drafts = Array.from({ length: 50 }, (_, index) => makeDraft(index + 1));
    mockFindMany.mockResolvedValueOnce(drafts);
    mockCount.mockResolvedValueOnce(50);

    const res = await request(app)
      .get("/api/drafts/history")
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.drafts).toHaveLength(50);
    expect(res.body.data.hasMore).toBe(false);
    expect(res.body.data.nextCursor).toBeNull();
    expect(res.body.data.total).toBe(50);
    expect(mockFindMany).toHaveBeenCalledWith({
      where: { userId: "user-123" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
    });
    expect(mockCount).toHaveBeenCalledWith({
      where: { userId: "user-123" },
    });
  });

  it("applies a multi-status filter", async () => {
    mockFindMany.mockResolvedValueOnce([makeDraft(1, { status: "POSTED" })]);
    mockCount.mockResolvedValueOnce(1);

    const res = await request(app)
      .get("/api/drafts/history?status=POSTED,SCHEDULED")
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "user-123",
          status: { in: ["POSTED", "SCHEDULED"] },
        },
      }),
    );
  });

  it("applies an inclusive createdAt date range", async () => {
    mockFindMany.mockResolvedValueOnce([]);
    mockCount.mockResolvedValueOnce(0);

    const from = "2026-04-01T00:00:00.000Z";
    const to = "2026-04-10T23:59:59.999Z";

    const res = await request(app)
      .get(`/api/drafts/history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "user-123",
          createdAt: {
            gte: new Date(from),
            lte: new Date(to),
          },
        },
      }),
    );
  });

  it("continues from the cursor for newest sort with a stable tiebreaker", async () => {
    const cursorCreatedAt = "2026-04-10T12:00:00.000Z";
    const nextPage = [
      makeDraft(3, { id: "draft-3", createdAt: new Date("2026-04-09T12:00:00.000Z") }),
      makeDraft(2, { id: "draft-2", createdAt: new Date("2026-04-09T10:00:00.000Z") }),
      makeDraft(1, { id: "draft-1", createdAt: new Date("2026-04-08T12:00:00.000Z") }),
    ];
    mockFindMany.mockResolvedValueOnce(nextPage);
    mockCount.mockResolvedValueOnce(25);

    const cursor = encodeCursor("draft-9", cursorCreatedAt);
    const res = await request(app)
      .get(`/api/drafts/history?limit=2&cursor=${encodeURIComponent(cursor)}&sort=newest`)
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.drafts).toHaveLength(2);
    expect(res.body.data.hasMore).toBe(true);
    expect(res.body.data.nextCursor).toBe(
      encodeCursor("draft-2", "2026-04-09T10:00:00.000Z"),
    );
    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        AND: [
          { userId: "user-123" },
          {
            OR: [
              { createdAt: { lt: new Date(cursorCreatedAt) } },
              { createdAt: new Date(cursorCreatedAt), id: { lt: "draft-9" } },
            ],
          },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 3,
    });
  });

  it("clamps limit to 200", async () => {
    mockFindMany.mockResolvedValueOnce([]);
    mockCount.mockResolvedValueOnce(0);

    const res = await request(app)
      .get("/api/drafts/history?limit=999")
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 201,
      }),
    );
  });

  it("returns 400 for an invalid status filter", async () => {
    const res = await request(app)
      .get("/api/drafts/history?status=FAILED")
      .set("Authorization", AUTH);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockCount).not.toHaveBeenCalled();
  });

  it("returns an empty page with a null cursor when no drafts match", async () => {
    mockFindMany.mockResolvedValueOnce([]);
    mockCount.mockResolvedValueOnce(0);

    const res = await request(app)
      .get("/api/drafts/history?status=POSTED")
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      drafts: [],
      nextCursor: null,
      hasMore: false,
      total: 0,
    });
  });
});
