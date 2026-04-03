/**
 * Briefing routes test suite
 * Tests GET/PUT /preferences
 * Mocks: Prisma, auth middleware
 */

import request from "supertest";
import express from "express";
import briefingRouter from "../../routes/briefing";
import { requestIdMiddleware } from "../../middleware/requestId";
import { expectErrorResponse, expectSuccessResponse } from "../helpers/response";

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
    briefingPreference: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  },
}));

import { prisma } from "../../lib/prisma";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/briefing", briefingRouter);

const AUTH = { Authorization: "Bearer mock_token" };

const mockPreference = {
  id: "pref-1",
  userId: "user-123",
  deliveryTime: "08:00",
  topics: ["BTC", "ETH"],
  sources: ["REPORT", "TWEET"],
  channel: "PORTAL",
  updatedAt: new Date("2026-04-03T08:00:00.000Z"),
};

beforeAll(() => {
  process.env.JWT_SECRET = "test-secret";
});

afterAll(() => {
  delete process.env.JWT_SECRET;
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/briefing/preferences", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/briefing/preferences");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Missing authorization token");
  });

  it("returns null preference when none exists", async () => {
    (mockPrisma.briefingPreference.findUnique as jest.Mock).mockResolvedValueOnce(null);

    const res = await request(app).get("/api/briefing/preferences").set(AUTH);

    expect(res.status).toBe(200);
    expect(expectSuccessResponse<{ preference: null }>(res.body)).toEqual({
      preference: null,
    });
    expect(mockPrisma.briefingPreference.findUnique).toHaveBeenCalledWith({
      where: { userId: "user-123" },
    });
  });

  it("returns existing preference", async () => {
    (mockPrisma.briefingPreference.findUnique as jest.Mock).mockResolvedValueOnce(mockPreference);

    const res = await request(app).get("/api/briefing/preferences").set(AUTH);

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<{ preference: typeof mockPreference }>(res.body);
    expect(data.preference).toEqual({
      ...mockPreference,
      updatedAt: mockPreference.updatedAt.toISOString(),
    });
  });

  it("returns 500 on DB error", async () => {
    (mockPrisma.briefingPreference.findUnique as jest.Mock).mockRejectedValueOnce(new Error("db down"));

    const res = await request(app).get("/api/briefing/preferences").set(AUTH);

    expect(res.status).toBe(500);
    expectErrorResponse(res.body, "Failed to fetch briefing preferences");
  });
});

describe("PUT /api/briefing/preferences", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).put("/api/briefing/preferences").send({
      deliveryTime: "08:00",
      topics: ["BTC"],
      sources: ["REPORT"],
      channel: "PORTAL",
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Missing authorization token");
  });

  it("creates/upserts preference successfully", async () => {
    const payload = {
      deliveryTime: "09:30",
      topics: ["Macro", "DeFi"],
      sources: ["REPORT", "ARTICLE"],
      channel: "TELEGRAM",
    };
    const upserted = {
      ...mockPreference,
      ...payload,
    };
    (mockPrisma.briefingPreference.upsert as jest.Mock).mockResolvedValueOnce(upserted);

    const res = await request(app).put("/api/briefing/preferences").set(AUTH).send(payload);

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<{ preference: typeof upserted }>(res.body);
    expect(data.preference).toEqual({
      ...upserted,
      updatedAt: upserted.updatedAt.toISOString(),
    });
    expect(mockPrisma.briefingPreference.upsert).toHaveBeenCalledWith({
      where: { userId: "user-123" },
      create: {
        userId: "user-123",
        deliveryTime: payload.deliveryTime,
        topics: payload.topics,
        sources: payload.sources,
        channel: payload.channel,
      },
      update: {
        deliveryTime: payload.deliveryTime,
        topics: payload.topics,
        sources: payload.sources,
        channel: payload.channel,
      },
    });
  });

  it("returns 400 for invalid body (missing fields)", async () => {
    const res = await request(app)
      .put("/api/briefing/preferences")
      .set(AUTH)
      .send({ deliveryTime: "08:00", topics: ["BTC"] });

    expect(res.status).toBe(400);
    const body = expectErrorResponse(res.body, "Invalid request");
    expect(Array.isArray(body.details)).toBe(true);
    expect(mockPrisma.briefingPreference.upsert).not.toHaveBeenCalled();
  });

  it("returns 500 on DB error", async () => {
    const payload = {
      deliveryTime: "08:00",
      topics: ["BTC"],
      sources: ["REPORT"],
      channel: "PORTAL",
    };
    (mockPrisma.briefingPreference.upsert as jest.Mock).mockRejectedValueOnce(new Error("db down"));

    const res = await request(app).put("/api/briefing/preferences").set(AUTH).send(payload);

    expect(res.status).toBe(500);
    expectErrorResponse(res.body, "Failed to save briefing preferences");
  });
});
