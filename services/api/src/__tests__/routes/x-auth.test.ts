/**
 * X auth routes test suite
 * Tests POST /authorize, POST /callback, GET /status, POST /disconnect
 * Mocks: auth middleware, Prisma, Twitter OAuth helpers, global fetch
 */

import request from "supertest";
import express from "express";
import { requestIdMiddleware } from "../../middleware/requestId";
import { expectSuccessResponse } from "../helpers/response";

jest.mock("../../middleware/auth", () => ({
  authenticate: jest.fn((req: any, res: any, next: any) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing authorization token" });
    }
    req.userId = "user-123";
    next();
  }),
  AuthRequest: {},
}));

jest.mock("../../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
  },
}));

jest.mock("../../lib/twitter", () => ({
  generateOAuthUrl: jest.fn(),
  generateLoginOAuthUrl: jest.fn(),
  exchangeCodeForTokens: jest.fn(),
  exchangeLoginCodeForTokens: jest.fn(),
  fetchTwitterUserProfile: jest.fn(),
  lookupUser: jest.fn(),
}));

const setIntervalSpy = jest.spyOn(global, "setInterval").mockImplementation(
  ((_handler: any, _timeout?: number, ..._args: any[]) =>
    0 as unknown as NodeJS.Timeout) as typeof setInterval
);

import { prisma } from "../../lib/prisma";
import {
  generateOAuthUrl,
  exchangeCodeForTokens,
  exchangeLoginCodeForTokens,
  fetchTwitterUserProfile,
} from "../../lib/twitter";
import { xAuthRouter, twitterLoginRouter } from "../../routes/x-auth";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockGenerateOAuthUrl = generateOAuthUrl as jest.MockedFunction<typeof generateOAuthUrl>;
const mockExchangeCodeForTokens = exchangeCodeForTokens as jest.MockedFunction<typeof exchangeCodeForTokens>;
const mockExchangeLoginCodeForTokens = exchangeLoginCodeForTokens as jest.MockedFunction<typeof exchangeLoginCodeForTokens>;
const mockFetchTwitterUserProfile = fetchTwitterUserProfile as jest.MockedFunction<typeof fetchTwitterUserProfile>;

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/auth/x", xAuthRouter);
app.use("/api/auth/twitter", twitterLoginRouter);

const AUTH = { Authorization: "Bearer mock_token" };

beforeAll(() => {
  process.env.JWT_SECRET = "test-secret";
});

afterAll(() => {
  delete process.env.JWT_SECRET;
  setIntervalSpy.mockRestore();
});

beforeEach(() => {
  jest.clearAllMocks();

  mockGenerateOAuthUrl.mockImplementation((state: string) => ({
    url: `https://twitter.example.com/i/oauth2/authorize?state=${state}`,
    codeVerifier: "verifier-123",
  }));

  mockExchangeCodeForTokens.mockResolvedValue({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresIn: 3600,
  });
  mockFetchTwitterUserProfile.mockResolvedValue({
    id: "x-user-1",
    username: "atlas_handle",
    name: "Atlas Handle",
    description: "Crypto analyst",
    profile_image_url: "https://example.com/avatar_400x400.jpg",
    public_metrics: {
      followers_count: 12345,
      following_count: 50,
      tweet_count: 100,
    },
  });

  mockExchangeLoginCodeForTokens.mockResolvedValue({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresIn: 3600,
  });

  (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
  (mockPrisma.user.update as jest.Mock).mockResolvedValue({ id: "user-123" });
  (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(null);
  (mockPrisma.user.create as jest.Mock).mockResolvedValue({ id: "user-456" });
});

describe("POST /api/auth/x/authorize", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).post("/api/auth/x/authorize");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Missing authorization token");
  });

  it("returns OAuth URL and state", async () => {
    const res = await request(app)
      .post("/api/auth/x/authorize")
      .set(AUTH);

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<{ url: string; state: string }>(res.body);

    expect(data.state).toMatch(/^atlas_user-123_\d+$/);
    expect(data.url).toBe(`https://twitter.example.com/i/oauth2/authorize?state=${data.state}`);
    expect(mockGenerateOAuthUrl).toHaveBeenCalledWith(data.state);
  });

  it("returns 500 when generateOAuthUrl throws", async () => {
    mockGenerateOAuthUrl.mockImplementationOnce(() => {
      throw new Error("oauth failed");
    });

    const res = await request(app)
      .post("/api/auth/x/authorize")
      .set(AUTH);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to generate X authorization URL");
    expect(res.body.message).toBe("Failed to generate X authorization URL");
    expect(res.body.requestId).toEqual(expect.any(String));
  });
});

