/**
 * NLP Monitors routes test suite.
 * Tests GET / POST / PATCH / DELETE for monitors CRUD and the
 * matchMonitorKeywords utility function.
 */

import request from "supertest";
import express from "express";
import { monitorsRouter, matchMonitorKeywords } from "../../routes/monitors";
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
    nlpMonitor: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  },
}));

jest.mock("../../lib/logger", () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { prisma } from "../../lib/prisma";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/monitors", monitorsRouter);

const AUTH = { Authorization: "Bearer mock_token" };

describe("GET /api/monitors", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/monitors");
    expect(res.status).toBe(401);
  });

  it("returns the user's monitors", async () => {
    const monitors = [
      { id: "m1", name: "BTC Tracker", keywords: ["bitcoin", "btc"], userId: "user-123" },
    ];
    (mockPrisma.nlpMonitor.findMany as jest.Mock).mockResolvedValueOnce(monitors);

    const res = await request(app).get("/api/monitors").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.monitors).toEqual(monitors);
    expect(mockPrisma.nlpMonitor.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-123" } }),
    );
  });

  it("returns 500 on database error", async () => {
    (mockPrisma.nlpMonitor.findMany as jest.Mock).mockRejectedValueOnce(new Error("db down"));
    const res = await request(app).get("/api/monitors").set(AUTH);
    expect(res.status).toBe(500);
  });
});

describe("POST /api/monitors", () => {
  beforeEach(() => jest.clearAllMocks());

  it("creates a monitor with defaults", async () => {
    const created = {
      id: "m-new",
      name: "ETH Watcher",
      keywords: ["ethereum"],
      minRelevance: 0.5,
      delivery: ["PORTAL"],
      userId: "user-123",
    };
    (mockPrisma.nlpMonitor.create as jest.Mock).mockResolvedValueOnce(created);

    const res = await request(app)
      .post("/api/monitors")
      .set(AUTH)
      .send({ name: "ETH Watcher", keywords: ["ethereum"] });

    expect(res.status).toBe(201);
    expect(res.body.monitor.name).toBe("ETH Watcher");
    expect(mockPrisma.nlpMonitor.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-123",
        name: "ETH Watcher",
        keywords: ["ethereum"],
        minRelevance: 0.5,
        delivery: ["PORTAL"],
      }),
    });
  });

  it("creates with custom minRelevance and TELEGRAM delivery", async () => {
    const created = {
      id: "m-tg",
      name: "DeFi Monitor",
      keywords: ["defi", "yield"],
      minRelevance: 0.8,
      delivery: ["PORTAL", "TELEGRAM"],
      userId: "user-123",
    };
    (mockPrisma.nlpMonitor.create as jest.Mock).mockResolvedValueOnce(created);

    const res = await request(app).post("/api/monitors").set(AUTH).send({
      name: "DeFi Monitor",
      keywords: ["defi", "yield"],
      minRelevance: 0.8,
      delivery: ["PORTAL", "TELEGRAM"],
    });

    expect(res.status).toBe(201);
    expect(res.body.monitor.delivery).toEqual(["PORTAL", "TELEGRAM"]);
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(app)
      .post("/api/monitors")
      .set(AUTH)
      .send({ keywords: ["btc"] });
    expect(res.status).toBe(400);
  });

  it("returns 400 when keywords is empty", async () => {
    const res = await request(app)
      .post("/api/monitors")
      .set(AUTH)
      .send({ name: "Empty", keywords: [] });
    expect(res.status).toBe(400);
  });

  it("returns 400 when keywords exceeds 20", async () => {
    const keywords = Array.from({ length: 21 }, (_, i) => `kw${i}`);
    const res = await request(app)
      .post("/api/monitors")
      .set(AUTH)
      .send({ name: "Too many", keywords });
    expect(res.status).toBe(400);
  });

  it("returns 400 when minRelevance is out of range", async () => {
    const res = await request(app)
      .post("/api/monitors")
      .set(AUTH)
      .send({ name: "Bad range", keywords: ["btc"], minRelevance: 1.5 });
    expect(res.status).toBe(400);
  });

  it("returns 409 on duplicate name (P2002)", async () => {
    const uniqueError = new Error("Unique constraint failed") as any;
    uniqueError.code = "P2002";
    (mockPrisma.nlpMonitor.create as jest.Mock).mockRejectedValueOnce(uniqueError);

    const res = await request(app)
      .post("/api/monitors")
      .set(AUTH)
      .send({ name: "Dupe", keywords: ["btc"] });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });
});

