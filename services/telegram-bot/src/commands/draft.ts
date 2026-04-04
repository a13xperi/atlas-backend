import { generateDraftFromSource } from "../../../api/src/lib/draft-generation";
import { logger } from "../../../api/src/lib/logger";
import {
  buildOracleReply,
  extractCommandArgument,
  formatDraftReply,
  getLinkedTelegramUser,
  isSlashCommand,
  type TelegramTextContext,
} from "./shared";

export async function handleDraftCommand(
  ctx: TelegramTextContext,
): Promise<unknown> {
  const content = extractCommandArgument(ctx.message.text);
  if (!content) {
    return ctx.reply("Usage: /draft <content>");
  }

  return replyWithGeneratedDraft(ctx, content);
}

export async function handlePlainTextDraft(
  ctx: TelegramTextContext,
): Promise<unknown> {
  const content = ctx.message.text.trim();
  if (!content || isSlashCommand(content)) {
    return undefined;
  }

  return replyWithGeneratedDraft(ctx, content);
}

async function replyWithGeneratedDraft(
  ctx: TelegramTextContext,
  sourceContent: string,
): Promise<unknown> {
  const chatId = ctx.chat.id.toString();

  try {
    const user = await getLinkedTelegramUser(chatId);
    if (!user) {
      return ctx.reply("Link your account first with /link <handle>");
    }

    const { draft, pipeline } = await generateDraftFromSource({
      userId: user.id,
      sourceContent,
      sourceType: "MANUAL",
      timeoutLabel: "telegram-draft",
    });

    const oracleReply = await buildOracleReply({
      mode: "draft",
      handle: user.handle,
      sourceContent,
      generatedTweet: draft.content,
      confidence: pipeline.ctx.confidence,
      dimensions: pipeline.ctx.voiceProfile,
    });

    return ctx.reply(
      formatDraftReply(oracleReply, draft.content, pipeline.ctx.confidence),
    );
  } catch (err) {
    logger.error({ err, chatId }, "[telegram] Draft generation error");

    if (err instanceof Error && err.message.includes("Voice profile not found")) {
      return ctx.reply(
        "I can't channel your voice yet. Finish onboarding in Atlas, then send that again.",
      );
    }

    return ctx.reply(
      "The signal got noisy on my end. Send it again and I'll take another pass.",
    );
  }
}
