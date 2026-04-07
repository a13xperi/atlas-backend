import { Router } from "express";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { generateOAuthUrl, exchangeCodeForTokens, lookupUser } from "../lib/twitter";
import { logger } from "../lib/logger";
import { error } from "../lib/response";
import { buildErrorResponse } from "../middleware/requestId";
import { success } from "../lib/response";
import { getCached, setCache, delCache } from "../lib/redis";

export const xAuthRouter = Router();

// ── PKCE state storage ─────────────────────────────────────────────
// Primary: Redis (survives multi-instance deploys on Railway)
// Fallback: in-memory Map (dev mode / Redis unavailable)

interface PendingOAuthData {
  codeVerifier: string;
  userId: string;
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
      expiresAt: Date.now() + PKCE_TTL_SECONDS * 1000,
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


