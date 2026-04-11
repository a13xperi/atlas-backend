/**
 * X OAuth cookie-only auth e2e test — guards against C-5 regression.
 *
 * Background (security fix C-5):
 *   The Twitter login callback used to redirect to
 *     `/auth/callback?token=<JWT>&provider=twitter`
 *   which leaked the session JWT via Referer headers, browser history,
 *   shared screenshots, and any upstream HTTP logs. The fix is to redirect
 *   to `/auth/callback?provider=twitter` and rely on the HttpOnly
 *   `atlas_access_token` / `atlas_refresh_token` cookies that
 *   `setAuthCookies(res, ...)` already sets just before the redirect.
 *
 * What this test asserts (full flow):
 *   1. The X OAuth callback redirect Location contains `provider=twitter`
 *      and does NOT contain `token=`.
 *   2. The callback response sets the HttpOnly `atlas_access_token`
 *      cookie (and `atlas_refresh_token`).
 *   3. A protected route (`GET /api/auth/me`) accepts the cookie alone
 *      and returns 200.
 *   4. The same protected route rejects (401) when no cookie is sent.
 *
 * The test exercises BOTH callback handlers in routes/x-auth.ts:
 *   - `xAuthRouter.get("/callback")`        (line ~165 on origin/main)
 *   - `twitterLoginRouter.get("/callback")` (line ~412 on origin/main)
 *
 * Both currently emit `?token=...` on origin/main, so this test is
 * EXPECTED TO FAIL until the C-5 fix lands. That's the point — the
 * test is the regression guard.
 *
 * Mocking strategy: identical to services/api/src/__tests__/routes/x-auth.test.ts
 *   - Prisma user CRUD is mocked (no real DB)
 *   - Twitter OAuth helpers are mocked (no real X API calls)
 *   - jsonwebtoken is NOT mocked — the JWT round-trips through the real
 *     middleware so we genuinely prove cookie-based auth works end-to-end
 *   - Supabase admin is null so auth middleware falls through to legacy JWT
 *   - cookie-parser is mounted on the test app so the follow-up request
 *     can read `req.cookies.atlas_access_token`
 */

import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";

import { requestIdMiddleware } from "../../middleware/requestId";

// ── Mocks ──────────────────────────────────────────────────────────

jest.mock("../../lib/supabase", () => ({ supabaseAdmin: null }));

