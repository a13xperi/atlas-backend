/**
 * JWT revocation on logout integration tests
 * Tests that /logout sets tokensInvalidatedBefore and middleware rejects old tokens
 */

import request from "supertest";
import express from "express";
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

jest.mock("jsonwebtoken", () => ({
  sign: jest.fn().mockReturnValue("mock_token"),
  verify: jest.fn().mockReturnValue({ userId: "user-123", iat: 1000 }),
  decode: jest.fn().mockReturnValue({ iat: 1000 }),
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

import { authRouter } from "../routes/auth";
import { prisma } from "../lib/prisma";
import jwt from "jsonwebtoken";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockJwt = jwt as jest.Mocked<typeof jwt>;

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

beforeEach(() => {
  jest.clearAllMocks();
  (mockPrisma.user.findUnique as jest.Mock).mockReset();
  (mockPrisma.user.findFirst as jest.Mock).mockReset();
  (mockPrisma.user.update as jest.Mock).mockReset();
  (mockPrisma.user.create as jest.Mock).mockReset();

  // Default: getUser fails so authenticate falls through to JWT path
  mockSupabaseAuth.getUser.mockResolvedValue({ data: { user: null }, error: { message: "invalid" } });
  // Default: Supabase sign-in fails so login falls through to legacy path
  mockSupabaseAuth.signInWithPassword.mockResolvedValue({ data: { session: null }, error: { message: "invalid" } });

  // Default jwt mocks
  (mockJwt.sign as jest.Mock).mockReturnValue("mock_token");
  (mockJwt.verify as jest.Mock).mockReturnValue({ userId: "user-123", iat: 1000 });
  (mockJwt.decode as jest.Mock).mockReturnValue({ iat: 1000 });
});

describe("JWT revocation on logout", () => {
  it("valid legacy token works before logout", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
      ...mockUser,
      tokensInvalidatedBefore: null,
    });

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", "Bearer mock_token");

    expect(res.status).toBe(200);
  });

  it("same token returns 401 after /logout", async () => {
    (mockPrisma.user.findUnique as jest.Mock)
      .mockResolvedValueOnce({ ...mockUser, tokensInvalidatedBefore: null })
      .mockResolvedValueOnce({ ...mockUser, supabaseId: "sb-uuid-123" })
      .mockResolvedValueOnce({ ...mockUser, tokensInvalidatedBefore: new Date(2000 * 1000) });

    (mockPrisma.user.update as jest.Mock).mockResolvedValue({
      ...mockUser,
      tokensInvalidatedBefore: new Date(2000 * 1000),
    });

    const logoutRes = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", "Bearer mock_token");
    expect(logoutRes.status).toBe(200);

    const meRes = await request(app)
      .get("/api/auth/me")
      .set("Authorization", "Bearer mock_token");

    expect(meRes.status).toBe(401);
    expect(meRes.body.error).toMatch(/revoked/i);
  });

  it("new token issued after logout works", async () => {
    (mockPrisma.user.findUnique as jest.Mock)
      .mockResolvedValueOnce({ ...mockUser, passwordHash: "hashed-password", tokensInvalidatedBefore: null })
      .mockResolvedValueOnce({ ...mockUser, tokensInvalidatedBefore: null })
      .mockResolvedValueOnce({ ...mockUser, supabaseId: "sb-uuid-123" })
      .mockResolvedValueOnce({ ...mockUser, tokensInvalidatedBefore: new Date(1000 * 1000) })
      .mockResolvedValueOnce({ ...mockUser, voiceProfile: null });

    (mockPrisma.user.update as jest.Mock).mockResolvedValue({
      ...mockUser,
      tokensInvalidatedBefore: new Date(1000 * 1000),
    });

    // login with old credentials to get token t1
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: "test@example.com", password: "secret123" });
    expect(loginRes.status).toBe(200);
    const t1 = expectSuccessResponse<any>(loginRes.body).token;

    // logout with t1
    const logoutRes = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${t1}`);
    expect(logoutRes.status).toBe(200);

    // simulate new token t2 with later iat
    (mockJwt.verify as jest.Mock).mockReturnValue({ userId: "user-123", iat: 2000 });
    (mockJwt.decode as jest.Mock).mockReturnValue({ iat: 2000 });

    const meRes = await request(app)
      .get("/api/auth/me")
      .set("Authorization", "Bearer mock_token_new");
    expect(meRes.status).toBe(200);
  });

  it("logout invalidates tokens on all devices (same user, different tokens)", async () => {
    (mockPrisma.user.findUnique as jest.Mock)
      .mockResolvedValueOnce({ ...mockUser, tokensInvalidatedBefore: null })
      .mockResolvedValueOnce({ ...mockUser, supabaseId: "sb-uuid-123" })
      .mockResolvedValueOnce({ ...mockUser, tokensInvalidatedBefore: new Date(2000 * 1000) });

    (mockPrisma.user.update as jest.Mock).mockResolvedValue({
      ...mockUser,
      tokensInvalidatedBefore: new Date(2000 * 1000),
    });

    // token A calls logout
    const logoutRes = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", "Bearer token_a");
    expect(logoutRes.status).toBe(200);

    // token B (same user, earlier iat) is now rejected
    const meRes = await request(app)
      .get("/api/auth/me")
      .set("Authorization", "Bearer token_b");
    expect(meRes.status).toBe(401);
    expect(meRes.body.error).toMatch(/revoked/i);
  });
});
