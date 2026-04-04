/**
 * Analytics routes test suite
 * Tests GET /summary, /learning-log, /engagement, /team
 * Mocks: Prisma, jsonwebtoken
 */

import request from "supertest";
import express from "express";
import { analyticsRouter } from "../../routes/analytics";
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
    analyticsEvent: {
      count: jest.fn(),
      findMany: jest.fn(),
    },
    learningLogEntry: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
  },
}));

import { prisma } from "../../lib/prisma";
const mockPrisma = prisma as jest.Mocked<typeof prisma>;

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/analytics", analyticsRouter);

const AUTH = { Authorization: "Bearer mock_token" };

beforeAll(() => {
  process.env.JWT_SECRET = "test-secret";
});

afterAll(() => {
  delete process.env.JWT_SECRET;
});

describe("GET /api/analytics/summary", () => {
  it("returns 401 without token", async () => {
    const res = await request(app).get("/api/analytics/summary");
    expect(res.status).toBe(401);
  });

  it("returns analytics summary with all counts", async () => {
    (mockPrisma.analyticsEvent.count as jest.Mock)
      .mockResolvedValueOnce(10) // draftsCreated
      .mockResolvedValueOnce(5)  // draftsPosted
      .mockResolvedValueOnce(3)  // feedbackGiven
      .mockResolvedValueOnce(2)  // refinements
      .mockResolvedValueOnce(1); // reportsIngested

    const res = await request(app).get("/api/analytics/summary").set(AUTH);
    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);
    expect(data.summary.draftsCreated).toBe(10);
    expect(data.summary.draftsPosted).toBe(5);
    expect(data.summary.feedbackGiven).toBe(3);
    expect(data.summary.period).toBe("30d");
  });
});

describe("POST /api/analytics/learning-log", () => {
  it("returns 400 for an invalid learning log payload", async () => {
    const res = await request(app)
      .post("/api/analytics/learning-log")
      .set(AUTH)
      .send({ event: "", impact: "Helpful" });

    expect(res.status).toBe(400);
    const body = expectErrorResponse(res.body, "Invalid request");
    expect(Array.isArray(body.details)).toBe(true);
  });
});

describe("GET /api/analytics/learning-log", () => {
  it("returns list of learning log entries", async () => {
    const entries = [{ id: "e-1", insight: "test insight", createdAt: new Date() }];
    (mockPrisma.learningLogEntry.findMany as jest.Mock).mockResolvedValueOnce(entries);

    const res = await request(app).get("/api/analytics/learning-log").set(AUTH);
    expect(res.status).toBe(200);
    expect(expectSuccessResponse<any>(res.body).entries).toHaveLength(1);
  });
});

describe("GET /api/analytics/engagement", () => {
  it("returns engagement events", async () => {
    const events = [{ id: "ev-1", type: "ENGAGEMENT_RECORDED", createdAt: new Date() }];
    (mockPrisma.analyticsEvent.findMany as jest.Mock).mockResolvedValueOnce(events);

    const res = await request(app).get("/api/analytics/engagement").set(AUTH);
    expect(res.status).toBe(200);
    expect(expectSuccessResponse<any>(res.body).events).toHaveLength(1);
  });
});

describe("GET /api/analytics/team", () => {
  it("returns 403 for ANALYST role", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ id: "user-123", role: "ANALYST" });
    const res = await request(app).get("/api/analytics/team").set(AUTH);
    expect(res.status).toBe(403);
    expectErrorResponse(res.body, "Manager access required");
  });

  it("returns team data for MANAGER role", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ id: "user-123", role: "MANAGER" });
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValueOnce([
      { id: "a-1", handle: "analyst1", role: "ANALYST", voiceProfile: null, _count: { tweetDrafts: 5 } },
    ]);

    const res = await request(app).get("/api/analytics/team").set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(expectSuccessResponse<any>(res.body).analysts)).toBe(true);
  });

  it("returns 403 when user not found in DB", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(null);
    const res = await request(app).get("/api/analytics/team").set(AUTH);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/analytics/days-to-peak", () => {
  it("returns 401 without token", async () => {
    const res = await request(app).get("/api/analytics/days-to-peak");
    expect(res.status).toBe(401);
  });

  it("returns 403 for ANALYST role", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ id: "user-123", role: "ANALYST" });
    const res = await request(app).get("/api/analytics/days-to-peak").set(AUTH);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Manager access required");
  });

  it("returns 403 when user not found", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(null);
    const res = await request(app).get("/api/analytics/days-to-peak").set(AUTH);
    expect(res.status).toBe(403);
  });

  it("returns peaks for analysts with drafts", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ id: "user-123", role: "MANAGER" });
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: "a-1",
        displayName: "Alice",
        handle: "alice",
        tweetDrafts: [
          { createdAt: new Date("2026-01-01"), actualEngagement: 10 },
          { createdAt: new Date("2026-01-15"), actualEngagement: 50 },
          { createdAt: new Date("2026-01-20"), actualEngagement: 30 },
        ],
      },
    ]);

    const res = await request(app).get("/api/analytics/days-to-peak").set(AUTH);
    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);
    expect(data.peaks).toHaveLength(1);
    expect(data.peaks[0]).toEqual({
      name: "Alice",
      days: 14,
      hasDrafts: true,
    });
  });

  it("returns days=0, hasDrafts=false for analysts with no drafts", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ id: "user-123", role: "MANAGER" });
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValueOnce([
      { id: "a-1", displayName: null, handle: "bob", tweetDrafts: [] },
    ]);

    const res = await request(app).get("/api/analytics/days-to-peak").set(AUTH);
    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);
    expect(data.peaks[0]).toEqual({
      name: "bob",
      days: 0,
      hasDrafts: false,
    });
  });

  it("returns empty array when no analysts exist", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ id: "user-123", role: "MANAGER" });
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValueOnce([]);

    const res = await request(app).get("/api/analytics/days-to-peak").set(AUTH);
    expect(res.status).toBe(200);
    expect(expectSuccessResponse<any>(res.body).peaks).toEqual([]);
  });

  it("sorts results by days ascending", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ id: "user-123", role: "MANAGER" });
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: "a-1",
        displayName: "Slow Starter",
        handle: "slow",
        tweetDrafts: [
          { createdAt: new Date("2026-01-01"), actualEngagement: 5 },
          { createdAt: new Date("2026-02-01"), actualEngagement: 80 },
        ],
      },
      {
        id: "a-2",
        displayName: "Fast Learner",
        handle: "fast",
        tweetDrafts: [
          { createdAt: new Date("2026-01-01"), actualEngagement: 10 },
          { createdAt: new Date("2026-01-05"), actualEngagement: 90 },
        ],
      },
      {
        id: "a-3",
        displayName: null,
        handle: "none",
        tweetDrafts: [],
      },
    ]);

    const res = await request(app).get("/api/analytics/days-to-peak").set(AUTH);
    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);
    expect(data.peaks).toHaveLength(3);
    expect(data.peaks[0].name).toBe("none");     // 0 days (no drafts)
    expect(data.peaks[1].name).toBe("Fast Learner"); // 4 days
    expect(data.peaks[2].name).toBe("Slow Starter"); // 31 days
  });

  it("uses handle as fallback when displayName is null", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ id: "user-123", role: "MANAGER" });
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValueOnce([
      { id: "a-1", displayName: null, handle: "fallback_handle", tweetDrafts: [] },
    ]);

    const res = await request(app).get("/api/analytics/days-to-peak").set(AUTH);
    expect(expectSuccessResponse<any>(res.body).peaks[0].name).toBe("fallback_handle");
  });
});
