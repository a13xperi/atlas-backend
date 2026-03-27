/**
 * Research routes test suite
 * Tests POST /, GET /history
 * Mocks: Prisma, conductResearch, jsonwebtoken
 */

import request from "supertest";
import express from "express";
import { researchRouter } from "../../routes/research";

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

jest.mock("jsonwebtoken", () => ({
  verify: jest.fn().mockReturnValue({ userId: "user-123" }),
}));

import { prisma } from "../../lib/prisma";
import { conductResearch } from "../../lib/research";
const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockConductResearch = conductResearch as jest.Mock;

const app = express();
app.use(express.json());
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
  });
});
