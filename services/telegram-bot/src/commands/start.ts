import type { Context, Telegraf } from "telegraf";

function buildWelcomeMessage(): string {
  return `Hey — I'm the same brain from Atlas.\n\nDrop me a report, tweet link, or voice note anytime and I'll queue it straight to your Crafting Station.\n\nWhat's your Atlas handle? Reply with /link <your_handle> to connect your account.`;
}

export function registerStartCommand(bot: Telegraf<Context>): void {
  bot.start(async (ctx) => {
    await ctx.reply(buildWelcomeMessage());
  });
}
