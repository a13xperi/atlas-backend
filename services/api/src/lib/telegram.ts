import { logger } from "./logger";
/**
 * Telegram Bot — Atlas alert delivery channel.
 *
 * Provides:
 * - initBot(): starts Telegraf long-polling (no-ops when TELEGRAM_BOT_TOKEN is unset)
 * - deliverAlert(): sends a formatted alert to a Telegram chat
 * - deliverAlertToUser(): looks up user's chatId and delivers
 */

import { config } from "./config";
import { Telegraf } from "telegraf";
import { prisma } from "./prisma";

let bot: Telegraf | null = null;

/**
 * Initialize the Telegram bot with command handlers.
 * Gracefully no-ops when TELEGRAM_BOT_TOKEN is not set.
 */
export function initBot(): Telegraf | null {
  const token = config.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.warn("[telegram] TELEGRAM_BOT_TOKEN not set — Telegram bot disabled");
    return null;
  }

  bot = new Telegraf(token);

  // /start — welcome message
  bot.start((ctx) => {
    ctx.reply(
      "Welcome to Atlas by Delphi Digital.\n\n" +
        "Link your Atlas account to receive alerts here.\n\n" +
        "Use /link <your-handle> to connect.\n" +
        "Use /help to see all commands."
    );
  });

  // /help — command reference
  bot.help((ctx) => {
    ctx.reply(
      "Atlas Bot Commands:\n\n" +
        "/link <handle> — Link your Atlas account\n" +
        "/unlink — Disconnect your account\n" +
        "/alerts — Show recent alerts\n" +
        "/subscriptions — List active subscriptions\n" +
        "/help — Show this message"
    );
  });

  // /link <handle> — associate Telegram chat with Atlas user
  bot.command("link", async (ctx) => {
    const handle = ctx.message.text.split(" ").slice(1).join(" ").trim();
    if (!handle) {
      return ctx.reply("Usage: /link <your-atlas-handle>");
    }

    try {
      const user = await prisma.user.findUnique({ where: { handle } });
      if (!user) {
        return ctx.reply(`No Atlas account found with handle "${handle}".`);
      }

      const chatId = ctx.chat.id.toString();

      // Check if another user already has this chatId
      const existing = await prisma.user.findFirst({ where: { telegramChatId: chatId } });
      if (existing && existing.id !== user.id) {
        return ctx.reply(
          "This Telegram account is already linked to a different Atlas user. Use /unlink first on the other account."
        );
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { telegramChatId: chatId },
      });

      ctx.reply(`Linked to Atlas account @${handle}. You'll now receive alerts here.`);
    } catch (err) {
      logger.error({ err }, "[telegram] Link error");
      ctx.reply("Something went wrong. Please try again.");
    }
  });

  // /unlink — remove Telegram association
  bot.command("unlink", async (ctx) => {
    const chatId = ctx.chat.id.toString();

    try {
      const user = await prisma.user.findFirst({ where: { telegramChatId: chatId } });
      if (!user) {
        return ctx.reply("No Atlas account is linked to this Telegram chat.");
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { telegramChatId: null },
      });

      ctx.reply("Unlinked. You will no longer receive alerts here.");
    } catch (err) {
      logger.error({ err }, "[telegram] Unlink error");
      ctx.reply("Something went wrong. Please try again.");
    }
  });

  // /alerts — show recent alerts
  bot.command("alerts", async (ctx) => {
    const chatId = ctx.chat.id.toString();

    try {
      const user = await prisma.user.findFirst({ where: { telegramChatId: chatId } });
      if (!user) {
        return ctx.reply("Link your account first with /link <handle>");
      }

      const alerts = await prisma.alert.findMany({
        where: {
          userId: user.id,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        orderBy: { createdAt: "desc" },
        take: 5,
      });

      if (alerts.length === 0) {
        return ctx.reply("No active alerts.");
      }

      const formatted = alerts
        .map(
          (a, i) =>
            `${i + 1}. ${a.title}${a.sentiment ? ` [${a.sentiment}]` : ""}` +
            `${a.context ? `\n   ${a.context.slice(0, 100)}` : ""}` +
            `${a.sourceUrl ? `\n   ${a.sourceUrl}` : ""}`
        )
        .join("\n\n");

      ctx.reply(`Recent alerts:\n\n${formatted}`);
    } catch (err) {
      logger.error({ err }, "[telegram] Alerts error");
      ctx.reply("Failed to fetch alerts.");
    }
  });

  // /subscriptions — list active subscriptions
  bot.command("subscriptions", async (ctx) => {
    const chatId = ctx.chat.id.toString();

    try {
      const user = await prisma.user.findFirst({ where: { telegramChatId: chatId } });
      if (!user) {
        return ctx.reply("Link your account first with /link <handle>");
      }

      const subs = await prisma.alertSubscription.findMany({
        where: { userId: user.id, isActive: true },
      });

      if (subs.length === 0) {
        return ctx.reply("No active subscriptions. Set them up in Atlas at /alerts.");
      }

      const formatted = subs
        .map(
          (s, i) =>
            `${i + 1}. ${s.type}: ${s.value} → ${s.delivery.join(", ")}`
        )
        .join("\n");

      ctx.reply(`Active subscriptions:\n\n${formatted}`);
    } catch (err) {
      logger.error({ err }, "[telegram] Subscriptions error");
      ctx.reply("Failed to fetch subscriptions.");
    }
  });

  // Start polling (non-blocking)
  bot
    .launch()
    .then(() => logger.info("[telegram] Bot started (long polling)"))
    .catch((err) => logger.error({ err: err.message }, "[telegram] Bot launch failed"));

  // Graceful shutdown
  process.once("SIGINT", () => bot?.stop("SIGINT"));
  process.once("SIGTERM", () => bot?.stop("SIGTERM"));

  return bot;
}

/**
 * Format and send an alert to a specific Telegram chat.
 */
export async function deliverAlert(
  alert: { title: string; context?: string | null; sourceUrl?: string | null; sentiment?: string | null },
  chatId: string
): Promise<boolean> {
  if (!bot) return false;

  const sentiment = alert.sentiment ? ` [${alert.sentiment.toUpperCase()}]` : "";
  let message = `Atlas Alert${sentiment}\n\n${alert.title}`;

  if (alert.context) {
    message += `\n\n${alert.context.slice(0, 300)}`;
  }
  if (alert.sourceUrl) {
    message += `\n\nSource: ${alert.sourceUrl}`;
  }

  try {
    await bot.telegram.sendMessage(chatId, message);
    return true;
  } catch (err) {
    logger.error({ err, chatId }, "[telegram] Failed to deliver alert");
    return false;
  }
}

/**
 * Look up a user's Telegram chatId and deliver an alert.
 * Returns false if user has no linked chat or delivery fails.
 */
export async function deliverAlertToUser(
  alert: { title: string; context?: string | null; sourceUrl?: string | null; sentiment?: string | null },
  userId: string
): Promise<boolean> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { telegramChatId: true },
    });

    if (!user?.telegramChatId) return false;
    return deliverAlert(alert, user.telegramChatId);
  } catch (err) {
    logger.error({ err, userId }, "[telegram] Failed to look up user");
    return false;
  }
}

export function getBot(): Telegraf | null {
  return bot;
}
