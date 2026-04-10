import { Router } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { generateOAuthUrl, generateLoginOAuthUrl, exchangeCodeForTokens, exchangeLoginCodeForTokens, lookupUser, fetchTwitterUserProfile } from "../lib/twitter";
import { config } from "../lib/config";
import { logger } from "../lib/logger";
import { error } from "../lib/response";
import { buildErrorResponse } from "../middleware/requestId";
import { success } from "../lib/response";
import { setAuthCookies } from "../lib/cookies";
import { getCached, setCache, delCache } from "../lib/redis";

export const xAuthRouter = Router();

// ── PKCE state storage ─────────────────────────────────────────────
// Primary: Redis (survives multi-instance deploys on Railway)
// Fallback: in-memory Map (dev mode / Redis unavailable)

interface PendingOAuthData {
  codeVerifier: string;
  userId: string;
  flow: "link" | "login";
  expiresAt: number;
}

const PKCE_TTL_SECONDS = 600; // 10 minutes
const PKCE_KEY_PREFIX = "oauth:pkce:";

const localPending = new Map<string, PendingOAuthData>();

async function setPendingOAuth(state: string, data: PendingOAuthData): Promise<void> {
  // Always write to local Map as fallback
  localPending.set(state, data);
  // Attempt Redis — TTL handles expiry automatically
  await setCache(`${PKCE_KEY_PREFIX}${state}`, JSON.stringify(data), PKCE_TTL_SECONDS);
}

async function getPendingOAuth(state: string): Promise<PendingOAuthData | null> {
  // Try Redis first (works across instances)
  const raw = await getCached(`${PKCE_KEY_PREFIX}${state}`);
  if (raw) {
    try {
      await delCache(`${PKCE_KEY_PREFIX}${state}`);
      localPending.delete(state);
      return JSON.parse(raw) as PendingOAuthData;
    } catch {
      // Parse failed — fall through to local
    }
  }
  // Fallback to local Map
  const local = localPending.get(state) ?? null;
  if (local) localPending.delete(state);
  return local;
}

/**
 * POST /api/auth/x/authorize
 * Returns the X OAuth consent URL. Frontend redirects the user there.
 */
xAuthRouter.post("/authorize", authenticate, async (req: AuthRequest, res) => {
  try {
    const state = `atlas_${req.userId}_${Date.now()}`;
    const { url, codeVerifier } = generateOAuthUrl(state);

    // Store code verifier for callback (expires in 10 minutes)
    await setPendingOAuth(state, {
      codeVerifier,
      userId: req.userId!,
      flow: "link",
      expiresAt: Date.now() + PKCE_TTL_SECONDS * 1000,
    });

    res.json(success({ url, state }));
  } catch (err: any) {
    logger.error({ err: err.message }, "X OAuth authorize failed");
    res.status(500).json(buildErrorResponse(req, "Failed to generate X authorization URL"));
  }
});

/**
 * GET /api/auth/x/callback
 * X redirects here after user authorizes (login flow).
 * Detects login vs link flow by state prefix.
 */
xAuthRouter.get("/callback", async (req, res) => {
  const frontendUrl = config.FRONTEND_URL.split(",")[0].trim();

  try {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      return res.redirect(`${frontendUrl}/login?error=access_denied`);
    }
    if (!code || !state || typeof code !== "string" || typeof state !== "string") {
      return res.redirect(`${frontendUrl}/login?error=missing_params`);
    }

    const pending = await getPendingOAuth(state);
    if (!pending || pending.expiresAt < Date.now()) {
      return res.redirect(`${frontendUrl}/login?error=session_expired`);
    }

    // Only handle login flow here — link flow uses POST
    if (pending.flow !== "login") {
      return res.redirect(`${frontendUrl}/login?error=invalid_flow`);
    }

    const { accessToken, refreshToken, expiresIn } = await exchangeCodeForTokens(code, pending.codeVerifier);

    const profile = await fetchTwitterUserProfile(accessToken);
    const xHandle = profile.username;
    const displayName = profile.name;
    const avatarUrl = profile.profile_image_url || null;
    const xBio = profile.description ?? null;
    const xAvatarUrl = profile.profile_image_url ?? null;
    const xFollowerCount = profile.public_metrics?.followers_count ?? null;

    let user = await prisma.user.findFirst({ where: { xHandle } });

    if (user) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          xAccessToken: accessToken,
          xRefreshToken: refreshToken,
          xTokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
          displayName: displayName || user.displayName,
          avatarUrl: avatarUrl || user.avatarUrl,
          xBio: xBio ?? user.xBio,
          xAvatarUrl: xAvatarUrl ?? user.xAvatarUrl,
          xFollowerCount: xFollowerCount ?? user.xFollowerCount,
        },
      });
      logger.info({ userId: user.id, xHandle }, "Twitter login — returning user");
    } else {
      user = await prisma.user.create({
        data: {
          handle: xHandle,
          displayName,
          avatarUrl,
          xHandle,
          xAccessToken: accessToken,
          xRefreshToken: refreshToken,
          xTokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
          xBio,
          xAvatarUrl,
          xFollowerCount,
          onboardingTrack: "TRACK_B",
          voiceProfile: { create: {} },
        },
      });
      logger.info({ userId: user.id, xHandle }, "Twitter login — new user created");
    }

    const token = signLoginToken(user.id);
    setAuthCookies(res, token, refreshToken);
    res.redirect(`${frontendUrl}/auth/callback?token=${encodeURIComponent(token)}&provider=twitter`);
  } catch (err: any) {
    logger.error({ err: err.message, stack: err.stack }, "Twitter login callback failed");
    res.redirect(`${frontendUrl}/login?error=callback_failed`);
  }
});

