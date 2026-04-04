/**
 * Background scheduler — processes scheduled drafts every 60 seconds.
 * Runs inside the main API process (no separate worker needed).
 */

import { prisma } from "./prisma";
import { logger } from "./logger";

const POLL_INTERVAL_MS = 60_000; // Check every minute

async function processScheduledDrafts(): Promise<{ posted: number; failed: number }> {
  const now = new Date();

  const dueDrafts = await prisma.tweetDraft.findMany({
    where: { status: "SCHEDULED", scheduledAt: { lte: now } },
    include: {
      user: {
        select: {
          id: true,
          xAccessToken: true,
          xRefreshToken: true,
          xTokenExpiresAt: true,
        },
      },
    },
    take: 10, // Process max 10 per cycle to avoid long locks
  });

  if (dueDrafts.length === 0) return { posted: 0, failed: 0 };

  const { postTweet, refreshAccessToken } = await import("./twitter");
  let posted = 0;
  let failed = 0;

  for (const draft of dueDrafts) {
    try {
      if (!draft.user.xAccessToken) {
        // No X token — move back to APPROVED so user can post manually
        await prisma.tweetDraft.update({
          where: { id: draft.id },
          data: { status: "APPROVED" },
        });
        logger.warn({ draftId: draft.id, userId: draft.userId }, "Scheduled draft moved to APPROVED — no X token");
        failed++;
        continue;
      }

      // Refresh token if expired
      let accessToken = draft.user.xAccessToken;
      if (draft.user.xTokenExpiresAt && draft.user.xTokenExpiresAt < now && draft.user.xRefreshToken) {
        const refreshed = await refreshAccessToken(draft.user.xRefreshToken);
        accessToken = refreshed.accessToken;
        await prisma.user.update({
          where: { id: draft.userId },
          data: {
            xAccessToken: refreshed.accessToken,
            xRefreshToken: refreshed.refreshToken,
            xTokenExpiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
          },
        });
      }

      // Post to X
      const tweet = await postTweet(accessToken, draft.content);

      await prisma.tweetDraft.update({
        where: { id: draft.id },
        data: { status: "POSTED" },
      });

      await prisma.analyticsEvent.create({
        data: {
          userId: draft.userId,
          type: "DRAFT_POSTED",
          metadata: { tweetId: tweet.id, draftId: draft.id, scheduled: true },
        },
      });

      logger.info({ draftId: draft.id, tweetId: tweet.id }, "Scheduled draft posted to X");
      posted++;
    } catch (err: any) {
      logger.error({ err: err.message, draftId: draft.id }, "Failed to post scheduled draft");
      failed++;
    }
  }

  return { posted, failed };
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startScheduler(): void {
  if (intervalId) return; // Already running

  logger.info("Starting draft scheduler (60s interval)");

  intervalId = setInterval(async () => {
    try {
      const result = await processScheduledDrafts();
      if (result.posted > 0 || result.failed > 0) {
        logger.info(result, "Scheduler cycle complete");
      }
    } catch (err: any) {
      logger.error({ err: err.message }, "Scheduler cycle failed");
    }
  }, POLL_INTERVAL_MS);

  // Run once immediately on startup
  void processScheduledDrafts().catch((err) => {
    logger.error({ err: err.message }, "Initial scheduler run failed");
  });
}

export function stopScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info("Draft scheduler stopped");
  }
}
