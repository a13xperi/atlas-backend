/**
 * Intelligent Scheduling — Generate and apply posting schedules for queued drafts.
 *
 * generateSchedule: Builds a recommended posting schedule using optimal time windows.
 * applySchedule: Persists the schedule by setting scheduledAt on each draft.
 */

import { prisma } from "./prisma";
import { logger } from "./logger";

export interface ScheduleSlot {
  draftId: string;
  recommendedTime: string;
  content: string;
  sortOrder: number;
}

export interface Schedule {
  slots: ScheduleSlot[];
  generatedAt: string;
  timezone: string;
}

// Optimal posting hours (in local timezone) — crypto twitter peak engagement
const OPTIMAL_HOURS = [9, 10, 13, 14, 17, 19, 20];
const MIN_GAP_HOURS = 2;

/**
 * Generate a recommended posting schedule for a user's queued drafts.
 * Spaces drafts across optimal posting windows in the user's timezone.
 */
export async function generateSchedule(
  userId: string,
  campaignId: string | undefined,
  timezone: string,
): Promise<Schedule> {
  const where: Record<string, unknown> = {
    userId,
    status: { in: ["DRAFT", "APPROVED"] },
  };
  if (campaignId) {
    where.campaignId = campaignId;
  }

  const drafts = await prisma.tweetDraft.findMany({
    where,
    orderBy: [
      { sortOrder: "asc" },
      { createdAt: "asc" },
    ],
    select: {
      id: true,
      content: true,
      sortOrder: true,
    },
  });

  if (drafts.length === 0) {
    return { slots: [], generatedAt: new Date().toISOString(), timezone };
  }

  // Build time slots starting from the next available optimal hour
  const now = new Date();
  const slots: ScheduleSlot[] = [];
  let slotDate = new Date(now);
  let hourIndex = 0;
  let dayOffset = 0;

  for (let i = 0; i < drafts.length; i++) {
    // Find the next optimal hour that's in the future
    let found = false;
    while (!found) {
      const hour = OPTIMAL_HOURS[hourIndex % OPTIMAL_HOURS.length];
      if (hourIndex > 0 && hourIndex % OPTIMAL_HOURS.length === 0) {
        dayOffset++;
      }

      const candidate = new Date(now);
      candidate.setDate(candidate.getDate() + dayOffset);
      candidate.setHours(hour, 0, 0, 0);

      // Ensure the slot is at least MIN_GAP_HOURS from now and from previous slot
      if (candidate.getTime() > now.getTime()) {
        const prevSlotTime = slots.length > 0
          ? new Date(slots[slots.length - 1].recommendedTime).getTime()
          : 0;
        if (candidate.getTime() - prevSlotTime >= MIN_GAP_HOURS * 60 * 60 * 1000 || slots.length === 0) {
          slotDate = candidate;
          found = true;
        }
      }

      hourIndex++;

      // Safety: don't loop forever
      if (hourIndex > OPTIMAL_HOURS.length * 30) {
        dayOffset++;
        hourIndex = 0;
      }
    }

    const draft = drafts[i];
    slots.push({
      draftId: draft.id,
      recommendedTime: slotDate.toISOString(),
      content: draft.content.slice(0, 100),
      sortOrder: i + 1,
    });
  }

  logger.info(
    { userId, count: slots.length, campaignId },
    "Schedule generated",
  );

  return {
    slots,
    generatedAt: new Date().toISOString(),
    timezone,
  };
}

/**
 * Apply a schedule by updating scheduledAt on each draft.
 * Uses a transaction for atomicity. Skips drafts not owned by the user.
 */
export async function applySchedule(
  userId: string,
  slots: Array<{ draftId: string; recommendedTime: string }>,
): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;

  await prisma.$transaction(async (tx) => {
    for (const slot of slots) {
      const draft = await tx.tweetDraft.findFirst({
        where: { id: slot.draftId, userId },
        select: { id: true },
      });

      if (!draft) {
        skipped++;
        continue;
      }

      await tx.tweetDraft.update({
        where: { id: draft.id },
        data: {
          scheduledAt: new Date(slot.recommendedTime),
          status: "SCHEDULED",
        },
      });

      applied++;
    }
  });

  logger.info(
    { userId, applied, skipped },
    "Schedule applied to drafts",
  );

  return { applied, skipped };
}
