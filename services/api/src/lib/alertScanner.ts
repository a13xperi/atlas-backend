/**
 * Alert Scanner — background and manual trending-scan orchestrator.
 *
 * Extracted from routes/trending.ts so the scheduler can auto-fire alerts
 * without requiring a user to manually hit POST /trending/scan.
 */

import { prisma } from "./prisma";
import { searchTrending, TrendingItem } from "./grok";
import { logger } from "./logger";
import { matchMonitorKeywords } from "../routes/monitors";
import { emitToUser } from "./socket";
import { dispatchAlert } from "./alertDelivery";

export interface ScanResult {
  alerts: number;
  monitorAlerts: number;
  alertObjects: any[];
  monitorAlertObjects: any[];
}

/**
 * Run a trending scan for a single user, create Alerts, evaluate NLP monitors,
 * and push real-time notifications via WebSocket + Telegram.
 */
export async function scanTrendingForUser(
  userId: string,
  explicitTopics?: string[]
): Promise<ScanResult> {
  let topics: string[];

  if (explicitTopics && explicitTopics.length > 0) {
    topics = explicitTopics;
  } else {
    const subscriptions = await prisma.alertSubscription.findMany({
      where: { userId, isActive: true },
    });
    topics =
      subscriptions.length > 0
        ? subscriptions.map((s) => s.value)
        : ["DeFi", "ETH", "Bitcoin", "AI", "Crypto"];
  }

  const items = await searchTrending({ topics, limit: 10 });

  // Create base alerts
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
          userId,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      })
    )
  );

  // Push real-time + dispatch delivery for base alerts
  for (const a of alerts) {
    emitToUser(userId, "alert:new", a);
    dispatchAlert({
      id: a.id,
      title: a.title,
      type: a.type,
      context: a.context,
      sourceUrl: a.sourceUrl,
      sentiment: a.sentiment,
      userId: a.userId,
    }).catch((err) =>
      logger.error({ err: err.message, alertId: a.id }, "[alertScanner] dispatchAlert failed")
    );
  }

  // Evaluate NLP monitors
  let monitorAlerts: typeof alerts = [];
  try {
    const monitors = await prisma.nlpMonitor.findMany({
      where: { userId, isActive: true },
    });

    for (const monitor of monitors) {
      const monitorHits: typeof alerts = [];
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
              userId,
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            },
          });
          monitorHits.push(alert);
          monitorAlerts.push(alert);
          emitToUser(userId, "alert:new", alert);
          dispatchAlert({
            id: alert.id,
            title: alert.title,
            type: alert.type,
            context: alert.context,
            sourceUrl: alert.sourceUrl,
            sentiment: alert.sentiment,
            userId: alert.userId,
          }).catch((err) =>
            logger.error(
              { err: err.message, alertId: alert.id },
              "[alertScanner] dispatchAlert (monitor) failed"
            )
          );
        }
      }
      if (monitorHits.length > 0) {
        await prisma.nlpMonitor.update({
          where: { id: monitor.id },
          data: { matchCount: { increment: monitorHits.length } },
        });
      }
    }
  } catch (monitorErr: any) {
    logger.warn({ err: monitorErr.message }, "Monitor matching failed (non-blocking)");
  }

  // Analytics
  await prisma.analyticsEvent.create({
    data: {
      userId,
      type: "ALERT_GENERATED",
      value: alerts.length + monitorAlerts.length,
    },
  });

  return {
    alerts: alerts.length,
    monitorAlerts: monitorAlerts.length,
    alertObjects: alerts,
    monitorAlertObjects: monitorAlerts,
  };
}

export interface GlobalScanResult {
  users: number;
  alerts: number;
  monitorAlerts: number;
  failed: number;
}

/**
 * Run a trending scan for every user that has at least one active alert
 * subscription or NLP monitor. Processes users sequentially to avoid
 * rate-limiting the Grok API (Redis caching already deduplicates identical
 * topic sets within the 5-minute TTL).
 */
export async function runGlobalAlertScan(): Promise<GlobalScanResult> {
  const [subUsers, monitorUsers] = await Promise.all([
    prisma.alertSubscription.findMany({
      where: { isActive: true },
      select: { userId: true },
      distinct: ["userId"],
    }),
    prisma.nlpMonitor.findMany({
      where: { isActive: true },
      select: { userId: true },
      distinct: ["userId"],
    }),
  ]);

  const userIdSet = new Set<string>();
  subUsers.forEach((s) => userIdSet.add(s.userId));
  monitorUsers.forEach((m) => userIdSet.add(m.userId));

  const userIds = Array.from(userIdSet);
  let totalAlerts = 0;
  let totalMonitorAlerts = 0;
  let failed = 0;

  for (const userId of userIds) {
    try {
      const result = await scanTrendingForUser(userId);
      totalAlerts += result.alerts;
      totalMonitorAlerts += result.monitorAlerts;
    } catch (err: any) {
      logger.error({ err: err.message, userId }, "Global alert scan failed for user");
      failed++;
    }
  }

  return {
    users: userIds.length,
    alerts: totalAlerts,
    monitorAlerts: totalMonitorAlerts,
    failed,
  };
}
