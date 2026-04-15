import { Router } from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma";
import { supabaseAdmin } from "../lib/supabase";
import { config } from "../lib/config";
import { logger } from "../lib/logger";
import { error, success } from "../lib/response";
import { authenticate, AuthRequest } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import {
  setAuthCookies,
  clearAuthCookies,
  getRefreshToken,
  getAccessToken,
} from "../lib/cookies";
import { normalizeOnboardingTrack } from "../lib/onboardingTrack";
import { revokeJti, remainingTtlSeconds, isJtiRevoked } from "../lib/jwt-revocation";

function signLegacyToken(userId: string): string {
  // C-6: every issued token carries a UUID `jti` so it can be individually
  // revoked via the Redis blacklist on logout (see lib/jwt-revocation.ts).
  const jti = randomUUID();
  return jwt.sign({ userId, jti }, config.JWT_SECRET, { expiresIn: "7d" });
}

export const authRouter: Router = Router();
const authRateLimiter = rateLimit(
  config.RATE_LIMIT_AUTH_MAX_REQUESTS,
  config.RATE_LIMIT_AUTH_WINDOW_MS,
);
authRouter.use(authRateLimiter);

// Stricter per-route limiters layered on top of authRateLimiter. Each uses
// a distinct namespace so its counter doesn't collide with the router-level
// limiter (same-namespace limiters would share a key and the tighter window
// would be silently overridden by the wider window).
const registerRateLimiter = rateLimit(
  config.RATE_LIMIT_REGISTER_MAX_REQUESTS,
  config.RATE_LIMIT_REGISTER_WINDOW_MS,
  "register",
);
const loginRateLimiter = rateLimit(
  config.RATE_LIMIT_LOGIN_MAX_REQUESTS,
  config.RATE_LIMIT_LOGIN_WINDOW_MS,
  "login",
);

// --- Schemas ---

const registerSchema = z.object({
  handle: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  // Accept any string — normalized downstream via normalizeOnboardingTrack().
  // This keeps register lenient for legacy/alt frontends that may send
  // "a" / "track_a" instead of the canonical "TRACK_A".
  onboardingTrack: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refresh_token: z.string().min(1).optional(),
});

const emptyBodySchema = z.object({}).passthrough();

const linkAccountSchema = z.object({
  handle: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
});

// --- Routes ---

