/**
 * Research routes test suite
 * Tests POST /, GET /history
 * Mocks: Prisma, conductResearch, jsonwebtoken
 */

import request from "supertest";
import express from "express";
import { researchRouter } from "../../routes/research";
import { requestIdMiddleware } from "../../middleware/requestId";

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
    researchResult: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
    analyticsEvent: {
      create: jest.fn(),
    },
  },
}));

jest.mock("../../lib/research", () => ({
  conductResearch: jest.fn(),
}));

import { prisma } from "../../lib/prisma";
import { conductResearch } from "../../lib/research";
const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockConductResearch = conductResearch as jest.Mock;

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/research", researchRouter);

const AUTH = { Authorization: "Bearer mock_token" };

const mockResearchResult = {
  summary: "BTC is bullish",
  keyFacts: ["BTC up 10%", "ETH up 5%"],
  sentiment: "bullish" as const,
  relatedTopics: ["DeFi"],
  sources: ["CoinDesk"],
  confidence: 0.85,
};

beforeAll(() => {
  process.env.JWT_SECRET = "test-secret";
});

afterAll(() => {
  delete process.env.JWT_SECRET;
});

describe("POST /api/research", () => {
  it("returns 401 without token", async () => {
    const res = await request(app).post("/api/research").send({ query: "BTC analysis" });
    expect(res.status).toBe(401);
  });

  it("returns 400 for empty query", async () => {
    const res = await request(app).post("/api/research").set(AUTH).send({ query: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  it("returns 400 when query is missing", async () => {
    const res = await request(app).post("/api/research").set(AUTH).send({});
    expect(res.status).toBe(400);
  });

  it("conducts research and saves result", async () => {
    mockConductResearch.mockResolvedValueOnce(mockResearchResult);
    const saved = { id: "res-1", ...mockResearchResult };
    (mockPrisma.researchResult.create as jest.Mock).mockResolvedValueOnce(saved);
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValueOnce({});

    const res = await request(app)
      .post("/api/research")
      .set(AUTH)
      .send({ query: "BTC analysis" });

    expect(res.status).toBe(200);
    expect(res.body.result.summary).toBe("BTC is bullish");
    expect(res.body.result.id).toBe("res-1");
  });

  it("returns 502 when research fails", async () => {
    mockConductResearch.mockRejectedValueOnce(new Error("OpenAI error"));

    const res = await request(app)
      .post("/api/research")
      .set(AUTH)
      .send({ query: "BTC analysis" });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Research failed");
  });
});

describe("GET /api/research/history", () => {
  it("returns 401 without token", async () => {
    const res = await request(app).get("/api/research/history");
    expect(res.status).toBe(401);
  });

  it("returns list of research results", async () => {
    const results = [{ id: "res-1", summary: "test", createdAt: new Date() }];
    (mockPrisma.researchResult.findMany as jest.Mock).mockResolvedValueOnce(results);

    const res = await request(app).get("/api/research/history").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(mockPrisma.researchResult.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-123" },
        orderBy: { createdAt: "desc" },
        take: 20,
        skip: 0,
      })
    );
  });

  it("applies pagination to research history", async () => {
    (mockPrisma.researchResult.findMany as jest.Mock).mockResolvedValueOnce([]);

    await request(app).get("/api/research/history?limit=5&offset=2").set(AUTH);

    expect(mockPrisma.researchResult.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-123" },
        orderBy: { createdAt: "desc" },
        take: 5,
        skip: 2,
      })
    );
  });

  it("returns 500 when loading research history fails", async () => {
    (mockPrisma.researchResult.findMany as jest.Mock).mockRejectedValueOnce(new Error("db down"));

    const res = await request(app).get("/api/research/history").set(AUTH);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to load research history");
    expect(res.body.message).toBe("db down");
  });
});
