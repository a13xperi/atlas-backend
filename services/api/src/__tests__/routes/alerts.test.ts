/**
 * Alerts routes test suite
 * Tests GET/POST/PATCH/DELETE /subscriptions, GET /feed
 * Mocks: Prisma, jsonwebtoken
 */

import request from "supertest";
import express from "express";
import { alertsRouter } from "../../routes/alerts";
import { requestIdMiddleware } from "../../middleware/requestId";

// The `X-Test-Skip-UserId: 1` request header instructs the mock authenticate
// middleware to bypass its normal `req.userId = "user-123"` assignment and
// call next() with an unauthenticated request. This lets the defense-in-depth
// guard tests exercise the `requireUserId` path in each handler without
// rewiring jest.mock mid-suite.
jest.mock("../../middleware/auth", () => ({
  authenticate: jest.fn((req: any, res: any, next: any) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "Missing authorization token" });
    if (req.headers["x-test-skip-userid"] === "1") {
      // Simulate a middleware bypass: authentication "succeeded" but the
      // userId never got populated. The handler's requireUserId guard is
      // the only thing standing between the request and the Prisma query.
      return next();
    }
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
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
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
    expect(res.body.data.subscriptions).toHaveLength(1);
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
    expect(res.body.error).toBe("Failed to load subscriptions");
    expect(res.body.message).toBe("db down");
  });
});

describe("POST /api/alerts/subscriptions", () => {
  it("returns 400 when type or value is missing", async () => {
    const res = await request(app)
      .post("/api/alerts/subscriptions")
      .set(AUTH)
      .send({ type: "CATEGORY" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Type and value required");
  });

  it("creates/upserts subscription", async () => {
    (mockPrisma.alertSubscription.upsert as jest.Mock).mockResolvedValueOnce(mockSub);

    const res = await request(app)
      .post("/api/alerts/subscriptions")
      .set(AUTH)
      .send({ type: "CATEGORY", value: "DeFi" });

    expect(res.status).toBe(200);
    expect(res.body.data.subscription.value).toBe("DeFi");
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
    expect(res.body.error).toBe("Subscription not found");
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
    expect(res.body.data.subscription.isActive).toBe(false);
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
    expect(res.body.data.success).toBe(true);
  });
});

describe("GET /api/alerts/feed", () => {
  it("returns recent alerts", async () => {
    const alerts = [{ id: "a-1", title: "BTC Alert", createdAt: new Date() }];
    (mockPrisma.alert.findMany as jest.Mock).mockResolvedValueOnce(alerts);

    const res = await request(app).get("/api/alerts/feed").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.alerts).toHaveLength(1);
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
    expect(res.body.data.alerts).toEqual(alerts);
    expect(mockPrisma.alert.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5, skip: 2 })
    );
  });

  it("only returns current user's alerts", async () => {
    (mockPrisma.alert.findMany as jest.Mock).mockResolvedValueOnce([]);
    await request(app).get("/api/alerts/feed").set(AUTH);
    expect(mockPrisma.alert.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-123" } })
    );
  });
});

describe("GET /api/alerts/:id", () => {
  it("returns 404 for another user's alert", async () => {
    (mockPrisma.alert.findFirst as jest.Mock).mockResolvedValueOnce(null);
    const res = await request(app).get("/api/alerts/other-alert-id").set(AUTH);
    expect(res.status).toBe(404);
    expect(mockPrisma.alert.findFirst).toHaveBeenCalledWith({
      where: { id: "other-alert-id", userId: "user-123" },
    });
  });

  it("returns alert owned by user", async () => {
    const alert = { id: "a-1", userId: "user-123", title: "My Alert" };
    (mockPrisma.alert.findFirst as jest.Mock).mockResolvedValueOnce(alert);
    const res = await request(app).get("/api/alerts/a-1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.alert.id).toBe("a-1");
  });
});

describe("PATCH /api/alerts/:id", () => {
  it("returns 404 for another user's alert", async () => {
    (mockPrisma.alert.findFirst as jest.Mock).mockResolvedValueOnce(null);
    const res = await request(app).patch("/api/alerts/other-alert-id").set(AUTH).send({});
    expect(res.status).toBe(404);
  });

  it("dismisses alert owned by user", async () => {
    const alert = { id: "a-1", userId: "user-123", title: "My Alert" };
    const dismissed = { ...alert, expiresAt: new Date() };
    (mockPrisma.alert.findFirst as jest.Mock).mockResolvedValueOnce(alert);
    (mockPrisma.alert.update as jest.Mock).mockResolvedValueOnce(dismissed);
    const res = await request(app).patch("/api/alerts/a-1").set(AUTH).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.alert.expiresAt).toBeDefined();
  });
});

