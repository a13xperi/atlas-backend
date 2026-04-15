/**
 * JWT revocation on logout integration tests (C-6)
 * Tests Redis jti blacklist behavior via mocked jwt-revocation.
 */

import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { requestIdMiddleware } from "../middleware/requestId";
import { expectSuccessResponse } from "./helpers/response";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://localhost:5432/atlas_test";
delete process.env.REDIS_URL;

const mockSupabaseAuth = {
  admin: {
    createUser: jest.fn(),
    signOut: jest.fn(),
  },
  signInWithPassword: jest.fn(),
  getUser: jest.fn(),
  refreshSession: jest.fn(),
};

jest.mock("../lib/supabase", () => ({
  supabaseAdmin: {
    auth: mockSupabaseAuth,
  },
}));

jest.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock("bcryptjs", () => ({
  __esModule: true,
  default: {
    hash: jest.fn().mockResolvedValue("hashed-password"),
    compare: jest.fn().mockResolvedValue(true),
  },
}));

jest.mock("../lib/logger", () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock("../middleware/rateLimit", () => ({
  rateLimit: () => (_req: any, _res: any, next: any) => next(),
  rateLimitByUser: () => (_req: any, _res: any, next: any) => next(),
  clearRateLimitStore: jest.fn(),
}));

// In-memory jti blacklist for tests
const revokedJtis = new Set<string>();

jest.mock("../lib/jwt-revocation", () => ({
  revokeJti: jest.fn((jti: string, _ttl: number) => {
    revokedJtis.add(jti);
    return Promise.resolve(true);
  }),
  isJtiRevoked: jest.fn((jti?: string) =>
    Promise.resolve(jti ? revokedJtis.has(jti) : false),
  ),
  remainingTtlSeconds: jest.fn().mockReturnValue(3600),
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
  supabaseId: "sb-uuid-123",
  voiceProfile: null,
};

function signToken(userId = "user-123", jti?: string): string {
  return jwt.sign({ userId, jti }, process.env.JWT_SECRET!, { expiresIn: "7d" });
}

function authHeader(userId = "user-123", jti?: string): string {
  return `Bearer ${signToken(userId, jti)}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  revokedJtis.clear();
  (mockPrisma.user.findUnique as jest.Mock).mockReset();
  (mockPrisma.user.findFirst as jest.Mock).mockReset();
  (mockPrisma.user.update as jest.Mock).mockReset();
  (mockPrisma.user.create as jest.Mock).mockReset();

  // Default: getUser fails so authenticate falls through to JWT path
  mockSupabaseAuth.getUser.mockResolvedValue({
    data: { user: null },
    error: { message: "invalid" },
  });
  // Default: Supabase sign-in fails so login falls through to legacy path
  mockSupabaseAuth.signInWithPassword.mockResolvedValue({
    data: { session: null },
    error: { message: "invalid" },
  });
});

describe("JWT revocation on logout", () => {
  it("valid token with jti works before logout", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", authHeader("user-123", "jti-1"));

    expect(res.status).toBe(200);
  });

  it("same token returns 401 after /logout", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

    const token = signToken("user-123", "jti-2");

    const logoutRes = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${token}`);
    expect(logoutRes.status).toBe(200);

    const meRes = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);
    expect(meRes.status).toBe(401);
    expect(meRes.body.error).toMatch(/Invalid or expired token/i);
  });

  it("a different token for the same user still works after logout", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

    const tokenA = signToken("user-123", "jti-a");
    const tokenB = signToken("user-123", "jti-b");

    const logoutRes = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${tokenA}`);
    expect(logoutRes.status).toBe(200);

    const meRes = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${tokenB}`);
    expect(meRes.status).toBe(200);
  });

  it("legacy token without jti still works after logout", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

    const token = signToken("user-123");

    const logoutRes = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${token}`);
    expect(logoutRes.status).toBe(200);

    const meRes = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);
    expect(meRes.status).toBe(200);
  });
});
