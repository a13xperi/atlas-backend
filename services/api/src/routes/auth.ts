import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";

export const authRouter = Router();

const registerSchema = z.object({
  handle: z.string().min(1),
  email: z.string().email().optional(),
  password: z.string().min(6).optional(),
  onboardingTrack: z.enum(["A", "B"]).optional(),
});

const loginSchema = z.object({
  handle: z.string().min(1),
  password: z.string().optional(),
});

// Register / onboard
authRouter.post("/register", async (req, res) => {
  try {
    const body = registerSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { handle: body.handle } });
    if (existing) return res.status(409).json({ error: "Handle already taken" });

    const passwordHash = body.password ? await bcrypt.hash(body.password, 10) : undefined;

    const user = await prisma.user.create({
      data: {
        handle: body.handle,
        email: body.email,
        passwordHash,
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

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET || "dev-secret", {
      expiresIn: "30d",
    });

    res.json({ user: { id: user.id, handle: user.handle, role: user.role }, token });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      if (req.body?.handle === undefined) {
        return res.status(400).json({ error: "Handle is required" });
      }
      return res.status(400).json({ error: "Invalid request", details: err.errors });
    }
    console.error("Register error:", err.message);
    res.status(500).json({ error: "Registration failed", message: err.message });
  }
});

// Login
authRouter.post("/login", async (req, res) => {
  try {
    const body = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { handle: body.handle } });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    if (user.passwordHash && body.password) {
      const valid = await bcrypt.compare(body.password, user.passwordHash);
      if (!valid) return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET || "dev-secret", {
      expiresIn: "30d",
    });

    res.json({ user: { id: user.id, handle: user.handle, role: user.role }, token });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request", details: err.errors });
    }
    console.error("Login error:", err.message);
    res.status(500).json({ error: "Login failed", message: err.message });
  }
});

// List active sessions
authRouter.get("/sessions", authenticate, async (req: AuthRequest, res) => {
  try {
    const sessions = await prisma.session.findMany({
      where: { userId: req.userId, expiresAt: { gt: new Date() } },
      select: { id: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ sessions });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to list sessions", message: err.message });
  }
});

// Revoke a session
authRouter.delete("/sessions/:id", authenticate, async (req: AuthRequest, res) => {
  try {
    const sessionId = req.params.id as string;
    const session = await prisma.session.findFirst({
      where: { id: sessionId, userId: req.userId },
    });
    if (!session) return res.status(404).json({ error: "Session not found" });

    await prisma.session.delete({ where: { id: sessionId } });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to revoke session", message: err.message });
  }
});

// Get current user
authRouter.get("/me", authenticate, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      include: { voiceProfile: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });

    res.json({ user: { id: user.id, handle: user.handle, role: user.role, voiceProfile: user.voiceProfile } });
  } catch (err: any) {
    console.error("Me error:", err.message);
    res.status(500).json({ error: "Failed to get user", message: err.message });
  }
});
