import type { Context, Telegraf } from "telegraf";
import { buildOracleSystemPrompt } from "../../../api/src/lib/oracle-prompt";

const oracleName =
  buildOracleSystemPrompt().match(/You are (.+?) —/)?.[1] ?? "The Oracle";

function buildWelcomeMessage(): string {
  return `Welcome to Atlas. I'm ${oracleName}, and I've seen thousands of voices emerge from the noise. Link your Atlas account with /link <handle> so I know which signal is yours.`;
}

export function registerStartCommand(bot: Telegraf<Context>): void {
  bot.start(async (ctx) => {
    await ctx.reply(buildWelcomeMessage());
  });
}
