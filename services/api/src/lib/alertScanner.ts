/**
 * Alert Scanner — background and manual trending-scan orchestrator.
 *
 * Extracted from routes/trending.ts so the scheduler can auto-fire alerts
 * without requiring a user to manually hit POST /trending/scan.
 */

import { prisma } from "./prisma";
import { AlertCategory } from "@prisma/client";
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

  // Process NLP monitors against stored trending topics
  try {
    await processNlpMonitors();
  } catch (err: any) {
    logger.error({ err: err.message }, "NLP monitor processing failed (non-blocking)");
  }

  return {
    users: userIds.length,
    alerts: totalAlerts,
    monitorAlerts: totalMonitorAlerts,
    failed,
  };
}

// ============================================================
// NLP Monitor Processing
// ============================================================

/**
 * Process all active NLP monitors and create alerts for matching trending content
 */
async function processNlpMonitors(): Promise<void> {
  const startTime = Date.now();
  logger.info("Starting NLP monitor scan");

  const activeMonitors = await prisma.nlpMonitor.findMany({
    where: { isActive: true },
    include: {
      user: {
        select: {
          id: true,
          email: true,
        },
      },
    },
  });

  logger.info({ count: activeMonitors.length }, "Found active NLP monitors");

  if (activeMonitors.length === 0) {
    return;
  }

  const recentTrending = await getRecentTrendingTopics();

  if (recentTrending.length === 0) {
    logger.info("No recent trending topics found");
    return;
  }

  logger.info({ count: recentTrending.length }, "Checking trending topics against monitors");

  const results = await Promise.allSettled(
    activeMonitors.map((monitor) => checkMonitorAgainstTrending(monitor, recentTrending))
  );

  const successful = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;

  const duration = Date.now() - startTime;
  logger.info(
    {
      duration: `${duration}ms`,
      monitorsProcessed: activeMonitors.length,
      successful,
      failed,
    },
    "NLP monitor scan completed"
  );
}

/**
 * Fetch trending topics from the last scan window (15 minutes)
 */
async function getRecentTrendingTopics(): Promise<
  Array<{
    id: string;
    title: string;
    content: string;
    keywords: string[];
    score: number;
    category: string;
    source: string;
    url: string | null;
  }>
> {
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);

  const trending = await prisma.trendingTopic.findMany({
    where: {
      createdAt: { gte: fifteenMinutesAgo },
      isActive: true,
    },
    select: {
      id: true,
      title: true,
      content: true,
      keywords: true,
      score: true,
      category: true,
      source: true,
      url: true,
    },
    orderBy: { score: "desc" },
    take: 100,
  });

  return trending;
}

/**
 * Check a single NLP monitor against trending topics
 */
async function checkMonitorAgainstTrending(
  monitor: {
    id: string;
    userId: string;
    name: string;
    keywords: string[];
    minRelevance: number;
    delivery: string[];
    isActive: boolean;
    matchCount: number;
    createdAt: Date;
    updatedAt: Date;
    user: {
      id: string;
      email: string | null;
    };
  },
  trendingTopics: Array<{
    id: string;
    title: string;
    content: string;
    keywords: string[];
    score: number;
    category: string;
    source: string;
    url: string | null;
  }>
): Promise<void> {
  const { userId, keywords, minRelevance } = monitor;

  const matches: Array<{
    topic: (typeof trendingTopics)[0];
    relevance: number;
  }> = [];

  for (const topic of trendingTopics) {
    const relevance = calculateRelevance(topic, keywords);
    if (relevance >= Math.round(minRelevance * 100)) {
      matches.push({ topic, relevance });
    }
  }

  if (matches.length === 0) {
    return;
  }

  logger.debug(
    {
      monitorId: monitor.id,
      keywords,
      matchCount: matches.length,
      userId,
    },
    "Found matches for user"
  );

  await processMonitorMatches(monitor, matches);
}

/**
 * Calculate relevance score between trending topic and monitor keywords
 * Returns a score from 0 to 100
 */
function calculateRelevance(
  topic: {
    title: string;
    content: string;
    keywords: string[];
  },
  monitorKeywords: string[]
): number {
  if (!monitorKeywords.length) {
    return 0;
  }

  const topicText = `${topic.title} ${topic.content}`.toLowerCase();
  const topicKeywords = topic.keywords.map((k) => k.toLowerCase());

  let score = 0;
  let matchCount = 0;

  for (const keyword of monitorKeywords) {
    const normalizedKeyword = keyword.toLowerCase().trim();
    if (!normalizedKeyword) {
      continue;
    }

    const textMatches = (topicText.match(new RegExp(normalizeRegex(normalizedKeyword), "gi")) || []).length;
    const keywordMatches = topicKeywords.filter(
      (tk) => tk.includes(normalizedKeyword) || normalizedKeyword.includes(tk)
    ).length;

    const titleBonus = topic.title.toLowerCase().includes(normalizedKeyword) ? 10 : 0;

    const keywordScore = Math.min(textMatches * 5, 25) + keywordMatches * 15 + titleBonus;

    score += keywordScore;
    if (keywordScore > 0) {
      matchCount++;
    }
  }

  const maxPossibleScore = monitorKeywords.length * 50;
  const normalizedScore = Math.min((score / maxPossibleScore) * 100, 100);
  const keywordMatchRatio = matchCount / monitorKeywords.length;
  const adjustedScore = normalizedScore * (0.5 + 0.5 * keywordMatchRatio);

  return Math.round(adjustedScore);
}

