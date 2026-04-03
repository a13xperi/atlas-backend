import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { error, success } from "../lib/response";
import { authenticate, AuthRequest } from "../middleware/auth";

const briefingRouter = Router();
briefingRouter.use(authenticate);

const briefingPreferencesSchema = z.object({
  deliveryTime: z.string(),
  topics: z.array(z.string()),
  sources: z.array(z.string()),
  channel: z.string(),
});

briefingRouter.get("/preferences", async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const result = await prisma.briefingPreference.findUnique({
      where: { userId },
    });

    res.json(success({ preference: result || null }));
  } catch (err: any) {
    res.status(500).json(error("Failed to fetch briefing preferences"));
  }
});

briefingRouter.put("/preferences", async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const body = briefingPreferencesSchema.parse(req.body);

    const result = await prisma.briefingPreference.upsert({
      where: { userId },
      create: {
        userId,
        deliveryTime: body.deliveryTime,
        topics: body.topics,
        sources: body.sources,
        channel: body.channel,
      },
      update: {
        deliveryTime: body.deliveryTime,
        topics: body.topics,
        sources: body.sources,
        channel: body.channel,
      },
    });

    res.json(success({ preference: result }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }

    res.status(500).json(error("Failed to save briefing preferences"));
  }
});

export default briefingRouter;
