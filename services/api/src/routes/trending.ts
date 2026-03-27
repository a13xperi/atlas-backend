import { Router } from "express";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { searchTrending } from "../lib/grok";

export const trendingRouter = Router();
trendingRouter.use(authenticate);

// Scan Twitter for trending topics based on user's subscriptions
trendingRouter.post("/scan", async (req: AuthRequest, res) => {
  try {
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

    // Log analytics
    await prisma.analyticsEvent.create({
      data: { userId: req.userId!, type: "ALERT_GENERATED", value: alerts.length },
    });

    res.json({ alerts });
  } catch (err: any) {
    console.error("Trending scan failed:", err.message);
    res.status(502).json({ error: "Twitter scan failed", message: err.message });
  }
});

// Get cached trending topics for the crafting station
trendingRouter.get("/topics", async (req: AuthRequest, res) => {
  try {
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

    res.json({ topics });
  } catch (err: any) {
    console.error("Failed to get topics:", err.message);
    res.status(500).json({ error: "Failed to load trending topics" });
  }
});
