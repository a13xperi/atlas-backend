import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";

import { requestIdMiddleware } from "../middleware/requestId";

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
    session: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      delete: jest.fn(),
    },
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

jest.mock("../lib/jwt-revocation", () => ({
  revokeJti: jest.fn().mockResolvedValue(true),
  remainingTtlSeconds: jest.fn().mockReturnValue(3600),
  isJtiRevoked: jest.fn().mockResolvedValue(false),
}));

jest.mock("../lib/cookies", () => {
  const actual = jest.requireActual("../lib/cookies");
  return {
    ...actual,
    setAuthCookies: jest.fn(actual.setAuthCookies),
    clearAuthCookies: jest.fn(actual.clearAuthCookies),
  };
});

import { authRouter } from "../routes/auth";
import { prisma } from "../lib/prisma";
import { isJtiRevoked } from "../lib/jwt-revocation";
import { clearAuthCookies, setAuthCookies } from "../lib/cookies";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockIsJtiRevoked = isJtiRevoked as jest.MockedFunction<typeof isJtiRevoked>;
const mockSetAuthCookies = setAuthCookies as jest.MockedFunction<typeof setAuthCookies>;
const mockClearAuthCookies = clearAuthCookies as jest.MockedFunction<typeof clearAuthCookies>;

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(requestIdMiddleware);
app.use("/api/auth", authRouter);

function signLegacyAccessToken(userId = "user-123", jti = "legacy-jti"): string {
  return jwt.sign({ userId, jti }, process.env.JWT_SECRET!, { expiresIn: "7d" });
}

function authCookies(accessToken?: string, refreshToken?: string): string[] {
  return [
    ...(accessToken ? [`atlas_access_token=${accessToken}`] : []),
    ...(refreshToken ? [`atlas_refresh_token=${refreshToken}`] : []),
  ];
}

beforeEach(() => {
  jest.clearAllMocks();

  mockSupabaseAuth.getUser.mockResolvedValue({
    data: { user: null },
    error: { message: "invalid" },
  });
  mockSupabaseAuth.refreshSession.mockResolvedValue({
    data: { session: null },
    error: null,
  });
  mockIsJtiRevoked.mockResolvedValue(false);
});

describe("mixed-origin auth refresh", () => {
  it("refreshSession is NOT called when atlas_access_token is a legacy JWT", async () => {
    const accessToken = signLegacyAccessToken("user-123", "legacy-jti-1");

    const res = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", authCookies(accessToken, "twitter-refresh-token"))
      .send({});

    expect(res.status).toBe(200);
    expect(mockSupabaseAuth.refreshSession).not.toHaveBeenCalled();
    expect(mockSetAuthCookies).toHaveBeenCalledTimes(1);
    expect(res.body.data.refresh_token).toBe("twitter-refresh-token");

    const decoded = jwt.verify(res.body.data.token, process.env.JWT_SECRET!) as { userId: string };
    expect(decoded.userId).toBe("user-123");
  });

  it("revoked jti on refresh returns 401 and does NOT clear cookies", async () => {
    mockIsJtiRevoked.mockResolvedValueOnce(true);
    const accessToken = signLegacyAccessToken("user-123", "revoked-jti");

    const res = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", authCookies(accessToken, "twitter-refresh-token"))
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid or expired token");
    expect(mockSupabaseAuth.refreshSession).not.toHaveBeenCalled();
    expect(mockSetAuthCookies).not.toHaveBeenCalled();
    expect(mockClearAuthCookies).not.toHaveBeenCalled();
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("Supabase refresh error does NOT clearAuthCookies", async () => {
    mockSupabaseAuth.refreshSession.mockResolvedValueOnce({
      data: { session: null },
      error: { message: "invalid refresh token" },
    });

    const res = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", authCookies("twitter-access-token", "twitter-refresh-token"))
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid refresh token");
    expect(mockSupabaseAuth.refreshSession).toHaveBeenCalledWith({
      refresh_token: "twitter-refresh-token",
    });
    expect(mockSetAuthCookies).not.toHaveBeenCalled();
    expect(mockClearAuthCookies).not.toHaveBeenCalled();
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("logout does not call supabaseAdmin.auth.admin.signOut", async () => {
    const token = signLegacyAccessToken("user-123", "logout-jti-1");

    const res = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    expect(mockSupabaseAuth.admin.signOut).not.toHaveBeenCalled();
  });

  it("logout does not set tokensInvalidatedBefore on user model", async () => {
    const token = signLegacyAccessToken("user-123", "logout-jti-2");

    const res = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
});
