import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { supabaseAdmin } from "../lib/supabase";
import { authenticate, AuthRequest } from "../middleware/auth";
import { buildErrorResponse } from "../middleware/requestId";
import { rateLimit } from "../middleware/rateLimit";
import { setAuthCookies, clearAuthCookies, getRefreshToken } from "../lib/cookies";

export const authRouter = Router();

// Rate limits: 5 login attempts/min, 3 registrations/min per IP
const loginLimiter = rateLimit(5, 60 * 1000);
const registerLimiter = rateLimit(3, 60 * 1000);

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
  refresh_token: z.string().min(1),
});

const linkAccountSchema = z.object({
  handle: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
});

// --- Routes ---

// Register — create Supabase auth user + Prisma user, return session
authRouter.post("/register", registerLimiter, async (req, res) => {
  try {
    const body = registerSchema.parse(req.body);

    if (!supabaseAdmin) {
      return res.status(503).json(buildErrorResponse(req, "Auth service unavailable"));
    }

    const existingHandle = await prisma.user.findUnique({ where: { handle: body.handle } });
    if (existingHandle) return res.status(409).json(buildErrorResponse(req, "Handle already taken"));

    const existingEmail = await prisma.user.findUnique({ where: { email: body.email } });
    if (existingEmail) return res.status(409).json(buildErrorResponse(req, "Email already registered"));

    // Create Supabase auth user
    const { data: supabaseUser, error: createError } =
      await supabaseAdmin.auth.admin.createUser({
        email: body.email,
        password: body.password,
        email_confirm: true,
      });

    if (createError || !supabaseUser.user) {
      console.error("Supabase createUser error:", createError);
      return res.status(400).json(buildErrorResponse(req, createError?.message || "Failed to create auth user"));
    }

    // Create Prisma user linked to Supabase
    const user = await prisma.user.create({
      data: {
        supabaseId: supabaseUser.user.id,
        handle: body.handle,
        email: body.email,
        onboardingTrack:
          body.onboardingTrack === "A"
            ? "TRACK_A"
            : body.onboardingTrack === "B"
              ? "TRACK_B"
              : undefined,
        voiceProfile: { create: {} },
      },
      include: { voiceProfile: true },
    });

    // Sign in to get tokens
    const { data: session, error: signInError } =
      await supabaseAdmin.auth.signInWithPassword({
        email: body.email,
        password: body.password,
      });

    if (signInError || !session.session) {
      console.error("Sign-in after register failed:", signInError);
      return res.status(201).json({
        user: { id: user.id, handle: user.handle, role: user.role },
        token: null,
        message: "Account created. Please log in.",
      });
    }

    setAuthCookies(res, session.session.access_token, session.session.refresh_token);
    res.json({
      user: { id: user.id, handle: user.handle, role: user.role },
      token: session.session.access_token,
      refresh_token: session.session.refresh_token,
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    console.error("Register error:", err.message);
    res.status(500).json(buildErrorResponse(req, "Registration failed"));
  }
});

// Login — authenticate via Supabase, return session
authRouter.post("/login", loginLimiter, async (req, res) => {
  try {
    const body = loginSchema.parse(req.body);

    if (!supabaseAdmin) {
      return res.status(503).json(buildErrorResponse(req, "Auth service unavailable"));
    }

    const { data: session, error } = await supabaseAdmin.auth.signInWithPassword({
      email: body.email,
      password: body.password,
    });

    if (error || !session.session) {
      return res.status(401).json(buildErrorResponse(req, "Invalid credentials"));
    }

    // Resolve Prisma user
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

    if (!user) {
      return res.status(404).json(buildErrorResponse(req, "No account found. Please register first."));
    }

    setAuthCookies(res, session.session.access_token, session.session.refresh_token);
    res.json({
      user: { id: user.id, handle: user.handle, role: user.role },
      token: session.session.access_token,
      refresh_token: session.session.refresh_token,
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    console.error("Login error:", err.message);
    res.status(500).json(buildErrorResponse(req, "Login failed", {}));
  }
});

// Refresh token — reads from cookie first, falls back to request body
authRouter.post("/refresh", async (req, res) => {
  try {
    const cookieRefresh = getRefreshToken(req);
    const bodyRefresh = req.body?.refresh_token;
    const refreshToken = cookieRefresh || bodyRefresh;

    if (!refreshToken) {
      return res.status(400).json(buildErrorResponse(req, "Missing refresh token"));
    }

    if (!supabaseAdmin) {
      return res.status(503).json(buildErrorResponse(req, "Auth service unavailable"));
    }

    const { data, error } = await supabaseAdmin.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error || !data.session) {
      clearAuthCookies(res);
      return res.status(401).json(buildErrorResponse(req, "Invalid refresh token"));
    }

    setAuthCookies(res, data.session.access_token, data.session.refresh_token);
    res.json({
      token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
  } catch (err: any) {
    res.status(500).json(buildErrorResponse(req, "Token refresh failed"));
  }
});

// Link account — migrate existing handle-only users to Supabase
authRouter.post("/link-account", async (req, res) => {
  try {
    const body = linkAccountSchema.parse(req.body);

    if (!supabaseAdmin) {
      return res.status(503).json(buildErrorResponse(req, "Auth service unavailable"));
    }

    const user = await prisma.user.findUnique({ where: { handle: body.handle } });
    if (!user) return res.status(404).json(buildErrorResponse(req, "No account found with this handle"));
    if (user.supabaseId) return res.status(409).json(buildErrorResponse(req, "Account already linked"));

    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: body.email,
      password: body.password,
      email_confirm: true,
    });

    if (authError) {
      console.error("Supabase createUser error:", authError.message);
      return res.status(500).json(buildErrorResponse(req, "Failed to create auth account", { message: authError.message }));
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { supabaseId: authData.user.id, email: body.email },
    });

    res.json({ message: "Account linked. You can now log in with email + password." });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    console.error("Link account error:", err.message);
    res.status(500).json(buildErrorResponse(req, "Account linking failed", {}));
  }
});

// Logout — clear HttpOnly cookies
authRouter.post("/logout", authenticate, async (_req: AuthRequest, res) => {
  clearAuthCookies(res);
  res.json({ success: true });
});

// Get current user
authRouter.get("/me", authenticate, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      include: { voiceProfile: true },
    });
    if (!user) return res.status(404).json(buildErrorResponse(req, "User not found"));

    res.json({
      user: { id: user.id, handle: user.handle, role: user.role, voiceProfile: user.voiceProfile },
    });
  } catch (err: any) {
    console.error("Me error:", err.message);
    res.status(500).json(buildErrorResponse(req, "Failed to get user", {}));
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
    res.json({ sessions });
  } catch (err: any) {
    res.status(500).json(buildErrorResponse(req, "Failed to list sessions", {}));
  }
});

// [DEPRECATED] Revoke a session
authRouter.delete("/sessions/:id", authenticate, async (req: AuthRequest, res) => {
  try {
    const sessionId = req.params.id as string;
    const session = await prisma.session.findFirst({
      where: { id: sessionId, userId: req.userId },
    });
    if (!session) return res.status(404).json(buildErrorResponse(req, "Session not found"));

    await prisma.session.delete({ where: { id: sessionId } });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json(buildErrorResponse(req, "Failed to revoke session", {}));
  }
});