/**
 * POST /api/auth/x/callback
 * Frontend sends the code + state after X redirects back.
 */
xAuthRouter.post("/callback", authenticate, async (req: AuthRequest, res) => {
  try {
    const { code, state } = req.body;
    if (!code || !state) {
      return res.status(400).json(buildErrorResponse(req, "Missing code or state"));
    }

    // Retrieve and validate PKCE verifier
    const pending = await getPendingOAuth(state);
    if (!pending || pending.expiresAt < Date.now()) {
      return res.status(400).json(buildErrorResponse(req, "OAuth session expired. Please try again."));
    }
    if (pending.userId !== req.userId) {
      return res.status(403).json(buildErrorResponse(req, "OAuth state mismatch"));
    }

    // Exchange code for tokens
    const { accessToken, refreshToken, expiresIn } = await exchangeCodeForTokens(code, pending.codeVerifier);

    // Look up the user's X handle
    let xHandle: string | undefined;
    try {
      const meRes = await fetch("https://api.twitter.com/2/users/me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (meRes.ok) {
        const meData = await meRes.json() as { data: { username: string } };
        xHandle = meData.data.username;
      }
    } catch {
      // Non-critical — we can proceed without the handle
    }

    // Store tokens on the user
    await prisma.user.update({
      where: { id: req.userId! },
      data: {
        xAccessToken: accessToken,
        xRefreshToken: refreshToken,
        xTokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
        ...(xHandle && { xHandle }),
      },
    });

    logger.info({ userId: req.userId, xHandle }, "X account linked");
    res.json(success({ linked: true, xHandle: xHandle || null }));
  } catch (err: any) {
    logger.error({ err: err.message }, "X OAuth callback failed");
    res.status(500).json(buildErrorResponse(req, "Failed to link X account"));
  }
});

/**
 * GET /api/auth/x/status
 * Check if the user has linked their X account.
 */
xAuthRouter.get("/status", authenticate, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { xHandle: true, xAccessToken: true, xTokenExpiresAt: true },
    });

    res.json(success({
      linked: !!user?.xAccessToken,
      xHandle: user?.xHandle || null,
      tokenExpired: user?.xTokenExpiresAt ? user.xTokenExpiresAt < new Date() : true,
    }));
  } catch (err: any) {
    logger.error({ err: err.message }, "X auth status check failed");
    res.status(500).json(error("Failed to check X auth status"));
  }
});

/**
 * POST /api/auth/x/disconnect
 * Remove X account link.
 */
xAuthRouter.post("/disconnect", authenticate, async (req: AuthRequest, res) => {
  try {
    await prisma.user.update({
      where: { id: req.userId! },
      data: { xAccessToken: null, xRefreshToken: null, xTokenExpiresAt: null, xHandle: null },
    });
    res.json(success({ linked: false }));
  } catch (err: any) {
    logger.error({ err: err.message }, "X auth disconnect failed");
    res.status(500).json(error("Failed to disconnect X account"));
  }
});

/**
 * GET /api/auth/x/login
 * Alias for /api/auth/twitter — lets the frontend use either path.
 */