// Register — Supabase auth with legacy bcrypt fallback
authRouter.post("/register", registerRateLimiter, async (req, res) => {
  try {
    const body = registerSchema.parse(req.body);

    const existingHandle = await prisma.user.findUnique({ where: { handle: body.handle } });
    if (existingHandle) return res.status(409).json(error("Handle already taken"));

    const existingEmail = await prisma.user.findUnique({ where: { email: body.email } });
    if (existingEmail) return res.status(409).json(error("Email already registered"));

    let supabaseId: string | undefined;
    let token: string;
    let refreshToken: string | undefined;

    // Try Supabase auth first
    if (supabaseAdmin) {
      const { data: supabaseUser, error: createError } =
        await supabaseAdmin.auth.admin.createUser({
          email: body.email,
          password: body.password,
          email_confirm: true,
        });

      if (!createError && supabaseUser.user) {
        supabaseId = supabaseUser.user.id;

        // Sign in to get Supabase tokens
        const { data: session } = await supabaseAdmin.auth.signInWithPassword({
          email: body.email,
          password: body.password,
        });

        if (session?.session) {
          token = session.session.access_token;
          refreshToken = session.session.refresh_token;
        }
      } else {
        logger.warn({ err: createError?.message }, "Supabase createUser failed, using legacy auth");
      }
    }

    // Hash password for legacy fallback (always store for dual-mode support)
    const passwordHash = await bcrypt.hash(body.password, 10);

    const normalizedTrack = normalizeOnboardingTrack(body.onboardingTrack);
    const user = await prisma.user.create({
      data: {
        supabaseId,
        handle: body.handle,
        email: body.email,
        passwordHash,
        ...(normalizedTrack && { onboardingTrack: normalizedTrack }),
        voiceProfile: { create: {} },
      },
      include: { voiceProfile: true },
    });

    // If no Supabase token, generate legacy JWT
    if (!token!) {
      token = signLegacyToken(user.id);
    }

    if (refreshToken) {
      setAuthCookies(res, token, refreshToken);
    }

    res.json(success({
      user: { id: user.id, handle: user.handle, role: user.role },
      token,
      refresh_token: refreshToken || null,
    }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    logger.error({ err: err.message }, "Register error");
    res.status(500).json(error("Registration failed"));
  }
});

// Login — Supabase auth with legacy bcrypt fallback
authRouter.post("/login", loginRateLimiter, async (req, res) => {
  try {
    const body = loginSchema.parse(req.body);

    // Path 1: Try Supabase auth
    if (supabaseAdmin) {
      const { data: session, error: signInError } = await supabaseAdmin.auth.signInWithPassword({
        email: body.email,
        password: body.password,
      });

      if (!signInError && session.session) {
        let user = await prisma.user.findFirst({ where: { supabaseId: session.user.id } });

        // Lazy migration: link by email if supabaseId not set
        if (!user) {
          user = await prisma.user.findUnique({ where: { email: body.email } });
          if (user && !user.supabaseId) {
            user = await prisma.user.update({
              where: { id: user.id },
              data: { supabaseId: session.user.id },
            });
          }
        }

        if (user) {
          // Re-fetch with explicit select so lazy-migration update doesn't
          // slip through with a stale user object missing onboardingTrack.
          // SAFE WHITELIST — never expose passwordHash, xAccessToken*,
          // xRefreshToken*, supabaseId, email, or telegramChatId to clients.
          const freshUser = await prisma.user.findUnique({
            where: { id: user.id },
            select: {
              id: true,
              handle: true,
              role: true,
              onboardingTrack: true,
              displayName: true,
              avatarUrl: true,
              xHandle: true,
              xBio: true,
              xAvatarUrl: true,
              xFollowerCount: true,
              tourCompleted: true,
              tourStep: true,
              createdAt: true,
              updatedAt: true,
              voiceProfile: { select: { id: true, userId: true } },
            },
          });
          if (!freshUser) return res.status(500).json(error("User not found after login"));
          setAuthCookies(res, session.session.access_token, session.session.refresh_token);
          return res.json(success({
            user: freshUser,
            token: session.session.access_token,
            refresh_token: session.session.refresh_token,
          }));
        }
      }
      // Supabase failed — fall through to legacy path
    }

    // Path 2: Legacy bcrypt + JWT fallback
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user) {
      return res.status(401).json(error("Invalid credentials"));
    }

    if (!user.passwordHash) {
      return res
        .status(401)
        .json(error("Invalid credentials. Try registering with email + password."));
    }

    const valid = await bcrypt.compare(body.password, user.passwordHash);
    if (!valid) {
      return res.status(401).json(error("Invalid credentials"));
    }

    const token = signLegacyToken(user.id);
    res.json(success({
      user: { id: user.id, handle: user.handle, role: user.role },
      token,
      refresh_token: null,
    }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    logger.error({ err: err.message }, "Login error:", err.message);
    res.status(500).json(error("Login failed"));
  }
});

// Refresh token — Supabase refresh with legacy JWT re-sign fallback
authRouter.post("/refresh", async (req, res) => {
  try {
    const cookieRefresh = getRefreshToken(req);
    const body = refreshSchema.parse(req.body ?? {});
    const bodyRefresh = body.refresh_token;
    const refreshToken = cookieRefresh || bodyRefresh;

    // Step 1: if the access token is a legacy JWT we issued, re-sign it.
    // Twitter-OAuth sessions store a Twitter OAuth refresh token in
    // atlas_refresh_token which is NOT a Supabase refresh token. Never pass
    // it to supabaseAdmin.auth.refreshSession.
    const accessToken = getAccessToken(req);
    if (accessToken) {
      try {
        const decoded = jwt.verify(accessToken, config.JWT_SECRET) as {
          userId: string;
          jti?: string;
        };
        if (decoded.jti && (await isJtiRevoked(decoded.jti))) {
          return res.status(401).json(error("Invalid or expired token"));
        }
        const newToken = signLegacyToken(decoded.userId);
        setAuthCookies(res, newToken, refreshToken ?? "");
        return res.json(success({ token: newToken, refresh_token: refreshToken ?? null }));
      } catch {
        // Not a legacy JWT — fall through to Supabase refresh.
      }
    }

    // Step 2: no refresh token — try legacy header re-sign.
    if (!refreshToken) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith("Bearer ")) {
        try {
          const decoded = jwt.verify(authHeader.slice(7), config.JWT_SECRET) as {
            userId: string;
            jti?: string;
          };
          if (decoded.jti && (await isJtiRevoked(decoded.jti))) {
            return res.status(401).json(error("Invalid or expired token"));
          }
          const newToken = signLegacyToken(decoded.userId);
          return res.json(success({ token: newToken, refresh_token: null }));
        } catch {
          return res.status(400).json(error("Missing refresh token"));
        }
      }
      return res.status(400).json(error("Missing refresh token"));
    }

    // Step 3: Supabase refresh — only if access token is NOT a legacy JWT.
    if (!supabaseAdmin) {
      return res.status(503).json(error("Auth service unavailable"));
    }

    const { data, error: refreshError } = await supabaseAdmin.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (refreshError || !data.session) {
      // Do NOT clearAuthCookies — the cookie may still be a valid Twitter OAuth token.
      return res.status(401).json(error("Invalid refresh token"));
    }

    setAuthCookies(res, data.session.access_token, data.session.refresh_token);
    res.json(success({
      token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Token refresh failed"));
  }
});

// Link account — migrate existing handle-only users to Supabase
authRouter.post("/link-account", async (req, res) => {
  try {
    const body = linkAccountSchema.parse(req.body);

    if (!supabaseAdmin) {
      return res.status(503).json(error("Auth service unavailable"));
    }

    const user = await prisma.user.findUnique({ where: { handle: body.handle } });
    if (!user) return res.status(404).json(error("No account found with this handle"));
    if (user.supabaseId) return res.status(409).json(error("Account already linked"));

    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: body.email,
      password: body.password,
      email_confirm: true,
    });

    if (authError) {
      logger.error({ err: authError.message }, "Supabase createUser error:", authError.message);
      return res
        .status(500)
        .json(error("Failed to create auth account", 500, { message: authError.message }));
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { supabaseId: authData.user.id, email: body.email },
    });

    res.json(success({ message: "Account linked. You can now log in with email + password." }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    logger.error({ err: err.message }, "Link account error:", err.message);
    res.status(500).json(error("Account linking failed"));
  }
});

// Logout — revoke jti, then clear HttpOnly cookies
authRouter.post("/logout", authenticate, async (req: AuthRequest, res) => {
  try {
    emptyBodySchema.parse(req.body ?? {});

    // C-6 NOTE: Do NOT call supabaseAdmin.auth.admin.signOut(supabaseId, "global") here.
    // PR #204 tried this and broke login in prod (reverted in #214): admin.signOut invalidates
    // the Supabase session; on Twitter-OAuth re-login the freshly issued token's iat can land
    // within the same second as tokensInvalidatedBefore, rejecting valid logins.
    // Per-jti revocation via Redis is sufficient and race-free.
    // C-6: insert this token's jti into the Redis blacklist with a TTL
    // equal to the token's remaining lifetime, so any concurrent
    // session/tab using the same JWT is rejected on its next request.
    // We decode (not verify) here because authenticate() already proved
    // the signature is valid by getting us into this handler.
    const token = getAccessToken(req);
    if (token) {
      const decoded = jwt.decode(token) as { jti?: string; exp?: number } | null;
      if (decoded?.jti) {
        const ttl = remainingTtlSeconds(decoded.exp);
        if (ttl > 0) {
          try {
            await revokeJti(decoded.jti, ttl);
          } catch (err: any) {
            logger.warn({ jti: decoded.jti.slice(0, 8), err: err?.message }, "Redis unavailable — jti revocation skipped");
          }
        }
      }
    }

    clearAuthCookies(res);
    res.json(success({ success: true }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Logout failed"));
  }
});

// Get current user
authRouter.get("/me", authenticate, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        handle: true,
        role: true,
        onboardingTrack: true,
        xBio: true,
        xAvatarUrl: true,
        xFollowerCount: true,
        voiceProfile: true,
      },
    });
    if (!user) return res.status(404).json(error("User not found"));

    const { xAvatarUrl, ...rest } = user;
    res.json(success({ user: { ...rest, avatarUrl: xAvatarUrl } }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Me error:", err.message);
    res.status(500).json(error("Failed to get user"));
  }
});

// [DEPRECATED] List active sessions
authRouter.get("/sessions", authenticate, async (req: AuthRequest, res) => {
  try {
    const sessions = await prisma.session.findMany({
      where: { userId: req.userId, expiresAt: { gt: new Date() } },
      select: { id: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(success({ sessions }));
  } catch (err: any) {
    res.status(500).json(error("Failed to list sessions"));
  }
});

// [DEPRECATED] Revoke a session
authRouter.delete("/sessions/:id", authenticate, async (req: AuthRequest, res) => {
  try {
    const sessionId = req.params.id as string;
    const session = await prisma.session.findFirst({
      where: { id: sessionId, userId: req.userId },
    });
    if (!session) return res.status(404).json(error("Session not found"));

    await prisma.session.delete({ where: { id: sessionId } });
    res.json(success({ success: true }));
  } catch (err: any) {
    res.status(500).json(error("Failed to revoke session"));
  }
});
