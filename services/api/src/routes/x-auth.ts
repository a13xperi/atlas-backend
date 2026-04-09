import { Router } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { generateOAuthUrl, exchangeCodeForTokens, lookupUser } from "../lib/twitter";
import { logger } from "../lib/logger";
import { error } from "../lib/response";
import { buildErrorResponse } from "../middleware/requestId";
import { success } from "../lib/response";
import { config } from "../lib/config";
import { rateLimit } from "../middleware/rateLimit";

export const xAuthRouter = Router();
xAuthRouter.use(rateLimit(20, 60 * 1000)); // 20 req/min for auth routes

// In-memory store for PKCE code verifiers (keyed by state)
// In production, use Redis. This works for single-instance deploys.
const pendingOAuth = new Map<string, { codeVerifier: string; userId: string; expiresAt: number }>();

/**
 * POST /api/auth/x/authorize
 * Returns the X OAuth consent URL. Frontend redirects the user there.
 */
xAuthRouter.post("/authorize", authenticate, async (req: AuthRequest, res) => {
  try {
    const state = `atlas_${req.userId}_${Date.now()}`;
    const { url, codeVerifier } = generateOAuthUrl(state);

    // Store code verifier for callback (expires in 10 minutes)
    pendingOAuth.set(state, {
      codeVerifier,
      userId: req.userId!,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    res.json(success({ url, state }));
  } catch (err: any) {
    logger.error({ err: err.message }, "X OAuth authorize failed");
    res.status(500).json(buildErrorResponse(req, "Failed to generate X authorization URL"));
  }
});

/**
 * GET /api/auth/x/login
 * Unauthenticated entry point for "Sign in with X".
 * Generates an OAuth URL with a login-flow sentinel and redirects to X.
 */
xAuthRouter.get("/login", async (req, res) => {
  try {
    const state = `atlas_login_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const { url, codeVerifier } = generateOAuthUrl(state);

    pendingOAuth.set(state, {
      codeVerifier,
      userId: "login",
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    res.redirect(url);
  } catch (err: any) {
    logger.error({ err: err.message }, "X OAuth login redirect failed");
    const frontendUrl = config.FRONTEND_URL.split(",")[0].trim();
    res.redirect(`${frontendUrl}/auth/callback?error=auth_failed`);
  }
});

/**
 * GET /api/auth/x/callback
 * X redirects the user back here after consent (login flow).
 * Exchanges the code, finds-or-creates a user, signs a JWT, and
 * redirects to the frontend /auth/callback with the token.
 */
xAuthRouter.get("/callback", async (req, res) => {
  const frontendUrl = config.FRONTEND_URL.split(",")[0].trim();
  try {
    const { code, state } = req.query;

    if (!code || !state) {
      return res.redirect(`${frontendUrl}/auth/callback?error=missing_params`);
    }

    const pending = pendingOAuth.get(state as string);
    if (!pending || pending.expiresAt < Date.now()) {
      pendingOAuth.delete(state as string);
      return res.redirect(`${frontendUrl}/auth/callback?error=session_expired`);
    }

    // Reject link-flow states — those go through POST /callback after auth
    if (pending.userId !== "login") {
      return res.redirect(`${frontendUrl}/auth/callback?error=invalid_state`);
    }

    pendingOAuth.delete(state as string);

    const { accessToken, refreshToken, expiresIn } = await exchangeCodeForTokens(
      code as string,
      pending.codeVerifier,
    );

    const meRes = await fetch("https://api.twitter.com/2/users/me?user.fields=profile_image_url,name", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const meData = (await meRes.json()) as {
      data: { username: string; name: string; profile_image_url?: string };
    };
    const xHandle = meData.data.username;
    const displayName = meData.data.name;
    const avatarUrl = meData.data.profile_image_url?.replace("_normal", "_400x400") || null;

    let user = await prisma.user.findFirst({ where: { xHandle } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          handle: xHandle,
          xHandle,
          displayName,
          avatarUrl,
          xAccessToken: accessToken,
          xRefreshToken: refreshToken,
          xTokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
          voiceProfile: { create: {} },
        },
      });
    } else {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          xAccessToken: accessToken,
          xRefreshToken: refreshToken,
          xTokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
          ...(displayName && !user.displayName && { displayName }),
          ...(avatarUrl && !user.avatarUrl && { avatarUrl }),
        },
      });
    }

    const token = jwt.sign({ userId: user.id }, config.JWT_SECRET, { expiresIn: "7d" });

    logger.info({ userId: user.id, xHandle }, "X login successful");
    return res.redirect(
      `${frontendUrl}/auth/callback?token=${encodeURIComponent(token)}&provider=twitter`,
    );
  } catch (err: any) {
    logger.error({ err: err.message }, "X OAuth login callback failed");
    return res.redirect(`${frontendUrl}/auth/callback?error=auth_failed`);
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
    const pending = pendingOAuth.get(state);
    if (!pending || pending.expiresAt < Date.now()) {
      pendingOAuth.delete(state);
      return res.status(400).json(buildErrorResponse(req, "OAuth session expired. Please try again."));
    }
    if (pending.userId !== req.userId) {
      return res.status(403).json(buildErrorResponse(req, "OAuth state mismatch"));
    }
    pendingOAuth.delete(state);

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


// Cleanup expired pending OAuth entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingOAuth.entries()) {
    if (val.expiresAt < now) pendingOAuth.delete(key);
  }
}, 60_000);
