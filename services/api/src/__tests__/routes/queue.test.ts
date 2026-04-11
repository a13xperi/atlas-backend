import request from "supertest";
import express from "express";
import { requestIdMiddleware } from "../../middleware/requestId";
import { expectSuccessResponse } from "../helpers/response";

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

jest.mock("../../lib/prisma", () => ({
  prisma: {
    draftQueueItem: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    analyticsEvent: {
      create: jest.fn(),
    },
  },
}));

jest.mock("../../lib/twitter", () => ({
  postTweet: jest.fn(),
  refreshAccessToken: jest.fn(),
}));

import { prisma } from "../../lib/prisma";
import { postTweet, refreshAccessToken } from "../../lib/twitter";
import { queueRouter } from "../../routes/queue";

const mockPrisma = prisma as any;
const mockPostTweet = postTweet as jest.MockedFunction<typeof postTweet>;
const mockRefreshAccessToken = refreshAccessToken as jest.MockedFunction<typeof refreshAccessToken>;

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/queue", queueRouter);

const AUTH = { Authorization: "Bearer mock_token" };
const futureDate = new Date(Date.now() + 60 * 60 * 1000);

const mockQueueItem = {
  id: "queue-1",
  userId: "user-123",
  content: "Queued tweet",
  scheduledAt: null,
  status: "queued",
  platform: "twitter",
  tweetId: null,
  metadata: { tone: "direct" },
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  jest.clearAllMocks();

  (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
    xAccessToken: "access-token",
    xRefreshToken: "refresh-token",
    xAccessTokenEnc: null,
    xRefreshTokenEnc: null,
    xTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  (mockPrisma.user.update as jest.Mock).mockResolvedValue({});
  (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValue({});
  mockRefreshAccessToken.mockResolvedValue({
    accessToken: "refreshed-access-token",
    refreshToken: "refreshed-refresh-token",
    expiresIn: 3600,
  });
  mockPostTweet.mockResolvedValue({ id: "tweet-123", text: "Queued tweet" });
});

describe("GET /api/queue", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/queue");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Missing authorization token");
  });

  it("lists queue items and passes status filter", async () => {
    (mockPrisma.draftQueueItem.findMany as jest.Mock).mockResolvedValueOnce([mockQueueItem]);

    const res = await request(app)
      .get("/api/queue?status=queued")
      .set(AUTH);

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<{ items: typeof mockQueueItem[] }>(res.body);

    expect(data.items).toHaveLength(1);
    expect(mockPrisma.draftQueueItem.findMany).toHaveBeenCalledWith({
      where: {
        userId: "user-123",
        status: "queued",
      },
      orderBy: [{ scheduledAt: "asc" }, { createdAt: "desc" }],
    });
  });
});

describe("GET /api/queue/scheduled", () => {
  it("returns future scheduled items", async () => {
    (mockPrisma.draftQueueItem.findMany as jest.Mock).mockResolvedValueOnce([
      { ...mockQueueItem, status: "scheduled", scheduledAt: futureDate },
    ]);

    const res = await request(app)
      .get("/api/queue/scheduled")
      .set(AUTH);

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);

    expect(data.items[0].status).toBe("scheduled");
    expect(mockPrisma.draftQueueItem.findMany).toHaveBeenCalledWith({
      where: {
        userId: "user-123",
        status: "scheduled",
        scheduledAt: { gt: expect.any(Date) },
      },
      orderBy: { scheduledAt: "asc" },
    });
  });
});

