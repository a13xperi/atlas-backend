import { Router } from "express";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { generateOAuthUrl, exchangeCodeForTokens, lookupUser } from "../lib/twitter";
import { logger } from "../lib/logger";
import { buildErrorResponse } from "../middleware/requestId";
import { success } from "../lib/response";

export const xAuthRouter = Router();

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
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { xHandle: true, xAccessToken: true, xTokenExpiresAt: true },
  });

  res.json(success({
    linked: !!user?.xAccessToken,
    xHandle: user?.xHandle || null,
    tokenExpired: user?.xTokenExpiresAt ? user.xTokenExpiresAt < new Date() : true,
  }));
});

/**
 * POST /api/auth/x/disconnect
 * Remove X account link.
 */
xAuthRouter.post("/disconnect", authenticate, async (req: AuthRequest, res) => {
  await prisma.user.update({
    where: { id: req.userId! },
    data: { xAccessToken: null, xRefreshToken: null, xTokenExpiresAt: null, xHandle: null },
  });
  res.json(success({ linked: false }));
});

// Cleanup expired pending OAuth entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingOAuth.entries()) {
    if (val.expiresAt < now) pendingOAuth.delete(key);
  }
}, 60_000);
