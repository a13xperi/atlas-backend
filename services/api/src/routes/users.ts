import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { buildErrorResponse } from "../middleware/requestId";

export const usersRouter = Router();
usersRouter.use(authenticate);

const profileSchema = z.object({
  displayName: z.string().optional(),
  bio: z.string().optional(),
  avatarUrl: z.string().optional(),
});

// Get user profile
usersRouter.get("/profile", async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      include: { voiceProfile: true },
    });
    if (!user) return res.status(404).json(buildErrorResponse(req, "User not found"));

    const { passwordHash, ...safe } = user;
    res.json({ user: safe });
  } catch (err: any) {
    res.status(500).json(buildErrorResponse(req, "Failed to load profile", { message: err.message }));
  }
});

// Update profile
usersRouter.patch("/profile", async (req: AuthRequest, res) => {
  try {
    const body = profileSchema.parse(req.body);

    const user = await prisma.user.update({
      where: { id: req.userId },
      data: {
        ...(body.displayName !== undefined && { displayName: body.displayName }),
        ...(body.avatarUrl !== undefined && { avatarUrl: body.avatarUrl }),
      },
    });

    const { passwordHash, ...safe } = user;
    res.json({ user: safe });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    res.status(500).json(buildErrorResponse(req, "Failed to update profile", { message: err.message }));
  }
});

// List all analysts (manager view)
usersRouter.get("/team", async (req: AuthRequest, res) => {
  try {
    const currentUser = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!currentUser || currentUser.role === "ANALYST") {
      return res.status(403).json(buildErrorResponse(req, "Manager access required"));
    }

    const team = await prisma.user.findMany({
      include: {
        voiceProfile: true,
        _count: {
          select: { tweetDrafts: true, sessions: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    res.json({
      team: team.map(({ passwordHash, ...u }) => u),
    });
  } catch (err: any) {
    res.status(500).json(buildErrorResponse(req, "Failed to load team", { message: err.message }));
  }
});
