/**
 * Draft refine route tests
 * Tests: POST /api/drafts/:id/refine
 */

import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { draftsRouter } from "../routes/drafts";
import { requestIdMiddleware } from "../middleware/requestId";

jest.mock("../lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    tweetDraft: { findFirst: jest.fn(), create: jest.fn() },
    analyticsEvent: { create: jest.fn() },
  },
}));
jest.mock("../lib/config", () => ({
  config: { JWT_SECRET: "test-secret", NODE_ENV: "test" },
}));
jest.mock("../lib/pipeline", () => ({
  runGenerationPipeline: jest.fn().mockResolvedValue({
    ctx: {
      generatedContent: "refined",
      confidence: 0.9,
      predictedEngagement: 0.8,
      finalVoiceDimensions: null,
    },
  }),
}));
jest.mock("../lib/timeout", () => ({ withTimeout: jest.fn((fn) => fn) }));

import { prisma } from "../lib/prisma";
import { runGenerationPipeline } from "../lib/pipeline";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockRunPipeline = runGenerationPipeline as jest.Mock;

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/drafts", draftsRouter);

function makeToken(userId: string) {
  return jwt.sign({ userId }, "test-secret");
}

describe("POST /api/drafts/:id/refine", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 without auth token", async () => {
    const res = await request(app)
      .post("/api/drafts/draft-1/refine")
      .send({ instruction: "make it shorter" });

    expect(res.status).toBe(401);
  });

  it("returns 404 when draft not found", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(null);

    const token = makeToken("user-1");
    const res = await request(app)
      .post("/api/drafts/draft-1/refine")
      .set("Authorization", `Bearer ${token}`)
      .send({ instruction: "make it shorter" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Draft not found");
  });

  it("returns 200 and creates refined draft", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce({
      id: "draft-1",
      userId: "user-1",
      content: "Original content",
      sourceType: "MANUAL",
      sourceContent: null,
      blendId: null,
      version: 1,
    });
    (mockPrisma.tweetDraft.create as jest.Mock).mockResolvedValueOnce({
      id: "draft-2",
      userId: "user-1",
      content: "refined",
    });
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValue({});

    const token = makeToken("user-1");
    const res = await request(app)
      .post("/api/drafts/draft-1/refine")
      .set("Authorization", `Bearer ${token}`)
      .send({ instruction: "make it shorter" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.draft.content).toBe("refined");
    expect(mockRunPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        sourceContent: expect.stringContaining("Original content"),
        feedback: "make it shorter",
      })
    );
  });
});