describe("POST /api/queue", () => {
  it("creates a queued item with defaults", async () => {
    (mockPrisma.draftQueueItem.create as jest.Mock).mockResolvedValueOnce(mockQueueItem);

    const res = await request(app)
      .post("/api/queue")
      .set(AUTH)
      .send({ content: "Queued tweet" });

    expect(res.status).toBe(201);
    const data = expectSuccessResponse<{ item: typeof mockQueueItem }>(res.body);

    expect(data.item.status).toBe("queued");
    expect(mockPrisma.draftQueueItem.create).toHaveBeenCalledWith({
      data: {
        userId: "user-123",
        content: "Queued tweet",
        scheduledAt: undefined,
        status: "queued",
        platform: "twitter",
      },
    });
    expect(mockPrisma.analyticsEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "DRAFT_CREATED",
          metadata: expect.objectContaining({
            source: "draft_queue",
            queueItemId: "queue-1",
            scheduled: false,
          }),
        }),
      }),
    );
  });

  it("creates a scheduled item when scheduledAt is in the future", async () => {
    (mockPrisma.draftQueueItem.create as jest.Mock).mockResolvedValueOnce({
      ...mockQueueItem,
      status: "scheduled",
      scheduledAt: futureDate,
    });

    const res = await request(app)
      .post("/api/queue")
      .set(AUTH)
      .send({ content: "Scheduled tweet", scheduledAt: futureDate.toISOString() });

    expect(res.status).toBe(201);
    expect(mockPrisma.draftQueueItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "scheduled",
        scheduledAt: expect.any(Date),
      }),
    });
  });
});

describe("PATCH /api/queue/:id", () => {
  it("updates content and reschedules the queue item", async () => {
    (mockPrisma.draftQueueItem.findFirst as jest.Mock).mockResolvedValueOnce(mockQueueItem);
    (mockPrisma.draftQueueItem.update as jest.Mock).mockResolvedValueOnce({
      ...mockQueueItem,
      content: "Updated queued tweet",
      status: "scheduled",
      scheduledAt: futureDate,
    });

    const res = await request(app)
      .patch("/api/queue/queue-1")
      .set(AUTH)
      .send({ content: "Updated queued tweet", scheduledAt: futureDate.toISOString() });

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);

    expect(data.item.content).toBe("Updated queued tweet");
    expect(mockPrisma.draftQueueItem.update).toHaveBeenCalledWith({
      where: { id: "queue-1" },
      data: {
        content: "Updated queued tweet",
        scheduledAt: expect.any(Date),
        status: "scheduled",
      },
    });
  });
});

describe("DELETE /api/queue/:id", () => {
  it("deletes the queue item", async () => {
    (mockPrisma.draftQueueItem.findFirst as jest.Mock).mockResolvedValueOnce(mockQueueItem);
    (mockPrisma.draftQueueItem.delete as jest.Mock).mockResolvedValueOnce(mockQueueItem);

    const res = await request(app)
      .delete("/api/queue/queue-1")
      .set(AUTH);

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<{ deleted: boolean }>(res.body);

    expect(data.deleted).toBe(true);
    expect(mockPrisma.draftQueueItem.delete).toHaveBeenCalledWith({
      where: { id: "queue-1" },
    });
  });
});

describe("POST /api/queue/:id/publish", () => {
  it("publishes immediately to X and stores the tweet id", async () => {
    (mockPrisma.draftQueueItem.findFirst as jest.Mock).mockResolvedValueOnce(mockQueueItem);
    (mockPrisma.draftQueueItem.update as jest.Mock).mockResolvedValueOnce({
      ...mockQueueItem,
      status: "published",
      tweetId: "tweet-123",
    });

    const res = await request(app)
      .post("/api/queue/queue-1/publish")
      .set(AUTH);

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);

    expect(data.item.status).toBe("published");
    expect(data.tweet.id).toBe("tweet-123");
    expect(mockPostTweet).toHaveBeenCalledWith("access-token", "Queued tweet");
    expect(mockPrisma.draftQueueItem.update).toHaveBeenCalledWith({
      where: { id: "queue-1" },
      data: {
        status: "published",
        tweetId: "tweet-123",
        scheduledAt: null,
      },
    });
    expect(mockPrisma.analyticsEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "DRAFT_POSTED",
          metadata: expect.objectContaining({
            source: "draft_queue",
            queueItemId: "queue-1",
            tweetId: "tweet-123",
          }),
        }),
      }),
    );
  });

  it("returns 400 when X account is not linked", async () => {
    (mockPrisma.draftQueueItem.findFirst as jest.Mock).mockResolvedValueOnce(mockQueueItem);
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
      xAccessToken: null,
      xRefreshToken: null,
      xAccessTokenEnc: null,
      xRefreshTokenEnc: null,
      xTokenExpiresAt: null,
    });

    const res = await request(app)
      .post("/api/queue/queue-1/publish")
      .set(AUTH);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("X account not linked. Connect your X account first.");
    expect(mockPostTweet).not.toHaveBeenCalled();
  });
});
