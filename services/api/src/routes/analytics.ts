import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { error, success } from "../lib/response";
import { buildErrorResponse } from "../middleware/requestId";
import { authenticate, AuthRequest } from "../middleware/auth";
import { calculateStreak, calculateStreakFromDates } from "../lib/streak";

export const analyticsRouter = Router();
analyticsRouter.use(authenticate);

const emptyQuerySchema = z.object({}).passthrough();

type EngagementMetricsSummary = {
  likes: number;
  retweets: number;
  replies: number;
  impressions: number;
};

function getMetricValue(metrics: unknown, key: keyof EngagementMetricsSummary): number {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    return 0;
  }

  const value = (metrics as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function getDraftEngagementMetrics(
  metrics: unknown,
  actualEngagement: number | null,
): EngagementMetricsSummary {
  const impressions = getMetricValue(metrics, "impressions");

  return {
    likes: getMetricValue(metrics, "likes"),
    retweets: getMetricValue(metrics, "retweets"),
    replies: getMetricValue(metrics, "replies"),
    impressions:
      impressions > 0
        ? impressions
        : typeof actualEngagement === "number" && Number.isFinite(actualEngagement)
          ? actualEngagement
          : 0,
  };
}

function getEngagementTotal(metrics: EngagementMetricsSummary): number {
  return metrics.likes + metrics.retweets + metrics.replies;
}

function getBestPerformingScore(metrics: EngagementMetricsSummary): number {
  const engagementTotal = getEngagementTotal(metrics);
  return engagementTotal > 0 ? engagementTotal : metrics.impressions;
}

function roundToTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100;
}

