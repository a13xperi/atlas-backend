/**
 * Trending routes test suite
 * Tests POST /scan, GET /topics
 * Mocks: Prisma, searchTrending (grok), jsonwebtoken
 */

import request from "supertest";
import express from "express";
import { trendingRouter } from "../../routes/trending";

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

jest.mock("jsonwebtoken", () => ({
  verify: jest.fn().mockReturnValue({ userId: "user-123" }),
}));

import { prisma } from "../../lib/prisma";
import { searchTrending } from "../../lib/grok";
const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockSearchTrending = searchTrending as jest.Mock;

const app = express();
app.use(express.json());
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

describe("POST /api/trending/scan", () => {
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
    expect(res.body.alerts).toHaveLength(1);
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
    expect(res.body.error).toBe("Twitter scan failed");
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
    expect(res.body.topics).toHaveLength(1);
    expect(res.body.topics[0].headline).toBe("DeFi TVL hits record high");
  });

  it("returns 500 on DB error", async () => {
    (mockPrisma.alert.findMany as jest.Mock).mockRejectedValueOnce(new Error("DB error"));

    const res = await request(app).get("/api/trending/topics").set(AUTH);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to load trending topics");
  });
});
