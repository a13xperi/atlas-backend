import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";

export const authRouter = Router();

// Register / onboard
authRouter.post("/register", async (req, res) => {
  try {
    const { handle, email, password, onboardingTrack } = req.body;

    if (!handle) return res.status(400).json({ error: "Handle is required" });

    const existing = await prisma.user.findUnique({ where: { handle } });
    if (existing) return res.status(409).json({ error: "Handle already taken" });

    const passwordHash = password ? await bcrypt.hash(password, 10) : undefined;

    const user = await prisma.user.create({
      data: {
        handle,
        email,
        passwordHash,
        onboardingTrack: onboardingTrack || undefined,
        voiceProfile: { create: {} },
      },
      include: { voiceProfile: true },
    });

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET || "dev-secret", {
      expiresIn: "30d",
    });

    res.json({ user: { id: user.id, handle: user.handle, role: user.role }, token });
  } catch (err: any) {
    console.error("Register error:", err.message);
    res.status(500).json({ error: "Registration failed", message: err.message });
  }
});

// Login
authRouter.post("/login", async (req, res) => {
  try {
    const { handle, password } = req.body;

    const user = await prisma.user.findUnique({ where: { handle } });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    if (user.passwordHash && password) {
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET || "dev-secret", {
      expiresIn: "30d",
    });

    res.json({ user: { id: user.id, handle: user.handle, role: user.role }, token });
  } catch (err: any) {
    console.error("Login error:", err.message);
    res.status(500).json({ error: "Login failed", message: err.message });
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