describe("POST /api/auth/x/callback", () => {
  it("returns 400 when code/state missing", async () => {
    const res = await request(app)
      .post("/api/auth/x/callback")
      .set(AUTH)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing code or state");
    expect(res.body.message).toBe("Missing code or state");
    expect(mockExchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it("returns 400 when OAuth session expired", async () => {
    const nowSpy = jest.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_710_000_000_000);

    const authorizeRes = await request(app)
      .post("/api/auth/x/authorize")
      .set(AUTH);

    expect(authorizeRes.status).toBe(200);
    const { state } = expectSuccessResponse<{ url: string; state: string }>(authorizeRes.body);

    nowSpy.mockReturnValue(1_710_000_600_001);

    const callbackRes = await request(app)
      .post("/api/auth/x/callback")
      .set(AUTH)
      .send({ code: "oauth-code", state });

    expect(callbackRes.status).toBe(400);
    expect(callbackRes.body.error).toBe("OAuth session expired. Please try again.");
    expect(callbackRes.body.message).toBe("OAuth session expired. Please try again.");
    expect(mockExchangeCodeForTokens).not.toHaveBeenCalled();
    expect(mockFetchTwitterUserProfile).not.toHaveBeenCalled();

    nowSpy.mockRestore();
  });

  it("exchanges code for tokens and stores the X profile", async () => {
    const authorizeRes = await request(app)
      .post("/api/auth/x/authorize")
      .set(AUTH);

    expect(authorizeRes.status).toBe(200);
    const { state } = expectSuccessResponse<{ url: string; state: string }>(authorizeRes.body);

    const callbackRes = await request(app)
      .post("/api/auth/x/callback")
      .set(AUTH)
      .send({ code: "oauth-code", state });

    expect(callbackRes.status).toBe(200);
    const data = expectSuccessResponse<{ linked: boolean; xHandle: string | null }>(callbackRes.body);

    expect(data.linked).toBe(true);
    expect(data.xHandle).toBe("atlas_handle");
    expect(mockExchangeCodeForTokens).toHaveBeenCalledWith("oauth-code", "verifier-123");
    expect(mockFetchTwitterUserProfile).toHaveBeenCalledWith("access-token");
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-123" },
      data: {
        xAccessToken: "access-token",
        xRefreshToken: "refresh-token",
        xAccessTokenEnc: null,
        xRefreshTokenEnc: null,
        xTokenExpiresAt: expect.any(Date),
        xHandle: "atlas_handle",
        xBio: "Crypto analyst",
        xAvatarUrl: "https://example.com/avatar_400x400.jpg",
        xFollowerCount: 12345,
      },
    });
  });
});

describe("GET /api/auth/x/status", () => {
  it("returns linked:false when no token", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
      xHandle: null,
      xAccessToken: null,
      xRefreshToken: null,
      xAccessTokenEnc: null,
      xRefreshTokenEnc: null,
      xTokenExpiresAt: null,
    });

    const res = await request(app)
      .get("/api/auth/x/status")
      .set(AUTH);

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<{
      linked: boolean;
      xHandle: string | null;
      tokenExpired: boolean;
    }>(res.body);

    expect(data).toEqual({
      linked: false,
      xHandle: null,
      tokenExpired: true,
    });
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "user-123" },
      select: {
        xHandle: true,
        xTokenExpiresAt: true,
        xAccessToken: true,
        xRefreshToken: true,
        xAccessTokenEnc: true,
        xRefreshTokenEnc: true,
      },
    });
  });

  it("returns linked:true with xHandle when token exists", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
      xHandle: "atlas_handle",
      xAccessToken: "access-token",
      xRefreshToken: "refresh-token",
      xAccessTokenEnc: null,
      xRefreshTokenEnc: null,
      xTokenExpiresAt: new Date(Date.now() + 60_000),
    });

    const res = await request(app)
      .get("/api/auth/x/status")
      .set(AUTH);

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<{
      linked: boolean;
      xHandle: string | null;
      tokenExpired: boolean;
    }>(res.body);

    expect(data).toEqual({
      linked: true,
      xHandle: "atlas_handle",
      tokenExpired: false,
    });
  });

  it("returns tokenExpired:true when token is past expiry", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
      xHandle: "atlas_handle",
      xAccessToken: "access-token",
      xRefreshToken: "refresh-token",
      xAccessTokenEnc: null,
      xRefreshTokenEnc: null,
      xTokenExpiresAt: new Date(Date.now() - 60_000),
    });

    const res = await request(app)
      .get("/api/auth/x/status")
      .set(AUTH);

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<{
      linked: boolean;
      xHandle: string | null;
      tokenExpired: boolean;
    }>(res.body);

    expect(data).toEqual({
      linked: true,
      xHandle: "atlas_handle",
      tokenExpired: true,
    });
  });
});

