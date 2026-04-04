import { refineLatestDraftForUser } from "../../../api/src/lib/draft-generation";
import { logger } from "../../../api/src/lib/logger";
import {
  buildOracleReply,
  extractCommandArgument,
  formatDraftReply,
  getLinkedTelegramUser,
  type TelegramTextContext,
} from "./shared";

export async function handleRefineCommand(
  ctx: TelegramTextContext,
): Promise<unknown> {
  const instruction = extractCommandArgument(ctx.message.text);
  if (!instruction) {
    return ctx.reply("Usage: /refine <instruction>");
  }

  const chatId = ctx.chat.id.toString();

  try {
    const user = await getLinkedTelegramUser(chatId);
    if (!user) {
      return ctx.reply("Link your account first with /link <handle>");
    }

    const { draft, pipeline } = await refineLatestDraftForUser({
      userId: user.id,
      instruction,
      timeoutLabel: "telegram-refine",
    });

    const oracleReply = await buildOracleReply({
      mode: "refine",
      handle: user.handle,
      instruction,
      sourceContent: draft.sourceContent ?? draft.content,
      generatedTweet: draft.content,
      confidence: pipeline.ctx.confidence,
      dimensions: pipeline.ctx.voiceProfile,
    });

    return ctx.reply(
      formatDraftReply(oracleReply, draft.content, pipeline.ctx.confidence),
    );
  } catch (err) {
    logger.error({ err, chatId }, "[telegram] Draft refinement error");

    if (err instanceof Error && err.message === "Draft not found") {
      return ctx.reply(
        "There's nothing for me to refine yet. Send plain text or use /draft first.",
      );
    }

    if (err instanceof Error && err.message.includes("Voice profile not found")) {
      return ctx.reply(
        "I need your Atlas voice profile before I can refine anything. Finish onboarding, then come back.",
      );
    }

    return ctx.reply(
      "The thread slipped out of my hands for a moment. Try the refinement again.",
    );
  }
}