// Get user analytics summary
analyticsRouter.get("/summary", async (req: AuthRequest, res) => {
  try {
    emptyQuerySchema.parse(req.query);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      draftsCreatedEvent,
      draftsPostedEvent,
      feedbackGiven,
      refinements,
      reportsIngested,
      draftsCreatedDirect,
      draftsPostedDirect,
    ] = await Promise.all([
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
      // Fallback: count tweetDraft rows directly (covers seeded/imported drafts that bypass events)
      prisma.tweetDraft.count({
        where: { userId: req.userId, createdAt: { gte: thirtyDaysAgo } },
      }),
      prisma.tweetDraft.count({
        where: { userId: req.userId, status: "POSTED", createdAt: { gte: thirtyDaysAgo } },
      }),
    ]);

    const draftsCreated = Math.max(draftsCreatedEvent, draftsCreatedDirect);
    const draftsPosted = Math.max(draftsPostedEvent, draftsPostedDirect);

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

analyticsRouter.get("/engagement-summary", async (req: AuthRequest, res) => {
  try {
    emptyQuerySchema.parse(req.query);

    const drafts = await prisma.tweetDraft.findMany({
      where: {
        userId: req.userId,
        status: "POSTED",
      },
      select: {
        id: true,
        content: true,
        createdAt: true,
        actualEngagement: true,
        engagementMetrics: true,
      },
      orderBy: { createdAt: "desc" },
    });

    let totalLikes = 0;
    let totalRetweets = 0;
    let totalReplies = 0;
    let totalImpressions = 0;
    let bestPerformingTweet: {
      id: string;
      content: string;
      createdAt: Date;
      metrics: EngagementMetricsSummary;
      performanceScore: number;
    } | null = null;
    let bestScore = -1;

    for (const draft of drafts) {
      const metrics = getDraftEngagementMetrics(draft.engagementMetrics, draft.actualEngagement);
      const performanceScore = getBestPerformingScore(metrics);

      totalLikes += metrics.likes;
      totalRetweets += metrics.retweets;
      totalReplies += metrics.replies;
      totalImpressions += metrics.impressions;

      if (
        !bestPerformingTweet ||
        performanceScore > bestScore ||
        (performanceScore === bestScore && metrics.impressions > bestPerformingTweet.metrics.impressions)
      ) {
        bestPerformingTweet = {
          id: draft.id,
          content: draft.content,
          createdAt: draft.createdAt,
          metrics,
          performanceScore,
        };
        bestScore = performanceScore;
      }
    }

    const totalTweets = drafts.length;
    const totalEngagement = totalLikes + totalRetweets + totalReplies;

    res.json(success({
      summary: {
        totalTweets,
        totals: {
          likes: totalLikes,
          retweets: totalRetweets,
          replies: totalReplies,
          impressions: totalImpressions,
          engagement: totalEngagement,
        },
        avgPerTweet: {
          likes: totalTweets ? roundToTwoDecimals(totalLikes / totalTweets) : 0,
          retweets: totalTweets ? roundToTwoDecimals(totalRetweets / totalTweets) : 0,
          replies: totalTweets ? roundToTwoDecimals(totalReplies / totalTweets) : 0,
          impressions: totalTweets ? roundToTwoDecimals(totalImpressions / totalTweets) : 0,
          engagement: totalTweets ? roundToTwoDecimals(totalEngagement / totalTweets) : 0,
        },
        bestPerformingTweet,
      },
    }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to load engagement summary", 500));
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
        type: { in: ["ENGAGEMENT_RECORDED", "ENGAGEMENT_UPDATED"] },
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

// ============================================================
// Atlas Score — composite 0-1000 score per user
// ============================================================
// Formula:
//   Output         25% (250 pts)  — total drafts created (cap 100)
//   Post Rate      20% (200 pts)  — postedDrafts / createdDrafts
//   Engagement Δ   20% (200 pts)  — actual vs predicted engagement
//   Voice Maturity 15% (150 pts)  — voice profile maturity tier + tweetsAnalyzed
//   Feedback       10% (100 pts)  — feedback events given
//   Streak         10% (100 pts)  — consecutive days with activity (cap 30)
// ============================================================

type ScoreUserInput = {
  id: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  voiceProfile: {
    maturity: "BEGINNER" | "INTERMEDIATE" | "ADVANCED";
    tweetsAnalyzed: number;
  } | null;
  drafts: Array<{
    status: string;
    predictedEngagement: number | null;
    actualEngagement: number | null;
  }>;
  feedbackCount: number;
  activityDates: Date[];
};

type ScoreBreakdown = {
  output: number;
  postRate: number;
  engagementDelta: number;
  voiceMaturity: number;
  feedback: number;
  streak: number;
  total: number;
};

function clampScore(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// Delegates to the shared streak lib so Atlas Score matches the arena
// leaderboard and the new /analytics/streak endpoint byte-for-byte.
function computeStreak(dates: Date[]): number {
  return calculateStreakFromDates(dates).currentStreak;
}

function computeAtlasScore(u: ScoreUserInput): ScoreBreakdown {
  // Output (250 max) — cap at 100 drafts for full score
  const totalDrafts = u.drafts.length;
  const output = Math.round(clampScore(totalDrafts / 100, 0, 1) * 250);

  // Post Rate (200 max) — posted+approved / created
  const postedCount = u.drafts.filter(
    (d) => d.status === "POSTED" || d.status === "APPROVED"
  ).length;
  const postRateRatio = totalDrafts > 0 ? postedCount / totalDrafts : 0;
  const postRate = Math.round(clampScore(postRateRatio, 0, 1) * 200);

  // Engagement Delta (200 max) — actual vs predicted ratio
  // Map: 0 → 0pts, 1.0 → 100pts, 2.0+ → 200pts
  const engagementDrafts = u.drafts.filter(
    (d) =>
      d.actualEngagement != null &&
      d.predictedEngagement != null &&
      (d.predictedEngagement ?? 0) > 0
  );
  let engagementDelta = 0;
  if (engagementDrafts.length > 0) {
    const ratios = engagementDrafts.map(
      (d) => (d.actualEngagement ?? 0) / (d.predictedEngagement ?? 1)
    );
    const avgRatio = ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
    engagementDelta = Math.round(clampScore(avgRatio / 2, 0, 1) * 200);
  }

  // Voice Maturity (150 max) — tier base + tweetsAnalyzed bonus
  let voiceMaturity = 0;
  if (u.voiceProfile) {
    const tierBase =
      u.voiceProfile.maturity === "ADVANCED"
        ? 100
        : u.voiceProfile.maturity === "INTERMEDIATE"
          ? 60
          : 20;
    const analyzedBonus = Math.round(
      clampScore(u.voiceProfile.tweetsAnalyzed / 200, 0, 1) * 50
    );
    voiceMaturity = clampScore(tierBase + analyzedBonus, 0, 150);
  }

  // Feedback (100 max) — feedback events (cap at 50 events)
  const feedback = Math.round(clampScore(u.feedbackCount / 50, 0, 1) * 100);

  // Streak (100 max) — consecutive days with activity (cap 30 days)
  const streakDays = computeStreak(u.activityDates);
  const streak = Math.round(clampScore(streakDays / 30, 0, 1) * 100);

  const total = output + postRate + engagementDelta + voiceMaturity + feedback + streak;

  return { output, postRate, engagementDelta, voiceMaturity, feedback, streak, total };
}

async function loadScoreInput(userId: string): Promise<ScoreUserInput | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      handle: true,
      displayName: true,
      avatarUrl: true,
      voiceProfile: {
        select: { maturity: true, tweetsAnalyzed: true },
      },
      tweetDrafts: {
        select: {
          status: true,
          predictedEngagement: true,
          actualEngagement: true,
          createdAt: true,
        },
      },
    },
  });
  if (!user) return null;

  const feedbackCount = await prisma.analyticsEvent.count({
    where: { userId, type: "FEEDBACK_GIVEN" },
  });

  return {
    id: user.id,
    handle: user.handle,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    voiceProfile: user.voiceProfile,
    drafts: user.tweetDrafts.map((d) => ({
      status: d.status,
      predictedEngagement: d.predictedEngagement,
      actualEngagement: d.actualEngagement,
    })),
    feedbackCount,
    activityDates: user.tweetDrafts.map((d) => d.createdAt),
  };
}

// ============================================================
// Streak — real consecutive-day activity tracking
// ============================================================
// Returns currentStreak, longestStreak, status, lastActivityAt
// computed from the user's full AnalyticsEvent history. Replaces the
// session-count proxy previously shown in the portal.
// ============================================================

analyticsRouter.get("/streak", async (req: AuthRequest, res) => {
  try {
    emptyQuerySchema.parse(req.query);

    const streak = await calculateStreak(req.userId!);
    res.json(success({
      userId: req.userId,
      currentStreak: streak.currentStreak,
      longestStreak: streak.longestStreak,
      status: streak.status,
      lastActivityAt: streak.lastActivityAt,
    }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to load streak", 500));
  }
});

analyticsRouter.get("/streak/:userId", async (req: AuthRequest, res) => {
  try {
    emptyQuerySchema.parse(req.query);

    const rawUserId = req.params.userId;
    const targetUserId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;
    if (!targetUserId || typeof targetUserId !== "string") {
      return res.status(400).json(error("Missing userId", 400));
    }

    // Analysts can only look up their own streak; managers/admins can
    // inspect any teammate.
    if (targetUserId !== req.userId) {
      const viewer = await prisma.user.findUnique({
        where: { id: req.userId },
        select: { role: true },
      });
      if (!viewer || viewer.role === "ANALYST") {
        return res.status(403).json(error("Manager access required", 403));
      }
    }

    const target = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true },
    });
    if (!target) {
      return res.status(404).json(error("User not found", 404));
    }

    const streak = await calculateStreak(targetUserId);
    res.json(success({
      userId: targetUserId,
      currentStreak: streak.currentStreak,
      longestStreak: streak.longestStreak,
      status: streak.status,
      lastActivityAt: streak.lastActivityAt,
    }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to load streak", 500));
  }
});

// Get current user's Atlas Score with full breakdown
analyticsRouter.get("/atlas-score", async (req: AuthRequest, res) => {
  try {
    emptyQuerySchema.parse(req.query);

    const input = await loadScoreInput(req.userId!);
    if (!input) {
      return res.status(404).json(error("User not found", 404));
    }

    const breakdown = computeAtlasScore(input);

    res.json(
      success({
        score: breakdown.total,
        breakdown: {
          output: { points: breakdown.output, max: 250, weight: 0.25 },
          postRate: { points: breakdown.postRate, max: 200, weight: 0.2 },
          engagementDelta: { points: breakdown.engagementDelta, max: 200, weight: 0.2 },
          voiceMaturity: { points: breakdown.voiceMaturity, max: 150, weight: 0.15 },
          feedback: { points: breakdown.feedback, max: 100, weight: 0.1 },
          streak: { points: breakdown.streak, max: 100, weight: 0.1 },
        },
        max: 1000,
        user: {
          id: input.id,
          handle: input.handle,
          displayName: input.displayName,
          avatarUrl: input.avatarUrl,
        },
      })
    );
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    console.error("atlas-score error:", err);
    res.status(500).json(error("Failed to compute Atlas Score", 500));
  }
});

// Leaderboard — top 20 users by Atlas Score
analyticsRouter.get("/leaderboard", async (req: AuthRequest, res) => {
  try {
    emptyQuerySchema.parse(req.query);

    const users = await prisma.user.findMany({
      select: {
        id: true,
        handle: true,
        displayName: true,
        avatarUrl: true,
        voiceProfile: {
          select: { maturity: true, tweetsAnalyzed: true },
        },
        tweetDrafts: {
          select: {
            status: true,
            predictedEngagement: true,
            actualEngagement: true,
            createdAt: true,
          },
        },
      },
    });

    // Batch fetch feedback counts for all users
    const feedbackEvents = await prisma.analyticsEvent.groupBy({
      by: ["userId"],
      where: { type: "FEEDBACK_GIVEN" },
      _count: { userId: true },
    });
    const feedbackByUser = new Map<string, number>();
    for (const e of feedbackEvents) {
      feedbackByUser.set(e.userId, e._count.userId);
    }

    const scored = users.map((u) => {
      const input: ScoreUserInput = {
        id: u.id,
        handle: u.handle,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl,
        voiceProfile: u.voiceProfile,
        drafts: u.tweetDrafts.map((d) => ({
          status: d.status,
          predictedEngagement: d.predictedEngagement,
          actualEngagement: d.actualEngagement,
        })),
        feedbackCount: feedbackByUser.get(u.id) ?? 0,
        activityDates: u.tweetDrafts.map((d) => d.createdAt),
      };
      const breakdown = computeAtlasScore(input);
      return {
        userId: u.id,
        handle: u.handle,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl,
        score: breakdown.total,
        breakdown,
      };
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 20).map((entry, i) => ({ rank: i + 1, ...entry }));

    // Find current user's rank if not in top 20
    let currentUserRank: number | null = null;
    const currentUserIndex = scored.findIndex((s) => s.userId === req.userId);
    if (currentUserIndex >= 0) {
      currentUserRank = currentUserIndex + 1;
    }

    res.json(
      success({
        leaderboard: top,
        totalUsers: scored.length,
        currentUserRank,
      })
    );
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    console.error("leaderboard error:", err);
    res.status(500).json(error("Failed to load leaderboard", 500));
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

    // Real consecutive-day streaks (drafts + feedback + voice + sessions + ...)
    // replace the session-count proxy the portal used to display. If the
    // streak query fails we still return the base team payload — the streak
    // fields just default to zero/broken.
    const analystIds = analysts.map((a) => a.id);
    const streakMap = new Map<string, { currentStreak: number; longestStreak: number; status: string }>();
    if (analystIds.length > 0) {
      try {
        const events = await prisma.analyticsEvent.findMany({
          where: { userId: { in: analystIds } },
          select: { userId: true, createdAt: true },
        });
        const eventRows = Array.isArray(events) ? events : [];
        const byUser = new Map<string, Date[]>();
        for (const id of analystIds) byUser.set(id, []);
        for (const e of eventRows) byUser.get(e.userId)?.push(e.createdAt);
        for (const [uid, dates] of byUser.entries()) {
          const s = calculateStreakFromDates(dates);
          streakMap.set(uid, {
            currentStreak: s.currentStreak,
            longestStreak: s.longestStreak,
            status: s.status,
          });
        }
      } catch {
        // swallow — streak is a nice-to-have, not load-bearing
      }
    }

    res.json(success({
      analysts: analysts.map(({ passwordHash, ...a }) => {
        const streak = streakMap.get(a.id);
        return {
          ...a,
          currentStreak: streak?.currentStreak ?? 0,
          longestStreak: streak?.longestStreak ?? 0,
          streakStatus: streak?.status ?? "broken",
        };
      }),
    }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to load team analytics", 500));
  }
});
