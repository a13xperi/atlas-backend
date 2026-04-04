import { logger } from "./logger";
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

    // Deliver via Telegram and stamp deliveredAt on success
    deliverAlertToUser(alert, alert.userId)
      .then((ok) => {
        if (ok) {
          prisma.alert.update({ where: { id: alert.id }, data: { deliveredAt: new Date() } }).catch(() => {});
        }
      })
      .catch((err) =>
        logger.error({ err }, `[alertDelivery] Telegram delivery failed for alert ${alert.id}`)
      );
  } catch (err) {
    logger.error({ err }, `[alertDelivery] Dispatch failed for alert ${alert.id}`);
  }
}
