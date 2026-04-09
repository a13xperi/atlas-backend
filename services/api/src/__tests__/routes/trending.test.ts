/**
 * Trending routes test suite
 * Tests POST /scan, GET /topics
 * Mocks: Prisma, searchTrending (grok), jsonwebtoken
 */

import request from "supertest";
import express from "express";
import { trendingRouter } from "../../routes/trending";
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
    alertSubscription: {
      findMany: jest.fn(),
    },
    alert: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
    analyticsEvent: {
      create: jest.fn(),
    },
  },
}));

jest.mock("../../lib/grok", () => ({
  searchTrending: jest.fn(),
}));

jest.mock("../../lib/alertDelivery", () => ({
  dispatchAlert: jest.fn(),
}));

import { prisma } from "../../lib/prisma";
import { searchTrending } from "../../lib/grok";
import { dispatchAlert } from "../../lib/alertDelivery";
const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockSearchTrending = searchTrending as jest.Mock;
const mockDispatchAlert = dispatchAlert as jest.Mock;

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/trending", trendingRouter);

const AUTH = { Authorization: "Bearer mock_token" };

const mockTrendingItem = {
  topic: "DeFi",
  headline: "DeFi TVL hits record high",
  context: "Total Value Locked...",
  tweetUrl: "https://x.com/example",
  sentiment: "bullish",
  relevanceScore: 0.9,
};

const mockAlert = {
  id: "alert-1",
  type: "DeFi",
  title: "DeFi TVL hits record high",
  context: "Total Value Locked...",
  sourceUrl: "https://x.com/example",
  sentiment: "bullish",
  relevance: 0.9,
  userId: "user-123",
};

beforeAll(() => {
  process.env.JWT_SECRET = "test-secret";
});

afterAll(() => {
  delete process.env.JWT_SECRET;
});

describe("POST /api/trending/scan", () => {
  beforeEach(() => {
    mockDispatchAlert.mockResolvedValue(undefined);
  });

  it("returns 401 without token", async () => {
    const res = await request(app).post("/api/trending/scan");
    expect(res.status).toBe(401);
  });

  it("scans using subscriptions and returns alerts", async () => {
    (mockPrisma.alertSubscription.findMany as jest.Mock).mockResolvedValueOnce([
      { value: "DeFi" },
    ]);
    mockSearchTrending.mockResolvedValueOnce([mockTrendingItem]);
    (mockPrisma.alert.create as jest.Mock).mockResolvedValueOnce(mockAlert);
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValueOnce({});

    const res = await request(app).post("/api/trending/scan").set(AUTH);
    expect(res.status).toBe(200);
    expect(expectSuccessResponse<any>(res.body).alerts).toHaveLength(1);
    expect(mockDispatchAlert).toHaveBeenCalledWith({
      id: "alert-1",
      title: "DeFi TVL hits record high",
      type: "DeFi",
      context: "Total Value Locked...",
      sourceUrl: "https://x.com/example",
      sentiment: "bullish",
      userId: "user-123",
    });
  });

  it("uses default topics when user has no subscriptions", async () => {
    (mockPrisma.alertSubscription.findMany as jest.Mock).mockResolvedValueOnce([]);
    mockSearchTrending.mockResolvedValueOnce([]);
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValueOnce({});

    await request(app).post("/api/trending/scan").set(AUTH);

    expect(mockSearchTrending).toHaveBeenCalledWith(
      expect.objectContaining({ topics: ["DeFi", "ETH", "Bitcoin", "AI", "Crypto"] })
    );
  });

  it("returns 502 when Grok scan fails", async () => {
    (mockPrisma.alertSubscription.findMany as jest.Mock).mockResolvedValueOnce([]);
    mockSearchTrending.mockRejectedValueOnce(new Error("Grok error"));

    const res = await request(app).post("/api/trending/scan").set(AUTH);
    expect(res.status).toBe(502);
    expectErrorResponse(res.body, "Twitter scan failed");
  });
});

describe("GET /api/trending/topics", () => {
  it("returns 401 without token", async () => {
    const res = await request(app).get("/api/trending/topics");
    expect(res.status).toBe(401);
  });

  it("returns mapped trending topics", async () => {
    (mockPrisma.alert.findMany as jest.Mock).mockResolvedValueOnce([mockAlert]);

    const res = await request(app).get("/api/trending/topics").set(AUTH);
    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);
    expect(data.topics).toHaveLength(1);
    expect(data.topics[0].headline).toBe("DeFi TVL hits record high");
  });

  it("returns 500 on DB error", async () => {
    (mockPrisma.alert.findMany as jest.Mock).mockRejectedValueOnce(new Error("DB error"));

    const res = await request(app).get("/api/trending/topics").set(AUTH);
    expect(res.status).toBe(500);
    expectErrorResponse(res.body, "Failed to load trending topics");
  });
});
