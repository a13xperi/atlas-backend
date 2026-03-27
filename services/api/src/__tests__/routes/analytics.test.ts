/**
 * Analytics routes test suite
 * Tests GET /summary, /learning-log, /engagement, /team
 * Mocks: Prisma, jsonwebtoken
 */

import request from "supertest";
import express from "express";
import { analyticsRouter } from "../../routes/analytics";

jest.mock("../../lib/prisma", () => ({
  prisma: {
    analyticsEvent: {
      count: jest.fn(),
      findMany: jest.fn(),
    },
    learningLogEntry: {
      findMany: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
  },
}));

jest.mock("jsonwebtoken", () => ({
  verify: jest.fn().mockReturnValue({ userId: "user-123" }),
}));

import { prisma } from "../../lib/prisma";
const mockPrisma = prisma as jest.Mocked<typeof prisma>;

const app = express();
app.use(express.json());
app.use("/api/analytics", analyticsRouter);

const AUTH = { Authorization: "Bearer mock_token" };

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
    expect(res.body.summary.draftsCreated).toBe(10);
    expect(res.body.summary.draftsPosted).toBe(5);
    expect(res.body.summary.feedbackGiven).toBe(3);
    expect(res.body.summary.period).toBe("30d");
  });
});

describe("GET /api/analytics/learning-log", () => {
  it("returns list of learning log entries", async () => {
    const entries = [{ id: "e-1", insight: "test insight", createdAt: new Date() }];
    (mockPrisma.learningLogEntry.findMany as jest.Mock).mockResolvedValueOnce(entries);

    const res = await request(app).get("/api/analytics/learning-log").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
  });
});

describe("GET /api/analytics/engagement", () => {
  it("returns engagement events", async () => {
    const events = [{ id: "ev-1", type: "ENGAGEMENT_RECORDED", createdAt: new Date() }];
    (mockPrisma.analyticsEvent.findMany as jest.Mock).mockResolvedValueOnce(events);

    const res = await request(app).get("/api/analytics/engagement").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
  });
});

describe("GET /api/analytics/team", () => {
  it("returns 403 for ANALYST role", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ id: "user-123", role: "ANALYST" });
    const res = await request(app).get("/api/analytics/team").set(AUTH);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Manager access required");
  });

  it("returns team data for MANAGER role", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ id: "user-123", role: "MANAGER" });
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValueOnce([
      { id: "a-1", handle: "analyst1", role: "ANALYST", voiceProfile: null, _count: { tweetDrafts: 5 } },
    ]);

    const res = await request(app).get("/api/analytics/team").set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.analysts)).toBe(true);
  });

  it("returns 403 when user not found in DB", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(null);
    const res = await request(app).get("/api/analytics/team").set(AUTH);
    expect(res.status).toBe(403);
  });
});
