export interface ArenaUser {
  id: string;
  handle: string;
  displayName?: string | null;
  avatarUrl?: string | null;
}

export interface ArenaPublishedDraft {
  id: string;
  userId: string;
  publishedAt: Date;
  predictedEngagement?: number | null;
  engagementMetrics?: unknown;
}

export interface ArenaLeaderboardEntry {
  rank: number;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  tweetsPublished: number;
  totalEngagement: number;
  consistencyStreak: number;
  badge: string;
}

export type ArenaPeriod = "last_7_days" | "last_30_days" | "all_time";

export interface ArenaLeaderboardResult {
  period: ArenaPeriod;
  entries: ArenaLeaderboardEntry[];
  userRank: ArenaLeaderboardEntry | null;
}

type LeaderboardComputation = Omit<ArenaLeaderboardEntry, "rank" | "badge"> & {
  postsPerWeek: number;
  compositeScore: number;
};

function toUtcDayStart(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function getNumericMetric(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function getWeekBucket(value: Date): string {
  const midnightUtc = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const day = midnightUtc.getUTCDay() || 7;
  midnightUtc.setUTCDate(midnightUtc.getUTCDate() + 4 - day);

  const yearStart = new Date(Date.UTC(midnightUtc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((midnightUtc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);

  return `${midnightUtc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function roundToSingleDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function normalize(value: number, maxValue: number): number {
  if (maxValue <= 0) return 0;
  return value / maxValue;
}

export function calculateConsistencyStreak(postDates: Date[]): number {
  const uniqueDays = [...new Set(postDates.map(toUtcDayStart))].sort((a, b) => b - a);

  if (uniqueDays.length === 0) {
    return 0;
  }

  let streak = 1;

  for (let index = 1; index < uniqueDays.length; index += 1) {
    const previousDay = uniqueDays[index - 1];
    const currentDay = uniqueDays[index];

    if (previousDay - currentDay === 86400000) {
      streak += 1;
      continue;
    }

    break;
  }

  return streak;
}

export function getDraftTotalEngagement(draft: Pick<ArenaPublishedDraft, "engagementMetrics" | "predictedEngagement">): number {
  if (draft.engagementMetrics && typeof draft.engagementMetrics === "object" && !Array.isArray(draft.engagementMetrics)) {
    const metrics = draft.engagementMetrics as Record<string, unknown>;
    const hasBreakdown = ["likes", "retweets", "replies"].some((key) => key in metrics);

    if (hasBreakdown) {
      return (
        getNumericMetric(metrics, "likes") +
        getNumericMetric(metrics, "retweets") +
        getNumericMetric(metrics, "replies")
      );
    }
  }

  // TODO: remove this fallback once all posted drafts persist likes/retweets/replies from X.
  if (typeof draft.predictedEngagement === "number" && Number.isFinite(draft.predictedEngagement)) {
    return Math.max(0, Math.round(draft.predictedEngagement));
  }

  return 0;
}

function getBadge(entry: ArenaLeaderboardEntry): string {
  if (entry.tweetsPublished === 0) return "Getting Started";
  if (entry.consistencyStreak >= 7) return "On Fire";
  if (entry.rank === 1) return "Top of the Table";
  if (entry.totalEngagement >= 1000) return "Heavy Hitter";
  if (entry.tweetsPublished >= 10) return "Locked In";
  if (entry.consistencyStreak >= 3) return "Building Momentum";
  return "In the Mix";
}

export function buildArenaLeaderboard(input: {
  users: ArenaUser[];
  publishedDrafts: ArenaPublishedDraft[];
  requestingUserId: string;
  period?: ArenaPeriod;
}): ArenaLeaderboardResult {
  const statsByUser = new Map<string, {
    user: ArenaUser;
    tweetsPublished: number;
    totalEngagement: number;
    postDates: Date[];
  }>();

  for (const user of input.users) {
    statsByUser.set(user.id, {
      user,
      tweetsPublished: 0,
      totalEngagement: 0,
      postDates: [],
    });
  }

  for (const draft of input.publishedDrafts) {
    const stats = statsByUser.get(draft.userId);
    if (!stats) continue;

    stats.tweetsPublished += 1;
    stats.totalEngagement += getDraftTotalEngagement(draft);
    stats.postDates.push(draft.publishedAt);
  }

  const computed = [...statsByUser.values()]
    .map<LeaderboardComputation>((stats) => {
      const displayName = stats.user.displayName?.trim() || stats.user.handle;
      const consistencyStreak = calculateConsistencyStreak(stats.postDates);
      const postsPerWeek = roundToSingleDecimal((stats.tweetsPublished / 30) * 7);

      return {
        userId: stats.user.id,
        displayName,
        avatarUrl: stats.user.avatarUrl ?? null,
        tweetsPublished: stats.tweetsPublished,
        totalEngagement: stats.totalEngagement,
        consistencyStreak,
        postsPerWeek,
        compositeScore: 0,
      };
    })
    .filter((entry) => entry.tweetsPublished > 0 || entry.userId === input.requestingUserId);

  const maxTweets = Math.max(...computed.map((entry) => entry.tweetsPublished), 0);
  const maxEngagement = Math.max(...computed.map((entry) => entry.totalEngagement), 0);
  const maxPostsPerWeek = Math.max(...computed.map((entry) => entry.postsPerWeek), 0);
  const maxStreak = Math.max(...computed.map((entry) => entry.consistencyStreak), 0);

  for (const entry of computed) {
    const outputScore = normalize(entry.tweetsPublished, maxTweets);
    const engagementScore = normalize(entry.totalEngagement, maxEngagement);
    const consistencyScore =
      normalize(entry.postsPerWeek, maxPostsPerWeek) * 0.65 +
      normalize(entry.consistencyStreak, maxStreak) * 0.35;

    entry.compositeScore =
      outputScore * 0.35 +
      engagementScore * 0.45 +
      consistencyScore * 0.2;
  }

  const entries = computed
    .sort((left, right) => {
      if (right.compositeScore !== left.compositeScore) {
        return right.compositeScore - left.compositeScore;
      }
      if (right.totalEngagement !== left.totalEngagement) {
        return right.totalEngagement - left.totalEngagement;
      }
      if (right.tweetsPublished !== left.tweetsPublished) {
        return right.tweetsPublished - left.tweetsPublished;
      }
      if (right.consistencyStreak !== left.consistencyStreak) {
        return right.consistencyStreak - left.consistencyStreak;
      }
      return left.displayName.localeCompare(right.displayName);
    })
    .map<ArenaLeaderboardEntry>((entry, index) => {
      const rankedEntry: ArenaLeaderboardEntry = {
        rank: index + 1,
        userId: entry.userId,
        displayName: entry.displayName,
        avatarUrl: entry.avatarUrl,
        tweetsPublished: entry.tweetsPublished,
        totalEngagement: entry.totalEngagement,
        consistencyStreak: entry.consistencyStreak,
        badge: "",
      };

      return {
        ...rankedEntry,
        badge: getBadge(rankedEntry),
      };
    });

  return {
    period: input.period ?? "last_30_days",
    entries,
    userRank: entries.find((entry) => entry.userId === input.requestingUserId) ?? null,
  };
}