describe("POST /api/auth/x/disconnect", () => {
  it("clears X tokens and returns linked:false", async () => {
    const res = await request(app)
      .post("/api/auth/x/disconnect")
      .set(AUTH);

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<{ linked: boolean }>(res.body);

    expect(data).toEqual({ linked: false });
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-123" },
      data: {
        xAccessToken: null,
        xRefreshToken: null,
        xAccessTokenEnc: null,
        xRefreshTokenEnc: null,
        xTokenExpiresAt: null,
        xHandle: null,
      },
    });
  });
});

describe("GET callback — C-5 JWT leak regression", () => {
  // Regression for C-5: JWT must not appear in redirect query string.
  // HttpOnly cookies set via setAuthCookies() already carry the session;
  // query-string tokens leak via Referer, browser history, and upstream logs.

  it("GET /api/auth/x/callback does not leak JWT in redirect URL, sets auth cookies", async () => {
    // Initiate login to seed a login-flow PKCE state via GET /login
    const loginRes = await request(app).get("/api/auth/x/login");
    expect(loginRes.status).toBe(302);
    const location = loginRes.headers.location as string;
    const url = new URL(location);
    const state = url.searchParams.get("state");
    expect(state).toBeTruthy();

    // Drive the GET callback
    const res = await request(app)
      .get("/api/auth/x/callback")
      .query({ code: "oauth-code", state });

    expect(res.status).toBe(302);

    const redirect = res.headers.location as string;
    expect(redirect).toContain("provider=twitter");
    expect(redirect).not.toContain("token=");
    // Defense in depth: no raw JWT fragment should appear in the query
    expect(redirect).not.toMatch(/[?&]token=/);

    // HttpOnly auth cookies must be set so the portal has the session
    const setCookie = res.headers["set-cookie"] as unknown as string[] | string;
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
    expect(cookies.some((c) => c.includes("atlas_access_token="))).toBe(true);
    expect(cookies.some((c) => c.includes("atlas_refresh_token="))).toBe(true);
    expect(cookies.some((c) => /atlas_access_token=.+HttpOnly/i.test(c))).toBe(true);

    // Confirm token exchange + profile fetch actually happened
    expect(mockExchangeCodeForTokens).toHaveBeenCalledWith("oauth-code", "verifier-123");
    expect(mockFetchTwitterUserProfile).toHaveBeenCalledWith("access-token");
  });

  it("GET /api/auth/twitter/callback does not leak JWT in redirect URL, sets auth cookies", async () => {
    // Initiate twitter login to seed PKCE state via GET /api/auth/twitter
    const loginRes = await request(app).get("/api/auth/twitter");
    expect(loginRes.status).toBe(302);
    const location = loginRes.headers.location as string;
    const url = new URL(location);
    const state = url.searchParams.get("state");
    expect(state).toBeTruthy();

    // Drive the callback
    const res = await request(app)
      .get("/api/auth/twitter/callback")
      .query({ code: "oauth-code", state });

    expect(res.status).toBe(302);

    const redirect = res.headers.location as string;
    expect(redirect).toContain("provider=twitter");
    expect(redirect).not.toContain("token=");
    expect(redirect).not.toMatch(/[?&]token=/);

    const setCookie = res.headers["set-cookie"] as unknown as string[] | string;
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
    expect(cookies.some((c) => c.includes("atlas_access_token="))).toBe(true);
    expect(cookies.some((c) => c.includes("atlas_refresh_token="))).toBe(true);
    expect(cookies.some((c) => /atlas_access_token=.+HttpOnly/i.test(c))).toBe(true);

    // twitterLoginRouter uses the login-specific exchange
    expect(mockExchangeLoginCodeForTokens).toHaveBeenCalledWith("oauth-code", "verifier-123");
    expect(mockFetchTwitterUserProfile).toHaveBeenCalledWith("access-token");
  });
});
