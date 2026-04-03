import request from "supertest";
import express from "express";
import { authenticate } from "../../middleware/auth";
import { draftsRouter } from "../../routes/drafts";
import { requestIdMiddleware } from "../../middleware/requestId";

jest.mock("../../middleware/auth", () => ({
  authenticate: jest.fn((req: any, _res: any, next: any) => {
    req.userId = "user-123";
    next();
  }),
  AuthRequest: {},
}));

jest.mock("../../lib/prisma", () => ({
  prisma: {
    tweetDraft: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    analyticsEvent: { create: jest.fn() },
  },
}));

jest.mock("../../lib/pipeline", () => ({
  runGenerationPipeline: jest.fn(),
}));

jest.mock("../../lib/logger", () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

jest.mock("../../lib/timeout", () => ({
  withTimeout: jest.fn((fn: any) => fn()),
  TimeoutError: class TimeoutError extends Error {},
}));

const { prisma } = require("../../lib/prisma");

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/drafts", draftsRouter);

describe("POST /api/drafts/:id/thread", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns 404 when draft not found", async () => {
    prisma.tweetDraft.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post("/api/drafts/draft-1/thread")
      .set("Authorization", "Bearer test-token");
    expect(res.status).toBe(404);
  });

  it("returns 404 when draft belongs to another user", async () => {
    prisma.tweetDraft.findUnique.mockResolvedValue({ id: "draft-1", userId: "other-user", content: "hello" });
    const res = await request(app)
      .post("/api/drafts/draft-1/thread")
      .set("Authorization", "Bearer test-token");
    expect(res.status).toBe(404);
  });

  it("returns single-tweet thread for short content", async () => {
    prisma.tweetDraft.findUnique.mockResolvedValue({ id: "draft-1", userId: "user-123", content: "Short tweet." });
    const res = await request(app)
      .post("/api/drafts/draft-1/thread")
      .set("Authorization", "Bearer test-token");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.thread[0]).toBe("1/1 Short tweet.");
  });

  it("splits long content into numbered tweets", async () => {
    const long = "This is the first sentence about crypto markets. This is the second sentence about DeFi protocols. This is the third sentence about NFT marketplaces. This is the fourth sentence about layer two scaling. This is the fifth sentence about governance tokens. This is the sixth sentence about yield farming strategies. This is the seventh about staking.";
    prisma.tweetDraft.findUnique.mockResolvedValue({ id: "draft-1", userId: "user-123", content: long });
    const res = await request(app)
      .post("/api/drafts/draft-1/thread")
      .set("Authorization", "Bearer test-token");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBeGreaterThan(1);
    expect(res.body.data.thread[0]).toMatch(/^1\//);
    for (const tweet of res.body.data.thread) {
      expect(tweet.length).toBeLessThanOrEqual(280);
    }
  });
});