/**
 * Normalize string for regex matching
 */
function normalizeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Process matches for a monitor and create alerts
 */
async function processMonitorMatches(
  monitor: {
    id: string;
    userId: string;
    name: string;
    keywords: string[];
    minRelevance: number;
    delivery: string[];
    isActive: boolean;
    matchCount: number;
    createdAt: Date;
    updatedAt: Date;
    user: {
      id: string;
      email: string | null;
    };
  },
  matches: Array<{
    topic: {
      id: string;
      title: string;
      content: string;
      keywords: string[];
      score: number;
      category: string;
      source: string;
      url: string | null;
    };
    relevance: number;
  }>
): Promise<void> {
  const { userId, id: monitorId } = monitor;

  const recentAlertCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentAlerts = await prisma.alert.findMany({
    where: {
      userId,
      type: "MONITOR",
      createdAt: { gte: recentAlertCutoff },
    },
    select: { context: true },
  });

  const recentTopicIds = new Set(
    recentAlerts
      .map((a) => {
        try {
          const parsed = JSON.parse(a.context || "{}");
          return parsed.topicId;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  );

  const newMatches = matches.filter((m) => !recentTopicIds.has(m.topic.id));

  if (newMatches.length === 0) {
    return;
  }

  const canSend = await checkDeliveryRateLimit(userId);
  if (!canSend) {
    logger.debug(
    {
      monitorId,
      matchCount: newMatches.length,
      userId,
    },
    "Rate limited alerts for user"
  );
    return;
  }

  const sortedMatches = newMatches.sort((a, b) => b.relevance - a.relevance);
  const maxAlerts = 5;
  const alertsToProcess = sortedMatches.slice(0, maxAlerts);

  const alertsToCreate: Array<{
    id: string;
    userId: string;
    type: string;
    title: string;
    context: string;
    sourceUrl?: string;
    relevance: number;
    category: AlertCategory;
    expiresAt: Date;
    createdAt: Date;
  }> = [];

  for (const match of alertsToProcess) {
    const alertId = generateAlertId();
    alertsToCreate.push({
      id: alertId,
      userId,
      type: "MONITOR",
      title: `Keyword Match: ${match.topic.title}`,
      context: JSON.stringify({
        monitorId,
        topicId: match.topic.id,
        topicTitle: match.topic.title,
        topicUrl: match.topic.url,
        topicCategory: match.topic.category,
        topicSource: match.topic.source,
        matchedKeywords: getMatchedKeywords(match.topic, monitor.keywords),
        relevance: match.relevance,
        keywords: monitor.keywords,
      }),
      sourceUrl: match.topic.url || undefined,
      relevance: match.relevance / 100,
      category: AlertCategory.NOTIFICATION,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      createdAt: new Date(),
    });
  }

  if (alertsToCreate.length > 0) {
    await prisma.alert.createMany({ data: alertsToCreate });

    logger.info(
      {
        monitorId,
        topicIds: alertsToProcess.map((m) => m.topic.id),
        userId,
        count: alertsToCreate.length,
      },
      "Created NLP monitor alerts for user"
    );

    for (const alert of alertsToCreate) {
      emitToUser(userId, "alert:new", alert);
      dispatchAlert({
        id: alert.id,
        title: alert.title,
        type: alert.type,
        context: alert.context,
        sourceUrl: alert.sourceUrl,
        userId: alert.userId,
      }).catch((err) =>
        logger.error(
          { err: err.message, alertId: alert.id },
          "[alertScanner] dispatchAlert (nlp monitor) failed"
        )
      );
    }
  }
}

/**
 * Get list of keywords that matched for a topic
 */
function getMatchedKeywords(
  topic: { title: string; content: string; keywords: string[] },
  monitorKeywords: string[]
): string[] {
  const topicText = `${topic.title} ${topic.content}`.toLowerCase();

  return monitorKeywords.filter((keyword) => {
    const normalized = keyword.toLowerCase();
    return (
      topicText.includes(normalized) ||
      topic.keywords.some((tk) => tk.toLowerCase().includes(normalized))
    );
  });
}

/**
 * Check if user is within delivery rate limits
 */
async function checkDeliveryRateLimit(userId: string): Promise<boolean> {
  const maxPerHour = 10;
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const recentCount = await prisma.alert.count({
    where: {
      userId,
      type: "MONITOR",
      createdAt: { gte: oneHourAgo },
    },
  });

  return recentCount < maxPerHour;
}

/**
 * Generate unique alert ID
 */
function generateAlertId(): string {
  return `nlp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export { processNlpMonitors };