describe("DELETE /api/alerts/:id", () => {
  it("returns 404 for another user's alert", async () => {
    (mockPrisma.alert.findFirst as jest.Mock).mockResolvedValueOnce(null);
    const res = await request(app).delete("/api/alerts/other-alert-id").set(AUTH);
    expect(res.status).toBe(404);
  });

  it("deletes alert owned by user", async () => {
    const alert = { id: "a-1", userId: "user-123", title: "My Alert" };
    (mockPrisma.alert.findFirst as jest.Mock).mockResolvedValueOnce(alert);
    (mockPrisma.alert.delete as jest.Mock).mockResolvedValueOnce(alert);
    const res = await request(app).delete("/api/alerts/a-1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.success).toBe(true);
  });
});

// Defense-in-depth guard tests — atlas-backend #3947. Each request carries
// `X-Test-Skip-UserId: 1` which causes the mocked authenticate middleware to
// call next() WITHOUT setting `req.userId`. The only thing preventing a
// cross-user leak in that state is the `requireUserId` guard at the top of
// each handler; these tests prove it fires and that no Prisma query runs.
describe("defense-in-depth: requireUserId guard", () => {
  const NO_USER = { Authorization: "Bearer mock_token", "X-Test-Skip-UserId": "1" };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("GET /subscriptions returns 401 and does not query Prisma", async () => {
    const res = await request(app).get("/api/alerts/subscriptions").set(NO_USER);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
    expect(mockPrisma.alertSubscription.findMany).not.toHaveBeenCalled();
  });

  it("POST /subscriptions returns 401 and does not upsert", async () => {
    const res = await request(app)
      .post("/api/alerts/subscriptions")
      .set(NO_USER)
      .send({ type: "CATEGORY", value: "DeFi" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
    expect(mockPrisma.alertSubscription.upsert).not.toHaveBeenCalled();
  });

  it("PATCH /subscriptions/:id returns 401 and does not update", async () => {
    const res = await request(app)
      .patch("/api/alerts/subscriptions/sub-1")
      .set(NO_USER)
      .send({ isActive: false });
    expect(res.status).toBe(401);
    expect(mockPrisma.alertSubscription.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.alertSubscription.update).not.toHaveBeenCalled();
  });

  it("DELETE /subscriptions/:id returns 401 and does not delete", async () => {
    const res = await request(app).delete("/api/alerts/subscriptions/sub-1").set(NO_USER);
    expect(res.status).toBe(401);
    expect(mockPrisma.alertSubscription.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.alertSubscription.delete).not.toHaveBeenCalled();
  });

  it("GET /feed returns 401 and does not query alerts", async () => {
    const res = await request(app).get("/api/alerts/feed").set(NO_USER);
    expect(res.status).toBe(401);
    expect(mockPrisma.alert.findMany).not.toHaveBeenCalled();
  });

  it("GET /:id returns 401 and does not query the alert", async () => {
    const res = await request(app).get("/api/alerts/a-1").set(NO_USER);
    expect(res.status).toBe(401);
    expect(mockPrisma.alert.findFirst).not.toHaveBeenCalled();
  });

  it("PATCH /:id returns 401 and does not update the alert", async () => {
    const res = await request(app).patch("/api/alerts/a-1").set(NO_USER).send({});
    expect(res.status).toBe(401);
    expect(mockPrisma.alert.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.alert.update).not.toHaveBeenCalled();
  });

  it("DELETE /:id returns 401 and does not delete the alert", async () => {
    const res = await request(app).delete("/api/alerts/a-1").set(NO_USER);
    expect(res.status).toBe(401);
    expect(mockPrisma.alert.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.alert.delete).not.toHaveBeenCalled();
  });
});

// Verify that the authenticated userId flows through to every Prisma query
// unchanged. These assertions catch the specific regression atlas-backend
// #3947 is defending against: a query that omits `userId` from its where
// clause would silently match every row in the table.
describe("userId scoping on every query", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("POST /subscriptions upserts with userId in the compound key AND the create body", async () => {
    (mockPrisma.alertSubscription.upsert as jest.Mock).mockResolvedValueOnce(mockSub);
    await request(app)
      .post("/api/alerts/subscriptions")
      .set(AUTH)
      .send({ type: "CATEGORY", value: "DeFi" });

    expect(mockPrisma.alertSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_type_value: { userId: "user-123", type: "CATEGORY", value: "DeFi" },
        },
        create: expect.objectContaining({ userId: "user-123" }),
      }),
    );
  });

  it("PATCH /subscriptions/:id scopes the ownership findFirst to userId", async () => {
    (mockPrisma.alertSubscription.findFirst as jest.Mock).mockResolvedValueOnce(mockSub);
    (mockPrisma.alertSubscription.update as jest.Mock).mockResolvedValueOnce(mockSub);

    await request(app)
      .patch("/api/alerts/subscriptions/sub-1")
      .set(AUTH)
      .send({ isActive: false });

    expect(mockPrisma.alertSubscription.findFirst).toHaveBeenCalledWith({
      where: { id: "sub-1", userId: "user-123" },
    });
  });

  it("DELETE /subscriptions/:id scopes the ownership findFirst to userId", async () => {
    (mockPrisma.alertSubscription.findFirst as jest.Mock).mockResolvedValueOnce(mockSub);
    (mockPrisma.alertSubscription.delete as jest.Mock).mockResolvedValueOnce(mockSub);

    await request(app).delete("/api/alerts/subscriptions/sub-1").set(AUTH);

    expect(mockPrisma.alertSubscription.findFirst).toHaveBeenCalledWith({
      where: { id: "sub-1", userId: "user-123" },
    });
  });

  it("GET /feed passes userId (and any category filter) to findMany", async () => {
    (mockPrisma.alert.findMany as jest.Mock).mockResolvedValueOnce([]);
    await request(app).get("/api/alerts/feed?category=DeFi").set(AUTH);
    expect(mockPrisma.alert.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-123", category: "DeFi" },
      }),
    );
  });

  it("PATCH /:id scopes the ownership findFirst to userId", async () => {
    const alert = { id: "a-1", userId: "user-123", title: "My Alert" };
    (mockPrisma.alert.findFirst as jest.Mock).mockResolvedValueOnce(alert);
    (mockPrisma.alert.update as jest.Mock).mockResolvedValueOnce({ ...alert, expiresAt: new Date() });

    await request(app).patch("/api/alerts/a-1").set(AUTH).send({});

    expect(mockPrisma.alert.findFirst).toHaveBeenCalledWith({
      where: { id: "a-1", userId: "user-123" },
    });
  });

  it("DELETE /:id scopes the ownership findFirst to userId", async () => {
    const alert = { id: "a-1", userId: "user-123", title: "My Alert" };
    (mockPrisma.alert.findFirst as jest.Mock).mockResolvedValueOnce(alert);
    (mockPrisma.alert.delete as jest.Mock).mockResolvedValueOnce(alert);

    await request(app).delete("/api/alerts/a-1").set(AUTH);

    expect(mockPrisma.alert.findFirst).toHaveBeenCalledWith({
      where: { id: "a-1", userId: "user-123" },
    });
  });
});
