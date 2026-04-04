import "dotenv/config";
import { Telegraf } from "telegraf";
import { registerLinkCommand } from "./commands/link";
import { registerStartCommand } from "./commands/start";

async function main(): Promise<void> {
  const token = process.env.BOT_TOKEN;

  if (!token) {
    throw new Error("BOT_TOKEN is required to start the Telegram bot");
  }

  const bot = new Telegraf(token);

  registerStartCommand(bot);
  registerLinkCommand(bot);

  bot.catch((err) => {
    console.error("[telegram-bot] Unhandled bot error", err);
  });

  await bot.launch();
  console.log("[telegram-bot] Bot started with long polling");

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

void main().catch((err) => {
  console.error("[telegram-bot] Failed to start", err);
  process.exit(1);
});
