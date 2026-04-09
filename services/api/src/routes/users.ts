import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { error, success } from "../lib/response";
import { authenticate, AuthRequest } from "../middleware/auth";
import { emitToUser } from "../lib/socket";

export const usersRouter = Router();
usersRouter.use(authenticate);

const profileSchema = z.object({
  displayName: z.string().optional(),
  bio: z.string().optional(),
  avatarUrl: z.string().optional(),
  tourCompleted: z.boolean().optional(),
  tourStep: z.number().int().min(0).optional(),
});

const emptyActionSchema = z.object({}).passthrough();

// Get user profile
usersRouter.get("/profile", async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      include: { voiceProfile: true },
    });
    if (!user) return res.status(404).json(error("User not found"));

    const { passwordHash, ...safe } = user;
    res.json(success({ user: safe }));
  } catch (err: any) {
    res.status(500).json(error("Failed to load profile"));
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
        ...(body.tourCompleted !== undefined && { tourCompleted: body.tourCompleted }),
        ...(body.tourStep !== undefined && { tourStep: body.tourStep }),
      },
    });

    const { passwordHash, ...safe } = user;
    res.json(success({ user: safe }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to update profile"));
  }
});

// List all analysts (manager view)
usersRouter.get("/team", async (req: AuthRequest, res) => {
  try {
    const currentUser = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!currentUser || currentUser.role === "ANALYST") {
      return res.status(403).json(error("Manager access required"));
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

    res.json(success({
      team: team.map(({ passwordHash, ...u }) => u),
    }));
  } catch (err: any) {
    res.status(500).json(error("Failed to load team"));
  }
});

// ---------- Admin: update a user's role ----------

const roleUpdateSchema = z.object({
  role: z.enum(["ANALYST", "MANAGER", "ADMIN"]),
});

// PATCH /api/users/:userId/role — ADMIN only
usersRouter.patch("/:userId/role", async (req: AuthRequest, res) => {
  try {
    const currentUser = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!currentUser || currentUser.role !== "ADMIN") {
      return res.status(403).json(error("Admin access required", 403));
    }

    const userId = String(req.params.userId);
    const body = roleUpdateSchema.parse(req.body);

    const user = await prisma.user.update({
      where: { id: userId },
      data: { role: body.role },
      select: { id: true, handle: true, role: true },
    });

    res.json(success({ user }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid role", 400, err.errors));
    }
    console.error("PATCH /api/users/:userId/role error:", err);
    res.status(500).json(error("Failed to update role"));
  }
});

// ---------- Management action endpoints (BO #53) ----------

/** Reusable: get the requesting user and reject non-managers */
async function requireManager(req: AuthRequest, res: any): Promise<any | null> {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user || user.role === "ANALYST") {
    res.status(403).json(error("Manager access required"));
    return null;
  }
  return user;
}

/** Reusable: find analysts with no sessions in the last 7 days */
async function findInactiveAnalysts() {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const allAnalysts = await prisma.user.findMany({
    where: { role: "ANALYST" },
    include: {
      sessions: { where: { createdAt: { gte: sevenDaysAgo } }, take: 1 },
      voiceProfile: true,
    },
  });
  return allAnalysts.filter((a) => a.sessions.length === 0);
}

// Push top 5 performer voice profiles to inactive analysts
usersRouter.post("/push-top-profiles", async (req: AuthRequest, res) => {
  try {
    emptyActionSchema.parse(req.body ?? {});

    const manager = await requireManager(req, res);
    if (!manager) return;

    // Top 5 by draft count
    const topPerformers = await prisma.user.findMany({
      where: { role: "ANALYST", voiceProfile: { isNot: null } },
      include: { voiceProfile: true, _count: { select: { tweetDrafts: true } } },
      orderBy: { tweetDrafts: { _count: "desc" } },
      take: 5,
    });

    if (topPerformers.length === 0) {
      return res.json(success({ message: "No top performers with voice profiles found", affected: 0 }));
    }

    // Average the top performers' voice dimensions
    const avg = { humor: 0, formality: 0, brevity: 0, contrarianTone: 0 };
    let count = 0;
    for (const p of topPerformers) {
      if (!p.voiceProfile) continue;
      avg.humor += p.voiceProfile.humor;
      avg.formality += p.voiceProfile.formality;
      avg.brevity += p.voiceProfile.brevity;
      avg.contrarianTone += p.voiceProfile.contrarianTone;
      count++;
    }
    if (count > 0) {
      avg.humor = Math.round(avg.humor / count);
      avg.formality = Math.round(avg.formality / count);
      avg.brevity = Math.round(avg.brevity / count);
      avg.contrarianTone = Math.round(avg.contrarianTone / count);
    }

    const inactive = await findInactiveAnalysts();
    const inactiveIds = inactive.map((a) => a.id);

    if (inactiveIds.length === 0) {
      return res.json(success({ message: "No inactive analysts to update", affected: 0 }));
    }

    // Upsert voice profiles for inactive analysts
    await Promise.all(
      inactiveIds.map((userId) =>
        prisma.voiceProfile.upsert({
          where: { userId },
          update: { humor: avg.humor, formality: avg.formality, brevity: avg.brevity, contrarianTone: avg.contrarianTone },
          create: { userId, humor: avg.humor, formality: avg.formality, brevity: avg.brevity, contrarianTone: avg.contrarianTone },
        })
      )
    );

    res.json(
      success({
        message: `Pushed top-5 profile blend to ${inactiveIds.length} inactive analyst(s)`,
        affected: inactiveIds.length,
      })
    );
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to push top profiles"));
  }
});

