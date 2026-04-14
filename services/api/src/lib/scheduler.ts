/**
 * Background scheduler — processes scheduled drafts every 60 seconds.
 * Runs inside the main API process (no separate worker needed).
 */

import { prisma } from "./prisma";
import { logger } from "./logger";
import { runScheduledBackupIfDue } from "./backup";
import { runGlobalAlertScan } from "./alertScanner";
import {
  buildTokenWrite,
  readAccessToken,
  readRefreshToken,
  TOKEN_READ_SELECT,
} from "./crypto";

const POLL_INTERVAL_MS = 60_000; // Check every minute

async function processScheduledDrafts(): Promise<{ posted: number; failed: number }> {
  const now = new Date();

  const dueDrafts = await prisma.tweetDraft.findMany({
    where: { status: "SCHEDULED", scheduledAt: { lte: now } },
    include: {
      user: {
        select: {
          id: true,
          xTokenExpiresAt: true,
          ...TOKEN_READ_SELECT,
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
      let accessToken = readAccessToken(draft.user);
      if (!accessToken) {
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
      const draftRefreshToken = readRefreshToken(draft.user);
      if (draft.user.xTokenExpiresAt && draft.user.xTokenExpiresAt < now && draftRefreshToken) {
        const refreshed = await refreshAccessToken(draftRefreshToken);
        accessToken = refreshed.accessToken;
        await prisma.user.update({
          where: { id: draft.userId },
          data: buildTokenWrite({
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
          }),
        });
      }

      // Post to X
      const tweet = await postTweet(accessToken, draft.content);

      await prisma.tweetDraft.update({
        where: { id: draft.id },
        data: { status: "POSTED", xTweetId: tweet.id },
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

      // Move back to APPROVED so it doesn't retry infinitely on the next 60s cycle
      // and surface the failure via an analytics event the user can see.
      try {
        await prisma.tweetDraft.update({
          where: { id: draft.id },
          data: { status: "APPROVED" },
        });
        await prisma.analyticsEvent.create({
          data: {
            userId: draft.userId,
            // DRAFT_SCHEDULE_FAILED isn't in the AnalyticsType enum yet —
            // reuse DRAFT_POSTED with failed: true so the failure is queryable.
            type: "DRAFT_POSTED",
            metadata: {
              draftId: draft.id,
              failed: true,
              error: err.message,
              scheduledAt: draft.scheduledAt,
            },
          },
        });
        logger.warn({ draftId: draft.id }, "Scheduled draft moved back to APPROVED after failure");
      } catch (updateErr: any) {
        logger.error(
          { err: updateErr.message, draftId: draft.id },
          "Failed to reset draft status after posting failure"
        );
      }
    }
  }

  return { posted, failed };
}

// --- Engagement Metrics Auto-Pull ---

const METRICS_INTERVAL_MS = 15 * 60_000; // Every 15 minutes

/**
 * Fetch X metrics for recently posted drafts that have a tweet ID.
 * Updates actualEngagement + engagementMetrics on each draft.
 */
async function fetchPostedDraftMetrics(): Promise<{ updated: number; failed: number }> {
  // Find POSTED drafts with tweet IDs that haven't been checked in 4+ hours
  // (or never checked)
  const cutoff = new Date(Date.now() - 4 * 60 * 60_000);
  const drafts = await prisma.tweetDraft.findMany({
    where: {
      status: "POSTED",
      xTweetId: { not: null },
      OR: [
        { metricsLastFetchedAt: null },
        { metricsLastFetchedAt: { lt: cutoff } },
      ],
    },
    select: { id: true, xTweetId: true },
    take: 50,
    orderBy: { updatedAt: "desc" },
  });

  if (drafts.length === 0) return { updated: 0, failed: 0 };

  let updated = 0;
  let failed = 0;

  try {
    const { getTweetsWithMetrics } = await import("./twitter");
    const tweetIds = drafts.map((d) => d.xTweetId!);
    const metrics = await getTweetsWithMetrics(tweetIds);

    const metricsMap = new Map(metrics.map((m) => [m.id, m.public_metrics]));

    for (const draft of drafts) {
      const m = metricsMap.get(draft.xTweetId!);
      if (!m) { failed++; continue; }

      await prisma.tweetDraft.update({
        where: { id: draft.id },
        data: {
          actualEngagement: m.impression_count,
          engagementMetrics: {
            likes: m.like_count,
            retweets: m.retweet_count,
            replies: m.reply_count,
            impressions: m.impression_count,
            bookmarks: m.bookmark_count,
          },
          metricsLastFetchedAt: new Date(),
        },
      });
      updated++;
    }
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to fetch tweet metrics");
    failed = drafts.length;
  }

  return { updated, failed };
}

// Export for use in the manual endpoint
export { fetchPostedDraftMetrics };

let intervalId: ReturnType<typeof setInterval> | null = null;
let metricsIntervalId: ReturnType<typeof setInterval> | null = null;
let backupIntervalId: ReturnType<typeof setInterval> | null = null;
let alertScanIntervalId: ReturnType<typeof setInterval> | null = null;

const ALERT_SCAN_INTERVAL_MS = 15 * 60_000; // Every 15 minutes

export function startScheduler(): void {
  if (intervalId) return; // Already running

  logger.info("Starting draft scheduler (60s interval) + metrics fetcher (15m interval) + backup scheduler (60s interval) + alert scanner (15m interval)");

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

  metricsIntervalId = setInterval(async () => {
    try {
      const result = await fetchPostedDraftMetrics();
      if (result.updated > 0 || result.failed > 0) {
        logger.info(result, "Metrics fetch cycle complete");
      }
    } catch (err: any) {
      logger.error({ err: err.message }, "Metrics fetch cycle failed");
    }
  }, METRICS_INTERVAL_MS);

  backupIntervalId = setInterval(async () => {
    try {
      const result = await runScheduledBackupIfDue();
      if (result) {
        logger.info(
          {
            backupLogId: result.id,
            provider: result.provider,
            storageUrl: result.storageUrl,
          },
          "Scheduled backup cycle complete"
        );
      }
    } catch (err: any) {
      logger.error({ err: err.message }, "Scheduled backup cycle failed");
    }
  }, POLL_INTERVAL_MS);

  alertScanIntervalId = setInterval(async () => {
    try {
      const result = await runGlobalAlertScan();
      if (result.users > 0) {
        logger.info(result, "Alert scan cycle complete");
      }
    } catch (err: any) {
      logger.error({ err: err.message }, "Alert scan cycle failed");
    }
  }, ALERT_SCAN_INTERVAL_MS);

  // Run once immediately on startup
  void processScheduledDrafts().catch((err) => {
    logger.error({ err: err.message }, "Initial scheduler run failed");
  });
  // Delay initial metrics fetch by 30s to avoid startup burst
  setTimeout(() => {
    void fetchPostedDraftMetrics().catch((err) => {
      logger.error({ err: err.message }, "Initial metrics fetch failed");
    });
  }, 30_000);
  void runScheduledBackupIfDue().catch((err) => {
    logger.error({ err: err.message }, "Initial backup scheduler check failed");
  });
  // Delay initial alert scan by 60s to avoid startup burst
  setTimeout(() => {
    void runGlobalAlertScan().catch((err) => {
      logger.error({ err: err.message }, "Initial alert scan failed");
    });
  }, 60_000);
}

export function stopScheduler(): void {
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
  if (metricsIntervalId) { clearInterval(metricsIntervalId); metricsIntervalId = null; }
  if (backupIntervalId) { clearInterval(backupIntervalId); backupIntervalId = null; }
  if (alertScanIntervalId) { clearInterval(alertScanIntervalId); alertScanIntervalId = null; }
  logger.info("Schedulers stopped");
}
