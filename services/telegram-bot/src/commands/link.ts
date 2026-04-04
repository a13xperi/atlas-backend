import type { Context, Telegraf } from "telegraf";
import { prisma } from "../../../api/src/lib/prisma";

function extractHandle(text: string): string {
  const rawHandle = text.split(/\s+/).slice(1).join(" ").trim();
  return rawHandle.replace(/^@/, "");
}

export function registerLinkCommand(bot: Telegraf<Context>): void {
  bot.command("link", async (ctx) => {
    const handle = extractHandle(ctx.message.text);

    if (!handle) {
      await ctx.reply("Name the handle you want me to bind. Use /link <handle>.");
      return;
    }

    try {
      const user = await prisma.user.findUnique({
        where: { handle },
        select: { id: true, handle: true, telegramChatId: true },
      });

      if (!user) {
        await ctx.reply(`No Atlas account answers to @${handle} yet. Use the exact Atlas handle and try again.`);
        return;
      }

      const chatId = ctx.chat.id.toString();

      const existingLink = await prisma.user.findFirst({
        where: {
          telegramChatId: chatId,
          id: { not: user.id },
        },
        select: { handle: true },
      });

      if (existingLink) {
        await ctx.reply(`This chat is already bound to @${existingLink.handle}. Break that link first, then try again.`);
        return;
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { telegramChatId: chatId },
      });

      await ctx.reply(`The bond is made, @${user.handle}. This chat now speaks for your Atlas account.`);
    } catch (error) {
      console.error("[telegram-bot] Failed to link handle", error);
      await ctx.reply("The signal broke before the link held. Try again in a moment.");
    }
  });
}
