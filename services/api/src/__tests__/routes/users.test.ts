/**
 * Users routes test suite
 * Tests GET/PATCH /profile and GET /team
 * Mocks: Prisma, jsonwebtoken
 */

import request from "supertest";
import express from "express";
import { usersRouter } from "../../routes/users";
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
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
  },
}));

import { prisma } from "../../lib/prisma";
const mockPrisma = prisma as jest.Mocked<typeof prisma>;

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/users", usersRouter);

const AUTH = { Authorization: "Bearer mock_token" };

const mockUser = {
  id: "user-123",
  handle: "testuser",
  email: "test@example.com",
  displayName: "Test User",
  avatarUrl: null,
  passwordHash: "hashed",
  role: "ANALYST",
  createdAt: new Date(),
  voiceProfile: { humor: 50, formality: 50 },
};

beforeAll(() => {
  process.env.JWT_SECRET = "test-secret";
});

afterAll(() => {
  delete process.env.JWT_SECRET;
});

describe("GET /api/users/profile", () => {
  it("returns 401 without auth token", async () => {
    const res = await request(app).get("/api/users/profile");
    expect(res.status).toBe(401);
  });

  it("returns 404 when user not found", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(null);
    const res = await request(app).get("/api/users/profile").set(AUTH);
    expect(res.status).toBe(404);
    expectErrorResponse(res.body, "User not found");
  });

  it("returns user without passwordHash", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(mockUser);
    const res = await request(app).get("/api/users/profile").set(AUTH);
    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);
    expect(data.user.id).toBe("user-123");
    expect(data.user.passwordHash).toBeUndefined();
  });
});

describe("PATCH /api/users/profile", () => {
  it("returns 401 without auth token", async () => {
    const res = await request(app).patch("/api/users/profile").send({ displayName: "New Name" });
    expect(res.status).toBe(401);
  });

  it("updates user and returns safe fields", async () => {
    const updated = { ...mockUser, displayName: "New Name" };
    (mockPrisma.user.update as jest.Mock).mockResolvedValueOnce(updated);

    const res = await request(app)
      .patch("/api/users/profile")
      .set(AUTH)
      .send({ displayName: "New Name" });

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);
    expect(data.user.displayName).toBe("New Name");
    expect(data.user.passwordHash).toBeUndefined();
  });
});

describe("GET /api/users/team", () => {
  it("returns 401 without auth token", async () => {
    const res = await request(app).get("/api/users/team");
    expect(res.status).toBe(401);
  });

  it("returns 403 for ANALYST role", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ ...mockUser, role: "ANALYST" });
    const res = await request(app).get("/api/users/team").set(AUTH);
    expect(res.status).toBe(403);
    expectErrorResponse(res.body, "Manager access required");
  });

  it("returns team list for MANAGER role", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ ...mockUser, role: "MANAGER" });
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValueOnce([mockUser]);

    const res = await request(app).get("/api/users/team").set(AUTH);
    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);
    expect(Array.isArray(data.team)).toBe(true);
    // passwordHash should be stripped
    expect(data.team[0].passwordHash).toBeUndefined();
  });

  it("returns 403 when user not found in DB", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(null);
    const res = await request(app).get("/api/users/team").set(AUTH);
    expect(res.status).toBe(403);
  });
});

describe("POST /api/users/push-top-profiles", () => {
  it("returns 400 for an invalid action payload", async () => {
    const res = await request(app)
      .post("/api/users/push-top-profiles")
      .set(AUTH)
      .send([]);

    expect(res.status).toBe(400);
    const body = expectErrorResponse(res.body, "Invalid request");
    expect(Array.isArray(body.details)).toBe(true);
  });
});
