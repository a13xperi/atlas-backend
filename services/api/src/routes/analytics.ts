import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { buildErrorResponse } from "../middleware/requestId";

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
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    res.status(500).json(buildErrorResponse(req, "Failed to load summary", { message: err.message }));
  }
});

// Create learning log entry
analyticsRouter.post("/learning-log", async (req: AuthRequest, res) => {
  try {
    const { event, impact, positive } = req.body;
    if (!event) {
      return res.status(400).json(buildErrorResponse(req, "Event description is required"));
    }

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
    res
      .status(500)
      .json(buildErrorResponse(req, "Failed to create learning log entry", { message: err.message }));
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
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    res
      .status(500)
      .json(buildErrorResponse(req, "Failed to load learning log", { message: err.message }));
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
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    res
      .status(500)
      .json(buildErrorResponse(req, "Failed to load engagement history", { message: err.message }));
  }
});

// Daily engagement comparison (predicted vs actual, last 7 days)
analyticsRouter.get("/engagement-daily", async (req: AuthRequest, res) => {
  try {
    emptyQuerySchema.parse(req.query);

    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const drafts = await prisma.tweetDraft.findMany({
      where: {
        userId: req.userId,
        predictedEngagement: { not: null },
        createdAt: { gte: sevenDaysAgo },
      },
      select: {
        createdAt: true,
        predictedEngagement: true,
        actualEngagement: true,
      },
      orderBy: { createdAt: "asc" },
    });

    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const buckets = new Map<string, { predicted: number; actual: number | null; hasActual: boolean }>();

    // Pre-populate all 7 days
    for (let i = 0; i < 7; i++) {
      const d = new Date(sevenDaysAgo);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      buckets.set(key, { predicted: 0, actual: 0, hasActual: false });
    }

    // Aggregate drafts into day buckets
    for (const draft of drafts) {
      const key = draft.createdAt.toISOString().slice(0, 10);
      const bucket = buckets.get(key);
      if (!bucket) continue;
      bucket.predicted += draft.predictedEngagement ?? 0;
      if (draft.actualEngagement !== null) {
        bucket.actual = (bucket.actual ?? 0) + draft.actualEngagement;
        bucket.hasActual = true;
      }
    }

    const result = Array.from(buckets.entries()).map(([date, bucket]) => ({
      date,
      dayLabel: dayNames[new Date(date + "T00:00:00").getDay()],
      predicted: bucket.predicted,
      actual: bucket.hasActual ? bucket.actual : null,
    }));

    res.json(result);
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    res
      .status(500)
      .json(buildErrorResponse(req, "Failed to load daily engagement", { message: err.message }));
  }
});

// Daily activity sparkline (last 30 days)
analyticsRouter.get("/activity-daily", async (req: AuthRequest, res) => {
  try {
    emptyQuerySchema.parse(req.query);

    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
    thirtyDaysAgo.setHours(0, 0, 0, 0);

    const events = await prisma.analyticsEvent.findMany({
      where: {
        userId: req.userId,
        createdAt: { gte: thirtyDaysAgo },
      },
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    // Pre-populate all 30 days
    const buckets = new Map<string, number>();
    for (let i = 0; i < 30; i++) {
      const d = new Date(thirtyDaysAgo);
      d.setDate(d.getDate() + i);
      buckets.set(d.toISOString().slice(0, 10), 0);
    }

    // Count events per day
    for (const event of events) {
      const key = event.createdAt.toISOString().slice(0, 10);
      if (buckets.has(key)) {
        buckets.set(key, buckets.get(key)! + 1);
      }
    }

    const days = Array.from(buckets.entries()).map(([date, count]) => ({
      date,
      count,
    }));

    res.json({ days });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    res
      .status(500)
      .json(buildErrorResponse(req, "Failed to load daily activity", { message: err.message }));
  }
});

// Team engagement daily (manager only — predicted vs actual across all analysts, last 7 days)
analyticsRouter.get("/team-engagement-daily", async (req: AuthRequest, res) => {
  try {
    emptyQuerySchema.parse(req.query);

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user || user.role === "ANALYST") {
      return res.status(403).json(buildErrorResponse(req, "Manager access required"));
    }

    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const drafts = await prisma.tweetDraft.findMany({
      where: {
        predictedEngagement: { not: null },
        createdAt: { gte: sevenDaysAgo },
      },
      select: {
        createdAt: true,
        predictedEngagement: true,
        actualEngagement: true,
      },
      orderBy: { createdAt: "asc" },
    });

    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const buckets = new Map<string, { predicted: number; actual: number; count: number }>();

    for (let i = 0; i < 7; i++) {
      const d = new Date(sevenDaysAgo);
      d.setDate(d.getDate() + i);
      buckets.set(d.toISOString().slice(0, 10), { predicted: 0, actual: 0, count: 0 });
    }

    for (const draft of drafts) {
      const key = draft.createdAt.toISOString().slice(0, 10);
      const bucket = buckets.get(key);
      if (!bucket) continue;
      bucket.predicted += draft.predictedEngagement ?? 0;
      bucket.actual += draft.actualEngagement ?? 0;
      bucket.count++;
    }

    const days = Array.from(buckets.entries()).map(([date, bucket]) => ({
      date,
      dayLabel: dayNames[new Date(date + "T00:00:00").getDay()],
      modelTarget: bucket.count > 0 ? Math.round(bucket.predicted / bucket.count) : 0,
      teamActual: bucket.count > 0 ? Math.round(bucket.actual / bucket.count) : 0,
    }));

    res.json({ days });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    res
      .status(500)
      .json(buildErrorResponse(req, "Failed to load team engagement daily", { message: err.message }));
  }
});

// Team analytics (manager only)
analyticsRouter.get("/team", async (req: AuthRequest, res) => {
  try {
    emptyQuerySchema.parse(req.query);

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user || user.role === "ANALYST") {
      return res.status(403).json(buildErrorResponse(req, "Manager access required"));
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
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    res
      .status(500)
      .json(buildErrorResponse(req, "Failed to load team analytics", { message: err.message }));
  }
});
