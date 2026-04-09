import { Router, Response } from "express";
import { prisma } from "../lib/prisma";
import { error, success } from "../lib/response";
import { authenticate, AuthRequest } from "../middleware/auth";

export const adminRouter = Router();
adminRouter.use(authenticate);

/** Require ADMIN role — returns the user or sends 403 */
async function requireAdmin(req: AuthRequest, res: Response): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user || user.role !== "ADMIN") {
    res.status(403).json(error("Admin access required", 403));
    return false;
  }
  return true;
}

// GET /api/admin/overview — platform-wide KPIs
adminRouter.get("/overview", async (req: AuthRequest, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      activeUsers7dRaw,
      draftsCreated30d,
      draftsPosted30d,
      imagesGenerated30d,
      engagementAgg,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.analyticsEvent.groupBy({
        by: ["userId"],
        where: { createdAt: { gte: sevenDaysAgo } },
      }),
      prisma.analyticsEvent.count({
        where: { type: "DRAFT_CREATED", createdAt: { gte: thirtyDaysAgo } },
      }),
      prisma.analyticsEvent.count({
        where: { type: "DRAFT_POSTED", createdAt: { gte: thirtyDaysAgo } },
      }),
      prisma.analyticsEvent.count({
        where: { type: "IMAGE_GENERATED", createdAt: { gte: thirtyDaysAgo } },
      }),
      prisma.tweetDraft.aggregate({
        _avg: { actualEngagement: true, predictedEngagement: true },
        where: { status: "POSTED", createdAt: { gte: thirtyDaysAgo } },
      }),
    ]);

    res.json(
      success({
        totalUsers,
        activeUsers7d: activeUsers7dRaw.length,
        draftsCreated30d,
        draftsPosted30d,
        imagesGenerated30d,
        avgActualEngagement30d: engagementAgg._avg.actualEngagement ?? null,
        avgPredictedEngagement30d: engagementAgg._avg.predictedEngagement ?? null,
      }),
    );
  } catch (err: any) {
    res.status(500).json(error("Failed to load admin overview", 500));
  }
});

// GET /api/admin/roster — all users with usage stats
adminRouter.get("/roster", async (req: AuthRequest, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [allUsers, postCounts, eventStats] = await Promise.all([
      prisma.user.findMany({
        include: {
          voiceProfile: { select: { maturity: true, tweetsAnalyzed: true } },
          _count: { select: { tweetDrafts: true } },
        },
      }),
      prisma.tweetDraft.groupBy({
        by: ["userId"],
        where: { status: "POSTED" },
        _count: { _all: true },
      }),
      prisma.analyticsEvent.groupBy({
        by: ["userId"],
        _count: { _all: true },
        _max: { createdAt: true },
        where: { createdAt: { gte: thirtyDaysAgo } },
      }),
    ]);

    const postMap = new Map(postCounts.map((p) => [p.userId, p._count._all]));
    const eventMap = new Map(
      eventStats.map((e) => [
        e.userId,
        { count: e._count._all, lastSeen: e._max.createdAt },
      ]),
    );

    const users = allUsers.map(({ passwordHash, ...u }) => ({
      id: u.id,
      handle: u.handle,
      displayName: u.displayName,
      role: u.role,
      onboardingTrack: u.onboardingTrack,
      tourCompleted: u.tourCompleted,
      createdAt: u.createdAt.toISOString(),
      xHandle: u.xHandle,
      voiceMaturity: u.voiceProfile?.maturity ?? null,
      tweetsAnalyzed: u.voiceProfile?.tweetsAnalyzed ?? 0,
      totalDrafts: u._count.tweetDrafts,
      totalPosts: postMap.get(u.id) ?? 0,
      events30d: eventMap.get(u.id)?.count ?? 0,
      lastSeen: eventMap.get(u.id)?.lastSeen?.toISOString() ?? null,
    }));

    res.json(success({ users }));
  } catch (err: any) {
    res.status(500).json(error("Failed to load admin roster", 500));
  }
});