// Send engagement nudge to all inactive analysts
usersRouter.post("/send-nudge", async (req: AuthRequest, res) => {
  try {
    emptyActionSchema.parse(req.body ?? {});

    const manager = await requireManager(req, res);
    if (!manager) return;

    const inactive = await findInactiveAnalysts();
    if (inactive.length === 0) {
      return res.json(success({ message: "No inactive analysts to nudge", affected: 0 }));
    }

    // Create an alert for each inactive analyst
    await prisma.alert.createMany({
      data: inactive.map((a) => ({
        type: "NUDGE",
        title: "Time to get back in the game!",
        context: `Your manager ${manager.displayName ?? manager.handle} noticed you haven't been active. Jump in and craft some tweets!`,
        category: "NOTIFICATION" as const,
        userId: a.id,
      })),
    });

    // Emit real-time WebSocket alerts to each inactive analyst
    for (const analyst of inactive) {
      emitToUser(analyst.id, "new-alert", {
        type: "NUDGE",
        title: "Time to get back in the game!",
        context: `Your manager ${manager.displayName ?? manager.handle} noticed you haven't been active. Jump in and craft some tweets!`,
        category: "NOTIFICATION",
        userId: analyst.id,
      });
    }

    res.json(
      success({
        message: `Sent nudge to ${inactive.length} inactive analyst(s)`,
        affected: inactive.length,
      })
    );
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to send nudge"));
  }
});

// Push a voice style to all analysts
const pushStyleSchema = z.object({ blendId: z.string().optional() });

usersRouter.post("/push-style", async (req: AuthRequest, res) => {
  try {
    const manager = await requireManager(req, res);
    if (!manager) return;
    const body = pushStyleSchema.parse(req.body);

    let dims = { humor: 50, formality: 50, brevity: 50, contrarianTone: 50 };

    if (body.blendId) {
      // Resolve blend → weighted average voice dimensions
      const blend = await prisma.savedBlend.findUnique({
        where: { id: body.blendId },
        include: { voices: { include: { referenceVoice: true } } },
      });
      if (!blend) {
        return res.status(404).json(error("Blend not found"));
      }
      // BlendVoice has percentage weights; ReferenceVoice doesn't have voice dims directly.
      // Fall back to manager's own profile when blend voices lack dimension data.
      const managerProfile = await prisma.voiceProfile.findUnique({ where: { userId: manager.id } });
      if (managerProfile) {
        dims = { humor: managerProfile.humor, formality: managerProfile.formality, brevity: managerProfile.brevity, contrarianTone: managerProfile.contrarianTone };
      }
    } else {
      // No blendId — use manager's own voice profile
      const managerProfile = await prisma.voiceProfile.findUnique({ where: { userId: manager.id } });
      if (managerProfile) {
        dims = { humor: managerProfile.humor, formality: managerProfile.formality, brevity: managerProfile.brevity, contrarianTone: managerProfile.contrarianTone };
      }
    }

    const analysts = await prisma.user.findMany({ where: { role: "ANALYST" }, select: { id: true } });
    if (analysts.length === 0) {
      return res.json(success({ message: "No analysts to update", affected: 0 }));
    }

    await Promise.all(
      analysts.map((a) =>
        prisma.voiceProfile.upsert({
          where: { userId: a.id },
          update: dims,
          create: { userId: a.id, ...dims },
        })
      )
    );

    res.json(success({ message: `Pushed style to ${analysts.length} analyst(s)`, affected: analysts.length }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to push style"));
  }
});
