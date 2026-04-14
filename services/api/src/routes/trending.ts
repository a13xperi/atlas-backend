import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { error, success } from "../lib/response";
import { authenticate, AuthRequest } from "../middleware/auth";
import { logger } from "../lib/logger";
import { scanTrendingForUser } from "../lib/alertScanner";

export const trendingRouter = Router();
trendingRouter.use(authenticate);

const scanSchema = z.object({}).passthrough();
const topicsQuerySchema = z.object({}).passthrough();

// Scan Twitter for trending topics based on user's subscriptions
// (manual trigger — same logic also runs on the background scheduler)
trendingRouter.post("/scan", async (req: AuthRequest, res) => {
  try {
    scanSchema.parse(req.body);

    const result = await scanTrendingForUser(req.userId!);

    res.json(success({ alerts: [...result.alertObjects, ...result.monitorAlertObjects] }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    logger.error({ err: err.message }, "Trending scan failed");
    res.status(502).json(error("Twitter scan failed"));
  }
});

// Get cached trending topics for the crafting station
trendingRouter.get("/topics", async (req: AuthRequest, res) => {
  try {
    topicsQuerySchema.parse(req.query);

    // Return recent alerts as trending topics (last 24h, user-specific)
    const alerts = await prisma.alert.findMany({
      where: {
        userId: req.userId,
        expiresAt: { gt: new Date() },
      },
      orderBy: { relevance: "desc" },
      take: 10,
    });

    const topics = alerts.map((a) => ({
      id: a.id,
      topic: a.type,
      headline: a.title,
      context: a.context,
      sourceUrl: a.sourceUrl,
      sentiment: a.sentiment,
      relevance: a.relevance,
    }));

    res.json(success({ topics }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    logger.error({ err: err.message }, "Failed to get topics");
    res.status(500).json(error("Failed to load trending topics"));
  }
});
