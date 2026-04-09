import { config } from "./config";
import { logger } from "./logger";

const TELEGRAM_API_BASE = "https://api.telegram.org";

type TelegramApiResponse = {
  ok: boolean;
  description?: string;
};

export type TelegramDispatchType = "alert" | "report" | "digest";

export function formatTelegramDispatchMessage(
  type: TelegramDispatchType,
  message: string,
): string {
  const title =
    type === "alert" ? "Atlas Alert" : type === "report" ? "Atlas Report" : "Atlas Digest";

  return `${title}\n\n${message.trim()}`;
}

export async function sendTelegramMessage(chatId: string, text: string): Promise<boolean> {
  const token = config.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.warn("[telegram] TELEGRAM_BOT_TOKEN not set — outbound Telegram delivery disabled");
    return false;
  }

  try {
    const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });

    const payload = (await response.json().catch(() => null)) as TelegramApiResponse | null;
    if (!response.ok || !payload?.ok) {
      logger.error(
        {
          chatId,
          status: response.status,
          description: payload?.description ?? "Unknown Telegram API error",
        },
        "[telegram] Telegram API sendMessage failed",
      );
      return false;
    }

    return true;
  } catch (err) {
    logger.error({ err, chatId }, "[telegram] Telegram API request failed");
    return false;
  }
}
