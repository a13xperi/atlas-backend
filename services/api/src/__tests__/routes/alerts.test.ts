/**
 * Alerts routes test suite
 * Tests GET/POST/PATCH/DELETE /subscriptions, GET /feed
 * Mocks: Prisma, jsonwebtoken
 */

import request from "supertest";
import express from "express";
import { alertsRouter } from "../../routes/alerts";
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
      findFirst: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    alert: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

import { prisma } from "../../lib/prisma";
const mockPrisma = prisma as jest.Mocked<typeof prisma>;

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/alerts", alertsRouter);

const AUTH = { Authorization: "Bearer mock_token" };

const mockSub = {
  id: "sub-1",
  userId: "user-123",
  type: "CATEGORY",
  value: "DeFi",
  isActive: true,
  delivery: ["PORTAL"],
};

beforeAll(() => {
  process.env.JWT_SECRET = "test-secret";
});

afterAll(() => {
  delete process.env.JWT_SECRET;
});

describe("GET /api/alerts/subscriptions", () => {
  it("returns 401 without token", async () => {
    const res = await request(app).get("/api/alerts/subscriptions");
    expect(res.status).toBe(401);
  });

  it("returns list of subscriptions", async () => {
    (mockPrisma.alertSubscription.findMany as jest.Mock).mockResolvedValueOnce([mockSub]);
    const res = await request(app).get("/api/alerts/subscriptions").set(AUTH);
    expect(res.status).toBe(200);
    expect(expectSuccessResponse<any>(res.body).subscriptions).toHaveLength(1);
    expect(mockPrisma.alertSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-123" },
        take: 20,
        skip: 0,
      })
    );
  });

  it("applies pagination to subscriptions", async () => {
    (mockPrisma.alertSubscription.findMany as jest.Mock).mockResolvedValueOnce([]);

    await request(app).get("/api/alerts/subscriptions?limit=5&offset=2").set(AUTH);

    expect(mockPrisma.alertSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-123" },
        take: 5,
        skip: 2,
      })
    );
  });

  it("returns 500 when loading subscriptions fails", async () => {
    (mockPrisma.alertSubscription.findMany as jest.Mock).mockRejectedValueOnce(new Error("db down"));

    const res = await request(app).get("/api/alerts/subscriptions").set(AUTH);

    expect(res.status).toBe(500);
    expect(expectErrorResponse(res.body, "Failed to load subscriptions").details.message).toBe("db down");
  });
});

describe("POST /api/alerts/subscriptions", () => {
  it("returns 400 when type or value is missing", async () => {
    const res = await request(app)
      .post("/api/alerts/subscriptions")
      .set(AUTH)
      .send({ type: "CATEGORY" });
    expect(res.status).toBe(400);
    const body = expectErrorResponse(res.body, "Invalid request");
    expect(Array.isArray(body.details)).toBe(true);
  });

  it("creates/upserts subscription", async () => {
    (mockPrisma.alertSubscription.upsert as jest.Mock).mockResolvedValueOnce(mockSub);

    const res = await request(app)
      .post("/api/alerts/subscriptions")
      .set(AUTH)
      .send({ type: "CATEGORY", value: "DeFi" });

    expect(res.status).toBe(200);
    expect(expectSuccessResponse<any>(res.body).subscription.value).toBe("DeFi");
  });
});

describe("PATCH /api/alerts/:id", () => {
  it("returns 400 for an invalid dismiss payload", async () => {
    const res = await request(app)
      .patch("/api/alerts/alert-1")
      .set(AUTH)
      .send([]);

    expect(res.status).toBe(400);
    const body = expectErrorResponse(res.body, "Invalid request");
    expect(Array.isArray(body.details)).toBe(true);
  });
});

describe("PATCH /api/alerts/subscriptions/:id", () => {
  it("returns 404 when subscription not found", async () => {
    (mockPrisma.alertSubscription.findFirst as jest.Mock).mockResolvedValueOnce(null);
    const res = await request(app)
      .patch("/api/alerts/subscriptions/bad-id")
      .set(AUTH)
      .send({ isActive: false });
    expect(res.status).toBe(404);
    expectErrorResponse(res.body, "Subscription not found");
  });

  it("toggles subscription", async () => {
    (mockPrisma.alertSubscription.findFirst as jest.Mock).mockResolvedValueOnce(mockSub);
    const updated = { ...mockSub, isActive: false };
    (mockPrisma.alertSubscription.update as jest.Mock).mockResolvedValueOnce(updated);

    const res = await request(app)
      .patch("/api/alerts/subscriptions/sub-1")
      .set(AUTH)
      .send({ isActive: false });

    expect(res.status).toBe(200);
    expect(expectSuccessResponse<any>(res.body).subscription.isActive).toBe(false);
  });
});

describe("DELETE /api/alerts/subscriptions/:id", () => {
  it("returns 404 when subscription not found", async () => {
    (mockPrisma.alertSubscription.findFirst as jest.Mock).mockResolvedValueOnce(null);
    const res = await request(app)
      .delete("/api/alerts/subscriptions/bad-id")
      .set(AUTH);
    expect(res.status).toBe(404);
  });

  it("deletes subscription", async () => {
    (mockPrisma.alertSubscription.findFirst as jest.Mock).mockResolvedValueOnce(mockSub);
    (mockPrisma.alertSubscription.delete as jest.Mock).mockResolvedValueOnce(mockSub);

    const res = await request(app)
      .delete("/api/alerts/subscriptions/sub-1")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(expectSuccessResponse<any>(res.body)).toEqual({ success: true });
  });
});

describe("GET /api/alerts/feed", () => {
  it("returns recent alerts", async () => {
    const alerts = [{ id: "a-1", title: "BTC Alert", createdAt: new Date() }];
    (mockPrisma.alert.findMany as jest.Mock).mockResolvedValueOnce(alerts);

    const res = await request(app).get("/api/alerts/feed").set(AUTH);
    expect(res.status).toBe(200);
    expect(expectSuccessResponse<any>(res.body).alerts).toHaveLength(1);
    expect(mockPrisma.alert.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20, skip: 0 })
    );
  });

  it("respects limit query param", async () => {
    (mockPrisma.alert.findMany as jest.Mock).mockResolvedValueOnce([]);
    await request(app).get("/api/alerts/feed?limit=5").set(AUTH);
    expect(mockPrisma.alert.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 })
    );
  });

  it("respects limit and offset query params", async () => {
    const alerts = [
      { id: "a-3", title: "Alert 3", createdAt: new Date() },
      { id: "a-4", title: "Alert 4", createdAt: new Date() },
    ];
    (mockPrisma.alert.findMany as jest.Mock).mockResolvedValueOnce(alerts);

    const res = await request(app).get("/api/alerts/feed?limit=5&offset=2").set(AUTH);

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);
    expect(data.alerts).toHaveLength(2);
    expect(data.alerts.map((alert: any) => alert.id)).toEqual(["a-3", "a-4"]);
    expect(mockPrisma.alert.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5, skip: 2 })
    );
  });
});
