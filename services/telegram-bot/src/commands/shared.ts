import { logger } from "../../../api/src/lib/logger";
import {
  buildDraftDeliveryResponse,
  type VoiceDimensions,
} from "../../../api/src/lib/oracle-prompt";
import { prisma } from "../../../api/src/lib/prisma";
import { complete } from "../../../api/src/lib/providers";

export interface TelegramTextContext {
  message: { text: string };
  chat: { id: number | string };
  reply: (message: string) => unknown | Promise<unknown>;
}

interface LinkedTelegramUser {
  id: string;
  handle: string;
}

interface BuildOracleReplyInput {
  mode: "draft" | "refine";
  generatedTweet: string;
  sourceContent: string;
  confidence?: number;
  dimensions?: VoiceDimensions;
  instruction?: string;
  handle?: string;
}

export async function getLinkedTelegramUser(
  chatId: string,
): Promise<LinkedTelegramUser | null> {
  return prisma.user.findFirst({
    where: { telegramChatId: chatId },
    select: { id: true, handle: true },
  });
}

export function extractCommandArgument(text: string): string {
  return text.trim().split(/\s+/).slice(1).join(" ").trim();
}

export function isSlashCommand(text: string): boolean {
  return text.trim().startsWith("/");
}

export function formatDraftReply(
  oracleReply: string,
  tweet: string,
  confidence?: number,
): string {
  const parts = [oracleReply.trim(), tweet.trim()];

  if (confidence !== undefined) {
    parts.push(`Confidence: ${Math.round(confidence * 100)}%`);
  }

  return parts.filter(Boolean).join("\n\n");
}

export async function buildOracleReply(
  input: BuildOracleReplyInput,
): Promise<string> {
  try {
    const prompt = buildDraftDeliveryResponse(input);
    const response = await complete({
      taskType: input.mode === "refine" ? "oracle_smart" : "oracle_fast",
      maxTokens: 120,
      temperature: 0.7,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.userMessage },
      ],
    });

    return response.content.trim() || fallbackOracleReply(input.mode);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), mode: input.mode },
      "[telegram] Oracle reply generation failed",
    );
    return fallbackOracleReply(input.mode);
  }
}

function fallbackOracleReply(mode: "draft" | "refine"): string {
  if (mode === "refine") {
    return "I tightened the edges without flattening your voice. This version should land cleaner.";
  }

  return "I pulled the signal into your voice and kept the point sharp. This one feels ready to test.";
}
