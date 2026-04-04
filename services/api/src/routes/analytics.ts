import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { error, success } from "../lib/response";
import { buildErrorResponse } from "../middleware/requestId";
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

    res.json(success({
      summary: {
        draftsCreated,
        draftsPosted,
        feedbackGiven,
        refinements,
        reportsIngested,
        period: "30d",
      },
    }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to load summary", 500));
  }
});

const learningLogSchema = z.object({
  event: z.string().min(1),
  impact: z.string().min(1),
  positive: z.boolean().default(true),
});

// Create learning log entry
analyticsRouter.post("/learning-log", async (req: AuthRequest, res) => {
  try {
    const { event, impact, positive } = learningLogSchema.parse(req.body);

    const entry = await prisma.learningLogEntry.create({
      data: {
        userId: req.userId!,
        event,
        impact,
        positive,
      },
    });

    res.json(success({ entry }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to create learning log entry", 500));
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
    res.json(success({ entries }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to load learning log", 500));
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

    res.json(success({ events }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to load engagement history", 500));
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
    const buckets = new Map<string, { predicted: number; actual: number }>();

    // Pre-populate all 7 days
    for (let i = 0; i < 7; i++) {
      const d = new Date(sevenDaysAgo);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      buckets.set(key, { predicted: 0, actual: 0 });
    }

    // Aggregate drafts into day buckets
    for (const draft of drafts) {
      const key = draft.createdAt.toISOString().slice(0, 10);
      const bucket = buckets.get(key);
      if (!bucket) continue;
      bucket.predicted += draft.predictedEngagement ?? 0;
      bucket.actual += draft.actualEngagement ?? 0;
    }

    const result = Array.from(buckets.entries()).map(([date, bucket]) => ({
      date,
      dayLabel: dayNames[new Date(date + "T00:00:00").getDay()],
      predicted: bucket.predicted,
      actual: bucket.actual,
    }));

    res.json(success({ days: result }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to load daily engagement", 500));
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

    res.json(success({ days }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to load daily activity", 500));
  }
});

// Team engagement daily (manager only — predicted vs actual across all analysts, last 7 days)
analyticsRouter.get("/team-engagement-daily", async (req: AuthRequest, res) => {
  try {
    emptyQuerySchema.parse(req.query);

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user || user.role === "ANALYST") {
      return res.status(403).json(error("Manager access required", 403));
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

    res.json(success({ days }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to load team engagement daily", 500));
  }
});

// Days-to-peak engagement per analyst (manager only)
analyticsRouter.get("/days-to-peak", async (req: AuthRequest, res) => {
  try {
    emptyQuerySchema.parse(req.query);

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user || user.role === "ANALYST") {
      return res.status(403).json(error("Manager access required", 403));
    }

    const analysts = await prisma.user.findMany({
      where: { role: "ANALYST" },
      select: {
        id: true,
        displayName: true,
        handle: true,
        tweetDrafts: {
          select: { createdAt: true, actualEngagement: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    const peaks = analysts.map((a) => {
      const name = a.displayName || a.handle;
      const drafts = a.tweetDrafts;

      if (drafts.length === 0) {
        return { name, days: 0, hasDrafts: false };
      }

      const firstDraftDate = drafts[0].createdAt;

      // Find draft with highest actual engagement
      let peakDate = firstDraftDate;
      let peakEngagement = -1;
      for (const d of drafts) {
        if (d.actualEngagement != null && d.actualEngagement > peakEngagement) {
          peakEngagement = d.actualEngagement;
          peakDate = d.createdAt;
        }
      }

      const days = Math.max(
        1,
        Math.round(
          (peakDate.getTime() - firstDraftDate.getTime()) / (1000 * 60 * 60 * 24)
        )
      );

      return { name, days, hasDrafts: true };
    });

    peaks.sort((a, b) => a.days - b.days);
    res.json(success({ peaks }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to load days-to-peak", 500));
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
      return res.status(403).json(error("Manager access required", 403));
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

    res.json(success({
      analysts: analysts.map(({ passwordHash, ...a }) => a),
    }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to load team analytics", 500));
  }
});
