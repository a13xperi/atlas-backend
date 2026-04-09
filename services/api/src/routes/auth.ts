import { Router } from "express";
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
import { setAuthCookies, clearAuthCookies, getRefreshToken } from "../lib/cookies";

function signLegacyToken(userId: string): string {
  return jwt.sign({ userId }, config.JWT_SECRET, { expiresIn: "7d" });
}

export const authRouter = Router();
const authRateLimiter = rateLimit(
  config.RATE_LIMIT_AUTH_MAX_REQUESTS,
  config.RATE_LIMIT_AUTH_WINDOW_MS,
);
authRouter.use(authRateLimiter);

// --- Schemas ---

const registerSchema = z.object({
  handle: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  onboardingTrack: z.enum(["A", "B"]).optional(),
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
authRouter.post("/register", async (req, res) => {
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

    const user = await prisma.user.create({
      data: {
        supabaseId,
        handle: body.handle,
        email: body.email,
        passwordHash,
        ...(body.onboardingTrack && {
          onboardingTrack:
            body.onboardingTrack === "A" ? "TRACK_A" : "TRACK_B",
        }),
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
authRouter.post("/login", async (req, res) => {
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
          setAuthCookies(res, session.session.access_token, session.session.refresh_token);
          return res.json(success({
            user: { id: user.id, handle: user.handle, role: user.role },
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

    if (!refreshToken) {
      // For legacy JWT users: check Authorization header and re-sign
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith("Bearer ")) {
        try {
          const decoded = jwt.verify(authHeader.slice(7), config.JWT_SECRET) as { userId: string };
          const newToken = signLegacyToken(decoded.userId);
          return res.json(success({ token: newToken, refresh_token: null }));
        } catch {
          return res.status(400).json(error("Missing refresh token"));
        }
      }
      return res.status(400).json(error("Missing refresh token"));
    }

    if (!supabaseAdmin) {
      return res.status(503).json(error("Auth service unavailable"));
    }

    const { data, error: refreshError } = await supabaseAdmin.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (refreshError || !data.session) {
      clearAuthCookies(res);
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

// Logout — clear HttpOnly cookies
authRouter.post("/logout", authenticate, async (req: AuthRequest, res) => {
  try {
    emptyBodySchema.parse(req.body ?? {});

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
      include: { voiceProfile: true },
    });
    if (!user) return res.status(404).json(error("User not found"));

    res.json(success({
      user: { id: user.id, handle: user.handle, role: user.role, voiceProfile: user.voiceProfile },
    }));
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
