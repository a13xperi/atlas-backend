/**
 * Auth routes test suite (legacy — tests /me endpoint behavior)
 * The comprehensive Supabase auth tests are in routes/auth.test.ts
 * This file tests: GET /me, auth middleware behavior
 * Mocks: Prisma, Supabase (null — JWT fallback), jsonwebtoken
 */

import request from "supertest";
import express from "express";
import { requestIdMiddleware } from "../middleware/requestId";

jest.mock("../lib/supabase", () => ({ supabaseAdmin: null }));

jest.mock("../middleware/rateLimit", () => ({
  rateLimit: () => (_req: any, _res: any, next: any) => next(),
  rateLimitByUser: () => (_req: any, _res: any, next: any) => next(),
  clearRateLimitStore: jest.fn(),
}));

jest.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
  },
}));

jest.mock("jsonwebtoken", () => ({
  sign: jest.fn().mockReturnValue("mock_token"),
  verify: jest.fn().mockReturnValue({ userId: "user-123" }),
}));

import { authRouter } from "../routes/auth";
import { prisma } from "../lib/prisma";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/auth", authRouter);

const mockUser = {
  id: "user-123",
  handle: "testuser",
  email: "test@example.com",
  role: "ANALYST",
  voiceProfile: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.JWT_SECRET = "test-secret";
});

afterEach(() => {
  delete process.env.JWT_SECRET;
});

describe("POST /api/auth/register", () => {
  it("returns 503 when Supabase is not configured", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ handle: "testuser", email: "test@example.com", password: "secret123" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("Auth service unavailable");
  });

  it("returns 400 when handle is missing", async () => {
    const res = await request(app).post("/api/auth/register").send({});
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/login", () => {
  it("returns 503 when Supabase is not configured", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "test@example.com", password: "secret123" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("Auth service unavailable");
  });
});

describe("GET /api/auth/me", () => {
  const validToken = "Bearer mock_token";

  it("returns 401 when no token provided", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("returns 404 when user not found", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(null);

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", validToken);

    expect(res.status).toBe(404);
  });

  it("returns user with voiceProfile when authenticated", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
      ...mockUser,
      voiceProfile: { humor: 5, formality: 5 },
    });

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", validToken);

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe("user-123");
    expect(res.body.user.voiceProfile).toBeDefined();
  });
});
