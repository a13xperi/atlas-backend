/**
 * Alert Delivery Dispatcher
 *
 * After an alert is created, this checks the user's subscriptions
 * for TELEGRAM delivery and sends via the Telegram bot.
 */

import { prisma } from "./prisma";
import { deliverAlertToUser } from "./telegram";

interface AlertPayload {
  id: string;
  title: string;
  type: string;
  context?: string | null;
  sourceUrl?: string | null;
  sentiment?: string | null;
  userId?: string | null;
}

/**
 * Dispatch an alert to all configured delivery channels.
 * Currently supports TELEGRAM; PORTAL delivery is implicit (alerts are always in the feed).
 */
export async function dispatchAlert(alert: AlertPayload): Promise<void> {
  if (!alert.userId) return;

  try {
    // Check if user has any subscription with TELEGRAM delivery
    const telegramSubs = await prisma.alertSubscription.findMany({
      where: {
        userId: alert.userId,
        isActive: true,
        delivery: { has: "TELEGRAM" },
      },
    });

    if (telegramSubs.length === 0) return;

    // Deliver via Telegram (non-blocking)
    deliverAlertToUser(alert, alert.userId).catch((err) =>
      console.error(`[alertDelivery] Telegram delivery failed for alert ${alert.id}:`, err)
    );
  } catch (err) {
    console.error(`[alertDelivery] Dispatch failed for alert ${alert.id}:`, err);
  }
}