// GET /api/admin/pipeline — content pipeline funnel + source breakdown
adminRouter.get("/pipeline", async (req: AuthRequest, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;

    const [statusGroups, sourceGroups] = await Promise.all([
      prisma.tweetDraft.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.tweetDraft.groupBy({ by: ["sourceType"], _count: { _all: true } }),
    ]);

    const funnel: Record<string, number> = {
      DRAFT: 0,
      APPROVED: 0,
      SCHEDULED: 0,
      POSTED: 0,
      ARCHIVED: 0,
    };
    for (const s of statusGroups) {
      funnel[s.status] = s._count._all;
    }

    const sourceTypes: Record<string, number> = {
      REPORT: 0,
      ARTICLE: 0,
      TWEET: 0,
      TRENDING_TOPIC: 0,
      VOICE_NOTE: 0,
      MANUAL: 0,
    };
    for (const s of sourceGroups) {
      if (s.sourceType) {
        sourceTypes[s.sourceType] = s._count._all;
      }
    }

    res.json(success({ funnel, sourceTypes }));
  } catch (err: any) {
    res.status(500).json(error("Failed to load admin pipeline", 500));
  }
});

// GET /api/admin/adoption — feature adoption counts
adminRouter.get("/adoption", async (req: AuthRequest, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      voiceCalibrated,
      researchUsedRaw,
      alertsConfiguredRaw,
      briefingsGeneratedRaw,
      campaignsCreatedRaw,
      imagesGeneratedRaw,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.voiceProfile.count({ where: { tweetsAnalyzed: { gt: 0 } } }),
      prisma.analyticsEvent.groupBy({
        by: ["userId"],
        where: { type: "RESEARCH_CONDUCTED", createdAt: { gte: thirtyDaysAgo } },
      }),
      prisma.alertSubscription.groupBy({
        by: ["userId"],
        where: { isActive: true },
      }),
      prisma.briefing.groupBy({
        by: ["userId"],
        where: { createdAt: { gte: thirtyDaysAgo } },
      }),
      prisma.campaign.groupBy({
        by: ["userId"],
      }),
      prisma.analyticsEvent.groupBy({
        by: ["userId"],
        where: { type: "IMAGE_GENERATED", createdAt: { gte: thirtyDaysAgo } },
      }),
    ]);

    res.json(
      success({
        totalUsers,
        voiceCalibrated,
        researchUsed30d: researchUsedRaw.length,
        alertsConfigured: alertsConfiguredRaw.length,
        briefingsGenerated30d: briefingsGeneratedRaw.length,
        campaignsCreated: campaignsCreatedRaw.length,
        imagesGenerated30d: imagesGeneratedRaw.length,
      }),
    );
  } catch (err: any) {
    res.status(500).json(error("Failed to load admin adoption", 500));
  }
});

// GET /api/admin/activity-daily — 30 days of daily draft created/posted counts (all users)
adminRouter.get("/activity-daily", async (req: AuthRequest, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;

    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
    thirtyDaysAgo.setHours(0, 0, 0, 0);

    const events = await prisma.analyticsEvent.findMany({
      where: {
        type: { in: ["DRAFT_CREATED", "DRAFT_POSTED"] },
        createdAt: { gte: thirtyDaysAgo },
      },
      select: { type: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    // Pre-populate all 30 days
    const buckets = new Map<string, { created: number; posted: number }>();
    for (let i = 0; i < 30; i++) {
      const d = new Date(thirtyDaysAgo);
      d.setDate(d.getDate() + i);
      buckets.set(d.toISOString().slice(0, 10), { created: 0, posted: 0 });
    }

    for (const event of events) {
      const key = event.createdAt.toISOString().slice(0, 10);
      const bucket = buckets.get(key);
      if (!bucket) continue;
      if (event.type === "DRAFT_CREATED") bucket.created++;
      else if (event.type === "DRAFT_POSTED") bucket.posted++;
    }

    const days = Array.from(buckets.entries()).map(([date, counts]) => ({
      date,
      created: counts.created,
      posted: counts.posted,
    }));

    res.json(success({ days }));
  } catch (err: any) {
    res.status(500).json(error("Failed to load admin activity daily", 500));
  }
});

// GET /api/admin/feed — 20 most recent events across all users
adminRouter.get("/feed", async (req: AuthRequest, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;

    const rawEvents = await prisma.analyticsEvent.findMany({
      take: 20,
      orderBy: { createdAt: "desc" },
      include: { user: { select: { handle: true, displayName: true } } },
    });

    const events = rawEvents.map((e) => ({
      id: e.id,
      type: e.type,
      createdAt: e.createdAt.toISOString(),
      handle: e.user.handle,
      displayName: e.user.displayName,
      metadata: e.metadata,
    }));

    res.json(success({ events }));
  } catch (err: any) {
    res.status(500).json(error("Failed to load admin feed", 500));
  }
});
