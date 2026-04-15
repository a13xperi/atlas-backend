/**
 * Draft refine route test suite
 * Tests: POST /:id/refine
 * Mocks: Prisma, pipeline (runGenerationPipeline), timeout (withTimeout), JWT
 */

import request from "supertest";
import express from "express";
import { draftsRouter } from "../../routes/drafts";
import { requestIdMiddleware } from "../../middleware/requestId";

// --- Mocks ---

jest.mock("../../middleware/auth", () => ({
  authenticate: jest.fn((req: any, _res: any, next: any) => {
    req.userId = "user-1";
    next();
  }),
  AuthRequest: {},
}));

jest.mock("../../lib/prisma", () => ({
  prisma: {
    tweetDraft: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    analyticsEvent: {
      create: jest.fn(),
    },
  },
}));

jest.mock("../../lib/redis", () => ({
  getRedis: jest.fn(() => null),
  getCached: jest.fn(),
  setCache: jest.fn(),
}));

jest.mock("../../lib/pipeline", () => ({
  runGenerationPipeline: jest.fn(),
}));

jest.mock("../../lib/timeout", () => {
  class TimeoutError extends Error {
    constructor(label: string, _ms: number) {
      super(`${label} timed out`);
      this.name = "TimeoutError";
    }
  }
  return { withTimeout: jest.fn((p) => p), TimeoutError };
});

import { prisma } from "../../lib/prisma";
import { runGenerationPipeline } from "../../lib/pipeline";
import { withTimeout, TimeoutError } from "../../lib/timeout";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockRunPipeline = runGenerationPipeline as jest.Mock;
const mockWithTimeout = withTimeout as jest.Mock;

// --- App setup ---

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/drafts", draftsRouter);

const AUTH = "Bearer test-token";

const existingDraft = {
  id: "draft-1",
  userId: "user-1",
  content: "original",
  version: 1,
  blendId: null,
  sourceType: "MANUAL",
  sourceContent: "source",
};

describe("POST /api/drafts/:id/refine", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 404 when draft not found", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post("/api/drafts/draft-1/refine")
      .set("Authorization", AUTH)
      .send({ instruction: "make it punchier" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Draft not found");
    expect(mockPrisma.tweetDraft.findFirst).toHaveBeenCalledWith({
      where: { id: "draft-1", userId: "user-1" },
    });
  });

  it("returns 400 when instruction missing", async () => {
    const res = await request(app)
      .post("/api/drafts/draft-1/refine")
      .set("Authorization", AUTH)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  it("returns 200 with new draft when pipeline succeeds", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValue(existingDraft as any);
    mockRunPipeline.mockResolvedValue({
      ctx: {
        generatedContent: "refined tweet",
        confidence: 0.9,
        predictedEngagement: 0.8,
        finalVoiceDimensions: null,
        blendWarning: null,
      },
    });

    const createdDraft = {
      id: "draft-2",
      userId: "user-1",
      content: "refined tweet",
      sourceType: "MANUAL",
      sourceContent: "source",
      blendId: null,
      confidence: 0.9,
      predictedEngagement: 0.8,
      voiceDimensionsSnapshot: undefined,
      version: 2,
      feedback: "make it punchier",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    (mockPrisma.tweetDraft.create as jest.Mock).mockResolvedValue(createdDraft as any);
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValue({ id: "evt-1" } as any);

    const res = await request(app)
      .post("/api/drafts/draft-1/refine")
      .set("Authorization", AUTH)
      .send({ instruction: "make it punchier" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.draft).toEqual(createdDraft);

    expect(mockPrisma.tweetDraft.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        content: "refined tweet",
        sourceType: "MANUAL",
        sourceContent: "source",
        blendId: null,
        confidence: 0.9,
        predictedEngagement: 0.8,
        voiceDimensionsSnapshot: undefined,
        version: 2,
        feedback: "make it punchier",
      },
    });

    expect(mockPrisma.analyticsEvent.create).toHaveBeenCalledTimes(2);
    expect(mockPrisma.analyticsEvent.create).toHaveBeenNthCalledWith(1, {
      data: { userId: "user-1", type: "DRAFT_CREATED" },
    });
    expect(mockPrisma.analyticsEvent.create).toHaveBeenNthCalledWith(2, {
      data: { userId: "user-1", type: "FEEDBACK_GIVEN" },
    });
  });

  it("returns 504 when withTimeout throws TimeoutError", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValue(existingDraft as any);
    mockWithTimeout.mockRejectedValue(new TimeoutError("refine-pipeline", 90000));

    const res = await request(app)
      .post("/api/drafts/draft-1/refine")
      .set("Authorization", AUTH)
      .send({ instruction: "make it punchier" });

    expect(res.status).toBe(504);
    expect(res.body.error).toBe("Refinement timed out — please try again");
  });

  it("returns 502 on general pipeline error", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValue(existingDraft as any);
    mockWithTimeout.mockRejectedValue(new Error("pipeline exploded"));

    const res = await request(app)
      .post("/api/drafts/draft-1/refine")
      .set("Authorization", AUTH)
      .send({ instruction: "make it punchier" });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("AI refinement failed");
  });
});