jest.mock("../../lib/prisma", () => ({
  prisma: {
    user: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
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

jest.mock("../../lib/logger", () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

// Suppress the rate-limiter cleanup interval that some modules register at load.
const setIntervalSpy = jest.spyOn(global, "setInterval").mockImplementation(
  ((_handler: any, _timeout?: number, ..._args: any[]) =>
    0 as unknown as NodeJS.Timeout) as typeof setInterval,
);

import { prisma } from "../../lib/prisma";
import {
  generateOAuthUrl,
  generateLoginOAuthUrl,
  exchangeCodeForTokens,
  exchangeLoginCodeForTokens,
  fetchTwitterUserProfile,
} from "../../lib/twitter";
import { xAuthRouter, twitterLoginRouter } from "../../routes/x-auth";
import { authRouter } from "../../routes/auth";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockGenerateOAuthUrl = generateOAuthUrl as jest.MockedFunction<typeof generateOAuthUrl>;
const mockGenerateLoginOAuthUrl = generateLoginOAuthUrl as jest.MockedFunction<typeof generateLoginOAuthUrl>;
const mockExchangeCodeForTokens = exchangeCodeForTokens as jest.MockedFunction<typeof exchangeCodeForTokens>;
const mockExchangeLoginCodeForTokens = exchangeLoginCodeForTokens as jest.MockedFunction<typeof exchangeLoginCodeForTokens>;
const mockFetchTwitterUserProfile = fetchTwitterUserProfile as jest.MockedFunction<typeof fetchTwitterUserProfile>;

// ── Test app ───────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(requestIdMiddleware);
app.use("/api/auth/x", xAuthRouter);
app.use("/api/auth/twitter", twitterLoginRouter);
app.use("/api/auth", authRouter);

// FRONTEND_URL default in config.ts begins with this origin.
const FRONTEND_ORIGIN = "https://delphi-atlas.vercel.app";
const TEST_USER_ID = "user-c5-test";
const TEST_X_HANDLE = "atlas_test_handle";

const TWITTER_PROFILE = {
  id: "x-c5",
  username: TEST_X_HANDLE,
  name: "Atlas C5 Test",
  description: "Crypto analyst",
  profile_image_url: "https://example.com/avatar_400x400.jpg",
  public_metrics: {
    followers_count: 12345,
    following_count: 50,
    tweet_count: 100,
  },
};

const DB_USER = {
  id: TEST_USER_ID,
  handle: TEST_X_HANDLE,
  email: null,
  role: "ANALYST",
  onboardingTrack: "TRACK_B",
  xHandle: TEST_X_HANDLE,
  xBio: TWITTER_PROFILE.description,
  xAvatarUrl: TWITTER_PROFILE.profile_image_url,
  xFollowerCount: TWITTER_PROFILE.public_metrics.followers_count,
  displayName: TWITTER_PROFILE.name,
  avatarUrl: TWITTER_PROFILE.profile_image_url,
  voiceProfile: null,
};

beforeAll(() => {
  // jest.env.js already sets JWT_SECRET=test-secret, but be explicit.
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
});

afterAll(() => {
  setIntervalSpy.mockRestore();
});

beforeEach(() => {
  jest.clearAllMocks();

  // Both authorize endpoints generate a deterministic OAuth URL + verifier.
  mockGenerateOAuthUrl.mockImplementation((state: string) => ({
    url: `https://twitter.example.com/i/oauth2/authorize?state=${state}`,
    codeVerifier: "verifier-c5",
  }));
  mockGenerateLoginOAuthUrl.mockImplementation((state: string) => ({
    url: `https://twitter.example.com/i/oauth2/authorize?state=${state}`,
    codeVerifier: "verifier-c5",
  }));

  // Both code-exchange functions return the same fake tokens.
  const tokens = {
    accessToken: "x-access-token",
    refreshToken: "x-refresh-token",
    expiresIn: 3600,
  };
  mockExchangeCodeForTokens.mockResolvedValue(tokens);
  mockExchangeLoginCodeForTokens.mockResolvedValue(tokens);

  mockFetchTwitterUserProfile.mockResolvedValue(TWITTER_PROFILE);

  // Returning user — keeps the test focused on the redirect/cookie flow,
  // not on the user-creation branch.
  (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(DB_USER);
  (mockPrisma.user.update as jest.Mock).mockResolvedValue(DB_USER);
  (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(DB_USER);
});

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Drive the GET /api/auth/twitter (login flow) entry point so the route
 * stores a valid PKCE entry, then return the state we should hand back
 * to the callback. We deliberately use the real route — not a private
 * helper — so the PKCE storage path is exercised end-to-end.
 */
async function primeLoginFlowAndGetState(): Promise<string> {
  const res = await request(app).get("/api/auth/twitter").redirects(0);
  expect(res.status).toBe(302);
  const location = res.headers.location as string;
  // The mocked generateOAuthUrl URL is `...?state=<state>`.
  const url = new URL(location);
  const state = url.searchParams.get("state");
  expect(state).toBeTruthy();
  return state as string;
}

/**
 * Drive the alternate entry point at GET /api/auth/x/login, which feeds
 * the xAuthRouter.get("/callback") branch.
 */
async function primeXLoginFlowAndGetState(): Promise<string> {
  const res = await request(app).get("/api/auth/x/login").redirects(0);
  expect(res.status).toBe(302);
  const location = res.headers.location as string;
  const url = new URL(location);
  const state = url.searchParams.get("state");
  expect(state).toBeTruthy();
  return state as string;
}

function expectHttpOnlyAccessTokenCookie(setCookieHeader: string[] | undefined): string {
  expect(Array.isArray(setCookieHeader)).toBe(true);
  const headers = setCookieHeader as string[];
  const accessTokenCookie = headers.find((c) => c.startsWith("atlas_access_token="));
  expect(accessTokenCookie).toBeDefined();
  // HttpOnly is mandatory — that's the whole point of C-5.
  expect(accessTokenCookie).toMatch(/HttpOnly/i);

  // Refresh cookie should also be set HttpOnly.
  const refreshTokenCookie = headers.find((c) => c.startsWith("atlas_refresh_token="));
  expect(refreshTokenCookie).toBeDefined();
  expect(refreshTokenCookie).toMatch(/HttpOnly/i);

  // Extract the raw `name=value` segment so we can replay it on the next request.
  const segment = (accessTokenCookie as string).split(";")[0];
  expect(segment.startsWith("atlas_access_token=")).toBe(true);
  // Sanity: cookie value must not be empty.
  const value = segment.slice("atlas_access_token=".length);
  expect(value.length).toBeGreaterThan(0);
  return segment;
}

function expectRedirectIsCookieOnly(location: string | undefined): void {
  expect(location).toBeDefined();
  const loc = location as string;

  // The full callback redirect must point at the portal callback page
  // and identify the provider, but it must NOT smuggle a JWT through
  // the query string.
  expect(loc.startsWith(`${FRONTEND_ORIGIN}/auth/callback`)).toBe(true);

  const url = new URL(loc);
  expect(url.searchParams.get("provider")).toBe("twitter");

  // SECURITY ASSERTION (C-5): no JWT-bearing query parameters.
  expect(url.searchParams.has("token")).toBe(false);
  expect(url.searchParams.has("access_token")).toBe(false);
  expect(url.searchParams.has("jwt")).toBe(false);

  // Belt-and-braces: the literal substring `token=` must not appear,
  // even URL-encoded, anywhere in the redirect target.
  expect(loc).not.toMatch(/[?&]token=/);
  expect(loc).not.toMatch(/[?&]access_token=/);
}

// ── Tests ──────────────────────────────────────────────────────────

describe("C-5: X OAuth cookie-only auth flow (regression guard)", () => {
  describe("GET /api/auth/twitter/callback", () => {
    it("redirect carries provider=twitter only and no JWT in query", async () => {
      const state = await primeLoginFlowAndGetState();

      const res = await request(app)
        .get("/api/auth/twitter/callback")
        .query({ code: "oauth-code", state })
        .redirects(0);

      expect(res.status).toBe(302);
      expectRedirectIsCookieOnly(res.headers.location);
    });

    it("sets HttpOnly atlas_access_token cookie on the callback response", async () => {
      const state = await primeLoginFlowAndGetState();

      const res = await request(app)
        .get("/api/auth/twitter/callback")
        .query({ code: "oauth-code", state })
        .redirects(0);

      expect(res.status).toBe(302);
      expectHttpOnlyAccessTokenCookie(res.headers["set-cookie"] as unknown as string[]);
    });

    it("protected /api/auth/me accepts the callback cookie alone (no Authorization header)", async () => {
      const state = await primeLoginFlowAndGetState();

      const callbackRes = await request(app)
        .get("/api/auth/twitter/callback")
        .query({ code: "oauth-code", state })
        .redirects(0);

      expect(callbackRes.status).toBe(302);
      const cookieSegment = expectHttpOnlyAccessTokenCookie(
        callbackRes.headers["set-cookie"] as unknown as string[],
      );

      const meRes = await request(app)
        .get("/api/auth/me")
        .set("Cookie", cookieSegment);

      expect(meRes.status).toBe(200);
      expect(meRes.body?.ok).toBe(true);
      expect(meRes.body?.data?.user?.id).toBe(TEST_USER_ID);
    });

    it("protected /api/auth/me rejects when no cookie is sent", async () => {
      const meRes = await request(app).get("/api/auth/me");
      // Auth middleware returns 401 with { error: "Missing authorization token" }
      expect(meRes.status).toBe(401);
      expect(meRes.body?.error).toBeTruthy();
    });
  });

  describe("GET /api/auth/x/callback (login flow branch)", () => {
    it("redirect carries provider=twitter only and no JWT in query", async () => {
      const state = await primeXLoginFlowAndGetState();

      const res = await request(app)
        .get("/api/auth/x/callback")
        .query({ code: "oauth-code", state })
        .redirects(0);

      expect(res.status).toBe(302);
      expectRedirectIsCookieOnly(res.headers.location);
    });

    it("sets HttpOnly atlas_access_token cookie on the callback response", async () => {
      const state = await primeXLoginFlowAndGetState();

      const res = await request(app)
        .get("/api/auth/x/callback")
        .query({ code: "oauth-code", state })
        .redirects(0);

      expect(res.status).toBe(302);
      expectHttpOnlyAccessTokenCookie(res.headers["set-cookie"] as unknown as string[]);
    });

    it("protected /api/auth/me accepts the callback cookie alone (no Authorization header)", async () => {
      const state = await primeXLoginFlowAndGetState();

      const callbackRes = await request(app)
        .get("/api/auth/x/callback")
        .query({ code: "oauth-code", state })
        .redirects(0);

      expect(callbackRes.status).toBe(302);
      const cookieSegment = expectHttpOnlyAccessTokenCookie(
        callbackRes.headers["set-cookie"] as unknown as string[],
      );

      const meRes = await request(app)
        .get("/api/auth/me")
        .set("Cookie", cookieSegment);

      expect(meRes.status).toBe(200);
      expect(meRes.body?.ok).toBe(true);
      expect(meRes.body?.data?.user?.id).toBe(TEST_USER_ID);
    });
  });
});
