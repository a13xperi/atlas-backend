import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { logger } from "../lib/logger";

export const briefingRouter = Router();
briefingRouter.use(authenticate);

const preferencesSchema = z.object({
  deliveryTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  topics: z.array(z.string()).optional(),
  sources: z.array(z.string()).optional(),
  channel: z.enum(["PORTAL", "TELEGRAM", "BOTH"]).optional(),
});

// GET /api/briefing/preferences
briefingRouter.get("/preferences", async (req: AuthRequest, res) => {
  try {
    const pref = await prisma.briefingPreference.findUnique({
      where: { userId: req.userId },
    });
    res.json({
      ok: true,
      data: {
        preference: pref || {
          deliveryTime: "08:00",
          topics: [],
          sources: [],
          channel: "PORTAL",
        },
      },
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch briefing preferences");
    res.status(500).json({ ok: false, error: "Failed to fetch preferences" });
  }
});

// PUT /api/briefing/preferences
briefingRouter.put("/preferences", async (req: AuthRequest, res) => {
  try {
    const data = preferencesSchema.parse(req.body);
    const pref = await prisma.briefingPreference.upsert({
      where: { userId: req.userId },
      update: data,
      create: { userId: req.userId!, ...data },
    });
    res.json({ ok: true, data: { preference: pref } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json({ ok: false, error: err.errors[0].message });
    }
    logger.error({ err }, "Failed to save briefing preferences");
    res.status(500).json({ ok: false, error: "Failed to save preferences" });
  }
});
