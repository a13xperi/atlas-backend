import { prisma } from "./prisma";

/**
 * Streak tracking — real consecutive-day activity across the platform.
 *
 * An "active day" is any day (UTC) on which the user produced at least one
 * AnalyticsEvent. This covers draft creation, posting, feedback, voice
 * refinement, session starts, research, alerts, image generation, etc. —
 * anything we already instrument via `analyticsEvent`.
 *
 * Replaces the old proxies:
 *   - "session count" from `_count.sessions`
 *   - "consistency streak" based on DRAFT_POSTED events only
 */

const MS_PER_DAY = 86_400_000;

export type StreakStatus = "active" | "at_risk" | "broken";

export interface StreakResult {
  currentStreak: number;
  longestStreak: number;
  status: StreakStatus;
  lastActivityAt: Date | null;
}

/**
 * Convert a Date into the UTC-midnight timestamp of the day it falls on.
 */
export function toUtcDayStart(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

/**
 * Compute the current and longest consecutive-day streak from a list of
 * activity dates, relative to `now` (defaults to `new Date()`).
 *
 * Rules:
 *   - "Days" are bucketed by UTC midnight.
 *   - `currentStreak` counts consecutive days ending today, or yesterday if
 *     there's no activity today yet (so a streak that's still "alive" shows).
 *   - `longestStreak` is the maximum historical run of consecutive days.
 *   - `status`:
 *       `active`  — activity today
 *       `at_risk` — activity yesterday but not today
 *       `broken`  — last activity was >1 day ago (or never)
 */
export function calculateStreakFromDates(
  dates: ReadonlyArray<Date>,
  now: Date = new Date(),
): StreakResult {
  if (dates.length === 0) {
    return {
      currentStreak: 0,
      longestStreak: 0,
      status: "broken",
      lastActivityAt: null,
    };
  }

  const uniqueDays = [...new Set(dates.map(toUtcDayStart))].sort((a, b) => a - b);
  const daySet = new Set(uniqueDays);

  // Longest historical streak (walk sorted-ascending unique days).
  let longestStreak = 1;
  let runLength = 1;
  for (let i = 1; i < uniqueDays.length; i += 1) {
    const gap = uniqueDays[i] - uniqueDays[i - 1];
    if (gap === MS_PER_DAY) {
      runLength += 1;
      if (runLength > longestStreak) {
        longestStreak = runLength;
      }
    } else {
      runLength = 1;
    }
  }

  const today = toUtcDayStart(now);
  const yesterday = today - MS_PER_DAY;
  const hasToday = daySet.has(today);
  const hasYesterday = daySet.has(yesterday);

  // Current streak: walk back from today (or yesterday if today is empty).
  let currentStreak = 0;
  let cursor: number | null = null;
  if (hasToday) {
    cursor = today;
  } else if (hasYesterday) {
    cursor = yesterday;
  }

  while (cursor !== null && daySet.has(cursor)) {
    currentStreak += 1;
    cursor -= MS_PER_DAY;
  }

  // Status:
  //   active  → activity today
  //   at_risk → activity yesterday (but not today) — streak still alive for now
  //   broken  → gap of more than one day since last activity, or never
  let status: StreakStatus;
  if (hasToday) {
    status = "active";
  } else if (hasYesterday) {
    status = "at_risk";
  } else {
    status = "broken";
  }

  const mostRecentDay = uniqueDays[uniqueDays.length - 1];
  // Surface the actual last event timestamp (not just the day bucket).
  const lastActivityAt = dates.reduce<Date>((latest, d) => (d > latest ? d : latest), dates[0]);
  void mostRecentDay;

  return {
    currentStreak,
    longestStreak: Math.max(longestStreak, currentStreak),
    status,
    lastActivityAt,
  };
}

/**
 * Calculate a user's streak by querying all their AnalyticsEvent rows.
 * Every analytics event counts as activity for that day — drafts, posts,
 * feedback, voice refinements, session starts, etc.
 */
export async function calculateStreak(
  userId: string,
  now: Date = new Date(),
): Promise<StreakResult> {
  const events = await prisma.analyticsEvent.findMany({
    where: { userId },
    select: { createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  return calculateStreakFromDates(
    events.map((e) => e.createdAt),
    now,
  );
}

/**
 * Batch variant — fetch activity for many users in one query and return a
 * map of userId → StreakResult. Used by the arena leaderboard so we don't
 * fire off N queries.
 */
export async function calculateStreaksForUsers(
  userIds: ReadonlyArray<string>,
  now: Date = new Date(),
): Promise<Map<string, StreakResult>> {
  const result = new Map<string, StreakResult>();
  if (userIds.length === 0) return result;

  const events = await prisma.analyticsEvent.findMany({
    where: { userId: { in: [...userIds] } },
    select: { userId: true, createdAt: true },
  });

  const byUser = new Map<string, Date[]>();
  for (const id of userIds) {
    byUser.set(id, []);
  }
  for (const event of events) {
    const bucket = byUser.get(event.userId);
    if (bucket) bucket.push(event.createdAt);
  }

  for (const [userId, dates] of byUser.entries()) {
    result.set(userId, calculateStreakFromDates(dates, now));
  }

  return result;
}