describe("PATCH /api/monitors/:id", () => {
  beforeEach(() => jest.clearAllMocks());

  it("updates a monitor", async () => {
    const updated = { id: "m1", name: "Updated", keywords: ["eth"], userId: "user-123" };
    (mockPrisma.nlpMonitor.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });
    (mockPrisma.nlpMonitor.findUnique as jest.Mock).mockResolvedValueOnce(updated);

    const res = await request(app)
      .patch("/api/monitors/m1")
      .set(AUTH)
      .send({ name: "Updated" });

    expect(res.status).toBe(200);
    expect(res.body.monitor.name).toBe("Updated");
    expect(mockPrisma.nlpMonitor.updateMany).toHaveBeenCalledWith({
      where: { id: "m1", userId: "user-123" },
      data: { name: "Updated" },
    });
  });

  it("returns 404 when monitor doesn't exist or belongs to another user", async () => {
    (mockPrisma.nlpMonitor.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 });

    const res = await request(app)
      .patch("/api/monitors/nonexistent")
      .set(AUTH)
      .send({ name: "Whatever" });
    expect(res.status).toBe(404);
  });

  it("returns 400 on invalid body", async () => {
    const res = await request(app)
      .patch("/api/monitors/m1")
      .set(AUTH)
      .send({ minRelevance: 5 });
    expect(res.status).toBe(400);
  });

  it("can toggle isActive to false", async () => {
    (mockPrisma.nlpMonitor.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });
    (mockPrisma.nlpMonitor.findUnique as jest.Mock).mockResolvedValueOnce({
      id: "m1",
      isActive: false,
    });

    const res = await request(app)
      .patch("/api/monitors/m1")
      .set(AUTH)
      .send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.monitor.isActive).toBe(false);
  });
});

describe("DELETE /api/monitors/:id", () => {
  beforeEach(() => jest.clearAllMocks());

  it("deletes a monitor owned by the user", async () => {
    (mockPrisma.nlpMonitor.deleteMany as jest.Mock).mockResolvedValueOnce({ count: 1 });

    const res = await request(app).delete("/api/monitors/m1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockPrisma.nlpMonitor.deleteMany).toHaveBeenCalledWith({
      where: { id: "m1", userId: "user-123" },
    });
  });

  it("returns 404 when monitor doesn't exist", async () => {
    (mockPrisma.nlpMonitor.deleteMany as jest.Mock).mockResolvedValueOnce({ count: 0 });
    const res = await request(app).delete("/api/monitors/gone").set(AUTH);
    expect(res.status).toBe(404);
  });
});

describe("matchMonitorKeywords", () => {
  it("matches keywords case-insensitively", () => {
    const result = matchMonitorKeywords("Bitcoin is pumping today", ["bitcoin", "ethereum"]);
    expect(result.matched).toBe(true);
    expect(result.matchedKeywords).toEqual(["bitcoin"]);
    expect(result.score).toBeCloseTo(0.5);
  });

  it("matches multiple keywords", () => {
    const result = matchMonitorKeywords("Bitcoin and Ethereum are pumping", [
      "bitcoin",
      "ethereum",
    ]);
    expect(result.matched).toBe(true);
    expect(result.matchedKeywords).toEqual(["bitcoin", "ethereum"]);
    expect(result.score).toBe(1);
  });

  it("returns false when no keywords match", () => {
    const result = matchMonitorKeywords("Stocks are down", ["bitcoin", "crypto"]);
    expect(result.matched).toBe(false);
    expect(result.matchedKeywords).toEqual([]);
    expect(result.score).toBe(0);
  });

  it("handles empty text", () => {
    const result = matchMonitorKeywords("", ["bitcoin"]);
    expect(result.matched).toBe(false);
    expect(result.score).toBe(0);
  });
});
