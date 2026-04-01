import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";

export const analyticsRouter = Router();
analyticsRouter.use(authenticate);

const emptyQuerySchema = z.object({}).passthrough();

// Get user analytics summary
analyticsRouter.get("/summary", async (req: AuthRequest, res) => {
  try {
    emptyQuerySchema.parse(req.query);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [draftsCreated, draftsPosted, feedbackGiven, refinements, reportsIngested] =
      await Promise.all([
        prisma.analyticsEvent.count({
          where: { userId: req.userId, type: "DRAFT_CREATED", createdAt: { gte: thirtyDaysAgo } },
        }),
        prisma.analyticsEvent.count({
          where: { userId: req.userId, type: "DRAFT_POSTED", createdAt: { gte: thirtyDaysAgo } },
        }),
        prisma.analyticsEvent.count({
          where: { userId: req.userId, type: "FEEDBACK_GIVEN", createdAt: { gte: thirtyDaysAgo } },
        }),
        prisma.analyticsEvent.count({
          where: { userId: req.userId, type: "VOICE_REFINEMENT", createdAt: { gte: thirtyDaysAgo } },
        }),
        prisma.analyticsEvent.count({
          where: { userId: req.userId, type: "REPORT_INGESTED", createdAt: { gte: thirtyDaysAgo } },
        }),
      ]);

    res.json({
      summary: {
        draftsCreated,
        draftsPosted,
        feedbackGiven,
        refinements,
        reportsIngested,
        period: "30d",
      },
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request", details: err.errors });
    }
    res.status(500).json({ error: "Failed to load summary", message: err.message });
  }
});

// Create learning log entry
analyticsRouter.post("/learning-log", async (req: AuthRequest, res) => {
  try {
    const { event, impact, positive } = req.body;
    if (!event) return res.status(400).json({ error: "Event description is required" });

    const entry = await prisma.learningLogEntry.create({
      data: {
        userId: req.userId!,
        event,
        impact: impact || null,
        positive: positive !== undefined ? positive : true,
      },
    });

    res.json({ entry });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to create learning log entry", message: err.message });
  }
});

// Get learning log
analyticsRouter.get("/learning-log", async (req: AuthRequest, res) => {
  try {
    emptyQuerySchema.parse(req.query);

    const entries = await prisma.learningLogEntry.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    res.json({ entries });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request", details: err.errors });
    }
    res.status(500).json({ error: "Failed to load learning log", message: err.message });
  }
});

// Get engagement history (for charts)
analyticsRouter.get("/engagement", async (req: AuthRequest, res) => {
  try {
    emptyQuerySchema.parse(req.query);

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const events = await prisma.analyticsEvent.findMany({
      where: {
        userId: req.userId,
        type: "ENGAGEMENT_RECORDED",
        createdAt: { gte: sevenDaysAgo },
      },
      orderBy: { createdAt: "asc" },
    });

    res.json({ events });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request", details: err.errors });
    }
    res.status(500).json({ error: "Failed to load engagement history", message: err.message });
  }
});

// Daily engagement aggregation (predicted vs actual from drafts, last 7 days)
analyticsRouter.get("/engagement-daily", async (req: AuthRequest, res) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const rows: { date: Date; predicted: number; actual: number }[] =
      await prisma.$queryRaw`
        SELECT
          DATE("createdAt") as date,
          COALESCE(AVG("predictedEngagement"), 0)::float as predicted,
          COALESCE(AVG("actualEngagement"), 0)::float as actual
        FROM "TweetDraft"
        WHERE "userId" = ${req.userId}
          AND "createdAt" >= ${sevenDaysAgo}
          AND ("predictedEngagement" IS NOT NULL OR "actualEngagement" IS NOT NULL)
        GROUP BY DATE("createdAt")
        ORDER BY date ASC
      `;

    const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const days = rows.map((r) => ({
      date: r.date.toISOString().slice(0, 10),
      dayLabel: dayLabels[new Date(r.date).getDay()],
      predicted: Math.round(r.predicted),
      actual: Math.round(r.actual),
    }));

    res.json({ days });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to load engagement daily", message: err.message });
  }
});

// Daily activity counts for sparkline (last 30 days)
analyticsRouter.get("/activity-daily", async (req: AuthRequest, res) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const rows: { date: Date; count: bigint }[] =
      await prisma.$queryRaw`
        SELECT DATE("createdAt") as date, COUNT(*)::bigint as count
        FROM "AnalyticsEvent"
        WHERE "userId" = ${req.userId}
          AND "createdAt" >= ${thirtyDaysAgo}
        GROUP BY DATE("createdAt")
        ORDER BY date ASC
      `;

    const days = rows.map((r) => ({
      date: r.date.toISOString().slice(0, 10),
      count: Number(r.count),
    }));

    res.json({ days });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to load activity daily", message: err.message });
  }
});

// Team engagement daily (manager only, aggregates across all analysts)
analyticsRouter.get("/team-engagement-daily", async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user || user.role === "ANALYST") {
      return res.status(403).json({ error: "Manager access required" });
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const rows: { date: Date; model_target: number; team_actual: number }[] =
      await prisma.$queryRaw`
        SELECT
          DATE("createdAt") as date,
          COALESCE(AVG("predictedEngagement"), 0)::float as model_target,
          COALESCE(AVG("actualEngagement"), 0)::float as team_actual
        FROM "TweetDraft"
        WHERE "createdAt" >= ${sevenDaysAgo}
          AND ("predictedEngagement" IS NOT NULL OR "actualEngagement" IS NOT NULL)
        GROUP BY DATE("createdAt")
        ORDER BY date ASC
      `;

    const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const days = rows.map((r) => ({
      date: r.date.toISOString().slice(0, 10),
      dayLabel: dayLabels[new Date(r.date).getDay()],
      modelTarget: Math.round(r.model_target),
      teamActual: Math.round(r.team_actual),
    }));

    res.json({ days });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to load team engagement daily", message: err.message });
  }
});

// Team analytics (manager only)
analyticsRouter.get("/team", async (req: AuthRequest, res) => {
  try {
    emptyQuerySchema.parse(req.query);

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user || user.role === "ANALYST") {
      return res.status(403).json({ error: "Manager access required" });
    }

    const analysts = await prisma.user.findMany({
      where: { role: "ANALYST" },
      include: {
        voiceProfile: true,
        _count: {
          select: {
            tweetDrafts: true,
            analyticsEvents: true,
            sessions: true,
          },
        },
      },
    });

    res.json({
      analysts: analysts.map(({ passwordHash, ...a }) => a),
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request", details: err.errors });
    }
    res.status(500).json({ error: "Failed to load team analytics", message: err.message });
  }
});
