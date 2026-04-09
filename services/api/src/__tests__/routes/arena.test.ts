import request from "supertest";
import express from "express";
import { arenaRouter } from "../../routes/arena";
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

jest.mock("../../lib/prisma", () => ({
  prisma: {
    user: {
      findMany: jest.fn(),
    },
    analyticsEvent: {
      findMany: jest.fn(),
    },
    tweetDraft: {
      findMany: jest.fn(),
    },
  },
}));

import { prisma } from "../../lib/prisma";
const mockPrisma = prisma as jest.Mocked<typeof prisma>;

const app = express();
app.set("query parser", "extended"); // use qs so array notation parses as arrays
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/arena", arenaRouter);

const AUTH = { Authorization: "Bearer mock_token" };

describe("GET /api/arena/leaderboard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/arena/leaderboard");
    expect(res.status).toBe(401);
  });

  it("returns ranked leaderboard entries and the requesting user's rank", async () => {
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValueOnce([
      { id: "user-123", handle: "alice", displayName: "Alice", avatarUrl: null },
      { id: "user-999", handle: "bruno", displayName: "Bruno", avatarUrl: null },
    ]);
    (mockPrisma.analyticsEvent.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: "evt-1",
        userId: "user-123",
        createdAt: new Date("2026-04-09T09:00:00Z"),
        metadata: { draftId: "draft-1" },
      },
      {
        id: "evt-2",
        userId: "user-999",
        createdAt: new Date("2026-04-08T09:00:00Z"),
        metadata: { draftId: "draft-2" },
      },
    ]);
    (mockPrisma.tweetDraft.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: "draft-1",
        userId: "user-123",
        predictedEngagement: 10,
        engagementMetrics: { likes: 12, retweets: 3, replies: 2 },
      },
      {
        id: "draft-2",
        userId: "user-999",
        predictedEngagement: 44,
        engagementMetrics: null,
      },
    ]);

    const res = await request(app).get("/api/arena/leaderboard").set(AUTH);
    expect(res.status).toBe(200);

    const data = expectSuccessResponse<any>(res.body);
    expect(data.period).toBe("last_30_days");
    expect(data.entries).toHaveLength(2);
    expect(data.entries[0]).toMatchObject({
      rank: 1,
      userId: "user-999",
      totalEngagement: 44,
    });
    expect(data.entries[1]).toMatchObject({
      rank: 2,
      userId: "user-123",
      totalEngagement: 17,
    });
    expect(data.userRank).toMatchObject({
      userId: "user-123",
      rank: 2,
    });
  });

  it("returns an empty leaderboard when there are no scoped users", async () => {
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValueOnce([]);

    const res = await request(app).get("/api/arena/leaderboard").set(AUTH);
    expect(res.status).toBe(200);

    const data = expectSuccessResponse<any>(res.body);
    expect(data.entries).toEqual([]);
    expect(data.userRank).toBeNull();
  });

  it("returns 400 for an invalid query payload", async () => {
    const res = await request(app)
      .get("/api/arena/leaderboard")
      .set(AUTH)
      .query({ period: "invalid_period_value" });

    expect(res.status).toBe(400);
    expectErrorResponse(res.body, "Invalid request");
  });
});
