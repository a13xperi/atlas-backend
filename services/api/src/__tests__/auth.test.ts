/**
 * Auth routes test suite (legacy — tests /me endpoint behavior)
 * The comprehensive Supabase auth tests are in routes/auth.test.ts
 * This file tests: GET /me, auth middleware behavior
 * Mocks: Prisma, Supabase (null — JWT fallback), jsonwebtoken
 */

import request from "supertest";
import express from "express";
import { requestIdMiddleware } from "../middleware/requestId";
import { expectSuccessResponse } from "./helpers/response";

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
      findFirst: jest.fn(),
      create: jest.fn(),
    },
  },
}));

jest.mock("jsonwebtoken", () => ({
  sign: jest.fn().mockReturnValue("mock_token"),
  verify: jest.fn().mockReturnValue({ userId: "user-123" }),
}));

jest.mock("bcryptjs", () => ({
  hash: jest.fn().mockResolvedValue("hashed_password"),
  compare: jest.fn().mockResolvedValue(true),
}));

jest.mock("../lib/logger", () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
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
  xBio: "Crypto analyst",
  xAvatarUrl: "https://example.com/avatar.jpg",
  xFollowerCount: 12345,
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
  it("falls through to legacy auth when Supabase is not configured", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    (mockPrisma.user.create as jest.Mock).mockResolvedValue({
      ...mockUser,
      voiceProfile: {},
    });
    const res = await request(app)
      .post("/api/auth/register")
      .send({ handle: "testuser", email: "test@example.com", password: "secret123" });
    expect(res.status).toBe(200);
    expect(expectSuccessResponse<any>(res.body).token).toBeDefined();
  }, 15000);

  it("returns 400 when handle is missing", async () => {
    const res = await request(app).post("/api/auth/register").send({});
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/login", () => {
  it("returns 401 when Supabase is unavailable and no legacy user exists", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(null);
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "test@example.com", password: "secret123" });
    expect(res.status).toBe(401);
  }, 15000);

  it("returns a legacy JWT when Supabase is unavailable and credentials are valid", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
      ...mockUser,
      passwordHash: "hashed_password",
    });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "test@example.com", password: "secret123" });

    expect(res.status).toBe(200);
    expect(expectSuccessResponse<any>(res.body).token).toBeDefined();
  }, 15000);
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
    const data = expectSuccessResponse<any>(res.body);
    expect(data.user.id).toBe("user-123");
    expect(data.user.voiceProfile).toBeDefined();
    expect(data.user.xBio).toBe("Crypto analyst");
    expect(data.user.xAvatarUrl).toBe("https://example.com/avatar.jpg");
    expect(data.user.xFollowerCount).toBe(12345);
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "user-123" },
      select: {
        id: true,
        handle: true,
        role: true,
        xBio: true,
        xAvatarUrl: true,
        xFollowerCount: true,
        voiceProfile: true,
      },
    });
  });
});
