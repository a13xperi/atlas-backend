import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { error, success } from "../lib/response";
import { authenticate, AuthRequest } from "../middleware/auth";
import { searchTrending } from "../lib/grok";
import { logger } from "../lib/logger";
import { matchMonitorKeywords } from "./monitors";
import { emitToUser } from "../lib/socket";

export const trendingRouter = Router();
trendingRouter.use(authenticate);

const scanSchema = z.object({}).passthrough();
const topicsQuerySchema = z.object({}).passthrough();

// Scan Twitter for trending topics based on user's subscriptions
trendingRouter.post("/scan", async (req: AuthRequest, res) => {
  try {
    scanSchema.parse(req.body);

    // Get user's alert subscriptions to know what topics to scan
    const subscriptions = await prisma.alertSubscription.findMany({
      where: { userId: req.userId, isActive: true },
    });

    // Extract topic values, fallback to defaults if no subscriptions
    const topics = subscriptions.length > 0
      ? subscriptions.map((s) => s.value)
      : ["DeFi", "ETH", "Bitcoin", "AI", "Crypto"];

    // Search trending via Grok
    const items = await searchTrending({ topics, limit: 10 });

    // Create Alert entries for each trending item
    const alerts = await Promise.all(
      items.map((item) =>
        prisma.alert.create({
          data: {
            type: item.topic,
            title: item.headline,
            context: item.context,
            sourceUrl: item.tweetUrl || undefined,
            sentiment: item.sentiment,
            relevance: item.relevanceScore,
            userId: req.userId,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h expiry
          },
        })
      )
    );

    // Check alerts against user's NLP monitors (non-blocking)
    let monitorAlerts: typeof alerts = [];
    try {
      const monitors = await prisma.nlpMonitor.findMany({
        where: { userId: req.userId, isActive: true },
      });

      for (const monitor of monitors) {
        for (const item of items) {
          const searchText = `${item.headline} ${item.context ?? ""}`;
          const result = matchMonitorKeywords(searchText, monitor.keywords);
          if (result.matched && result.score >= monitor.minRelevance) {
            const alert = await prisma.alert.create({
              data: {
                type: "MONITOR",
                title: `[${monitor.name}] ${item.headline}`,
                context: `Matched keywords: ${result.matchedKeywords.join(", ")}. ${item.context ?? ""}`,
                sourceUrl: item.tweetUrl || undefined,
                sentiment: item.sentiment,
                relevance: result.score,
                userId: req.userId,
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
              },
            });
            monitorAlerts.push(alert);
            emitToUser(req.userId!, "alert:new", alert);
          }
        }
        if (monitorAlerts.length > 0) {
          await prisma.nlpMonitor.update({
            where: { id: monitor.id },
            data: { matchCount: { increment: monitorAlerts.length } },
          });
        }
      }
    } catch (monitorErr: any) {
      logger.warn({ err: monitorErr.message }, "Monitor matching failed (non-blocking)");
    }

    // Log analytics
    await prisma.analyticsEvent.create({
      data: { userId: req.userId!, type: "ALERT_GENERATED", value: alerts.length + monitorAlerts.length },
    });

    res.json(success({ alerts: [...alerts, ...monitorAlerts] }));
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
