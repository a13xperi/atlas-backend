import { Router, Response } from "express";
import { prisma } from "../lib/prisma";
import { error, success } from "../lib/response";
import { authenticate, AuthRequest } from "../middleware/auth";

export const adminFlagsRouter = Router();
adminFlagsRouter.use(authenticate);

/** Require ADMIN role — returns true if admin, sends 403 and returns false otherwise */
async function requireAdmin(req: AuthRequest, res: Response): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user || user.role !== "ADMIN") {
    res.status(403).json(error("Admin access required", 403));
    return false;
  }
  return true;
}

// Hard-coded defaults — seeded on first GET if table is empty
const FLAG_DEFAULTS: Array<{ key: string; enabled: boolean; rolloutRole: string }> = [
  { key: "crafting_station", enabled: true, rolloutRole: "everyone" },
  { key: "voice_lab", enabled: true, rolloutRole: "everyone" },
  { key: "arena", enabled: true, rolloutRole: "managers" },
  { key: "campaigns", enabled: true, rolloutRole: "everyone" },
  { key: "queue", enabled: true, rolloutRole: "everyone" },
  { key: "analytics_advanced", enabled: true, rolloutRole: "managers" },
  { key: "signals", enabled: true, rolloutRole: "managers" },
  { key: "telegram_bot", enabled: false, rolloutRole: "everyone" },
  { key: "tweet_tinder", enabled: true, rolloutRole: "everyone" },
  { key: "multi_model", enabled: false, rolloutRole: "admins" },
  { key: "super_admin", enabled: true, rolloutRole: "admins" },
  { key: "management", enabled: true, rolloutRole: "admins" },
  { key: "feed", enabled: true, rolloutRole: "everyone" },
  { key: "briefing", enabled: true, rolloutRole: "everyone" },
  { key: "library", enabled: true, rolloutRole: "everyone" },
];

const VALID_ROLES = ["everyone", "managers", "admins"] as const;

// GET /api/admin/feature-flags
adminFlagsRouter.get("/", async (req: AuthRequest, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;

    let flags = await prisma.featureFlag.findMany();

    // Seed if empty
    if (flags.length === 0) {
      await prisma.featureFlag.createMany({
        data: FLAG_DEFAULTS,
        skipDuplicates: true,
      });
      flags = await prisma.featureFlag.findMany();
    }

    // Merge with defaults so all known flags are always present in the response
    const flagMap = new Map(flags.map((f) => [f.key, f]));
    const merged = FLAG_DEFAULTS.map((def) => flagMap.get(def.key) ?? def);

    res.json(success({ flags: merged }));
  } catch (err: any) {
    console.error("GET /api/admin/feature-flags error:", err);
    res.status(500).json(error("Failed to fetch feature flags", 500));
  }
});

// PATCH /api/admin/feature-flags/:key
adminFlagsRouter.patch("/:key", async (req: AuthRequest, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;

    const key = String(req.params.key);
    const { enabled, rolloutRole } = req.body as {
      enabled?: boolean;
      rolloutRole?: string;
    };

    if (rolloutRole !== undefined && !VALID_ROLES.includes(rolloutRole as any)) {
      return res.status(400).json(error("Invalid rolloutRole", 400));
    }
    if (enabled !== undefined && typeof enabled !== "boolean") {
      return res.status(400).json(error("Invalid enabled value", 400));
    }

    const flag = await prisma.featureFlag.upsert({
      where: { key },
      update: {
        ...(enabled !== undefined && { enabled }),
        ...(rolloutRole !== undefined && { rolloutRole }),
      },
      create: {
        key,
        enabled: enabled ?? true,
        rolloutRole: rolloutRole ?? "everyone",
      },
    });

    res.json(success({ flag }));
  } catch (err: any) {
    console.error(`PATCH /api/admin/feature-flags/${String(req.params.key)} error:`, err);
    res.status(500).json(error("Failed to update feature flag", 500));
  }
});

export default adminFlagsRouter;