xAuthRouter.get("/login", async (_req, res) => {
  try {
    const state = `login_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const { url, codeVerifier } = generateOAuthUrl(state);
    await setPendingOAuth(state, {
      codeVerifier,
      userId: "",
      flow: "login",
      expiresAt: Date.now() + PKCE_TTL_SECONDS * 1000,
    });
    res.redirect(url);
  } catch (err: any) {
    logger.error({ err: err.message }, "X login redirect failed");
    const frontendUrl = config.FRONTEND_URL.split(",")[0].trim();
    res.redirect(`${frontendUrl}/login?error=oauth_init_failed`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Twitter Login Flow — primary auth method (no existing auth required)
// Per DM-324: "Authorize my Twitter. Boom."
// ═══════════════════════════════════════════════════════════════════════

export const twitterLoginRouter = Router();

function signLoginToken(userId: string): string {
  return jwt.sign({ userId }, config.JWT_SECRET, { expiresIn: "7d" });
}

/**
 * GET /api/auth/twitter
 * Initiates Twitter OAuth login. Redirects user to X authorization page.
 * No authentication required — this IS the auth entry point.
 */
twitterLoginRouter.get("/", async (_req, res) => {
  try {
    const state = `login_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    // Use the existing registered callback URL (X is slow to register new ones)
    const { url, codeVerifier } = generateOAuthUrl(state);

    await setPendingOAuth(state, {
      codeVerifier,
      userId: "",
      flow: "login",
      expiresAt: Date.now() + PKCE_TTL_SECONDS * 1000,
    });

    res.redirect(url);
  } catch (err: any) {
    logger.error({ err: err.message }, "Twitter login redirect failed");
    const frontendUrl = config.FRONTEND_URL.split(",")[0].trim();
    res.redirect(`${frontendUrl}/login?error=oauth_init_failed`);
  }
});

/**
 * GET /api/auth/twitter/callback
 * X redirects here after user authorizes. Exchanges code for tokens,
 * fetches Twitter profile, finds or creates user, issues JWT,
 * and redirects to frontend with token.
 */
twitterLoginRouter.get("/callback", async (req, res) => {
  const frontendUrl = config.FRONTEND_URL.split(",")[0].trim();

  try {
    const { code, state, error: oauthError } = req.query;

    // User denied access on X
    if (oauthError) {
      logger.warn({ oauthError }, "Twitter login denied by user");
      return res.redirect(`${frontendUrl}/login?error=access_denied`);
    }

    if (!code || !state || typeof code !== "string" || typeof state !== "string") {
      return res.redirect(`${frontendUrl}/login?error=missing_params`);
    }

    // Retrieve and validate PKCE verifier
    const pending = await getPendingOAuth(state);
    if (!pending || pending.expiresAt < Date.now()) {
      return res.redirect(`${frontendUrl}/login?error=session_expired`);
    }
    if (pending.flow !== "login") {
      return res.redirect(`${frontendUrl}/login?error=invalid_flow`);
    }

    // Exchange authorization code for tokens
    const { accessToken, refreshToken, expiresIn } = await exchangeLoginCodeForTokens(code, pending.codeVerifier);

    // Fetch full Twitter profile
    const profile = await fetchTwitterUserProfile(accessToken);
    const xHandle = profile.username;
    const displayName = profile.name;
    const avatarUrl = profile.profile_image_url || null;
    const xBio = profile.description ?? null;
    const xAvatarUrl = profile.profile_image_url ?? null;
    const xFollowerCount = profile.public_metrics?.followers_count ?? null;

    // Find existing user by xHandle, or create new one
    let user = await prisma.user.findFirst({ where: { xHandle } });

    if (user) {
      // Returning user — update tokens + profile data
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          xAccessToken: accessToken,
          xRefreshToken: refreshToken,
          xTokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
          displayName: displayName || user.displayName,
          avatarUrl: avatarUrl || user.avatarUrl,
          xBio: xBio ?? user.xBio,
          xAvatarUrl: xAvatarUrl ?? user.xAvatarUrl,
          xFollowerCount: xFollowerCount ?? user.xFollowerCount,
        },
      });
      logger.info({ userId: user.id, xHandle }, "Twitter login — returning user");
    } else {
      // New user — create from Twitter profile
      user = await prisma.user.create({
        data: {
          handle: xHandle,
          displayName,
          avatarUrl,
          xHandle,
          xAccessToken: accessToken,
          xRefreshToken: refreshToken,
          xTokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
          xBio,
          xAvatarUrl,
          xFollowerCount,
          onboardingTrack: "TRACK_B", // Twitter-first = Track B (Anil's flow)
          voiceProfile: { create: {} },
        },
      });
      logger.info({ userId: user.id, xHandle }, "Twitter login — new user created");
    }

    // Issue JWT and set cookies
    const token = signLoginToken(user.id);
    setAuthCookies(res, token, refreshToken);

    // Redirect to frontend with token in query (frontend stores it)
    res.redirect(`${frontendUrl}/auth/callback?token=${encodeURIComponent(token)}&provider=twitter`);
  } catch (err: any) {
    logger.error({ err: err.message, stack: err.stack }, "Twitter login callback failed");
    res.redirect(`${frontendUrl}/login?error=callback_failed`);
  }
});
