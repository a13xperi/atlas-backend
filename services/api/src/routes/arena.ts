import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { error, success } from "../lib/response";
import { authenticate, AuthRequest } from "../middleware/auth";
import { buildArenaLeaderboard, type ArenaPublishedDraft } from "../lib/arena";

export const arenaRouter = Router();
arenaRouter.use(authenticate);

const leaderboardQuerySchema = z.object({
  period: z.enum(["last_30_days"]).optional(),
});

function getDraftId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const draftId = (metadata as { draftId?: unknown }).draftId;
  return typeof draftId === "string" && draftId.length > 0 ? draftId : null;
}

arenaRouter.get("/leaderboard", async (req: AuthRequest, res) => {
  const parsed = leaderboardQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(error("Invalid request", 400, parsed.error.errors));
  }

  try {
    // TODO: scope this to the viewer's organization once team/org membership exists in the schema.
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { role: "ANALYST" },
          { id: req.userId! },
        ],
      },
      select: {
        id: true,
        handle: true,
        displayName: true,
        avatarUrl: true,
      },
      orderBy: { handle: "asc" },
    });

    if (users.length === 0) {
      return res.json(success({
        period: "last_30_days" as const,
        entries: [],
        userRank: null,
      }));
    }

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    thirtyDaysAgo.setHours(0, 0, 0, 0);

    const userIds = users.map((user) => user.id);

    const postEvents = await prisma.analyticsEvent.findMany({
      where: {
        userId: { in: userIds },
        type: "DRAFT_POSTED",
        createdAt: { gte: thirtyDaysAgo },
      },
      select: {
        id: true,
        userId: true,
        createdAt: true,
        metadata: true,
      },
      orderBy: { createdAt: "desc" },
    });

    const draftIds = [...new Set(postEvents.map((event) => getDraftId(event.metadata)).filter(Boolean))] as string[];

    const drafts = draftIds.length > 0
      ? await prisma.tweetDraft.findMany({
          where: { id: { in: draftIds } },
          select: {
            id: true,
            userId: true,
            predictedEngagement: true,
            engagementMetrics: true,
          },
        })
      : [];

    const draftsById = new Map(drafts.map((draft) => [draft.id, draft]));
    const publishedDrafts: ArenaPublishedDraft[] = [];
    const seenKeys = new Set<string>();

    for (const event of postEvents) {
      const draftId = getDraftId(event.metadata);
      const eventKey = draftId ?? `event:${event.id}`;

      if (seenKeys.has(eventKey)) {
        continue;
      }

      seenKeys.add(eventKey);
      const draft = draftId ? draftsById.get(draftId) : undefined;

      publishedDrafts.push({
        id: draftId ?? event.id,
        userId: draft?.userId ?? event.userId,
        publishedAt: event.createdAt,
        predictedEngagement: draft?.predictedEngagement ?? null,
        engagementMetrics: draft?.engagementMetrics ?? null,
      });
    }

    const leaderboard = buildArenaLeaderboard({
      users,
      publishedDrafts,
      requestingUserId: req.userId!,
    });

    res.json(success({
      period: leaderboard.period,
      entries: leaderboard.entries,
      userRank: leaderboard.userRank,
    }));
  } catch (err: any) {
    res.status(500).json(error("Failed to load arena leaderboard", 500));
  }
});
