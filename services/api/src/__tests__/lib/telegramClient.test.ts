describe("telegramClient", () => {
  const originalFetch = global.fetch;

  const loadTelegramClient = (token = "telegram-token") => {
    jest.resetModules();

    jest.doMock("../../lib/logger", () => ({
      logger: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
      },
    }));

    jest.doMock("../../lib/config", () => ({
      config: {
        TELEGRAM_BOT_TOKEN: token,
      },
    }));

    return require("../../lib/telegramClient") as typeof import("../../lib/telegramClient");
  };

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it("formats typed dispatch messages", () => {
    const { formatTelegramDispatchMessage } = loadTelegramClient();

    expect(formatTelegramDispatchMessage("alert", "BTC broke out")).toBe(
      "Atlas Alert\n\nBTC broke out",
    );
    expect(formatTelegramDispatchMessage("digest", "  Daily wrap  ")).toBe(
      "Atlas Digest\n\nDaily wrap",
    );
  });

  it("returns false without a Telegram bot token", async () => {
    const { sendTelegramMessage } = loadTelegramClient("");
    const { logger } = require("../../lib/logger");

    await expect(sendTelegramMessage("chat-1", "Hello")).resolves.toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    expect((logger.warn as jest.Mock)).toHaveBeenCalledWith(
      "[telegram] TELEGRAM_BOT_TOKEN not set — outbound Telegram delivery disabled",
    );
  });

  it("posts messages to the Telegram Bot API", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValueOnce({ ok: true, result: { message_id: 1 } }),
    });

    const { sendTelegramMessage } = loadTelegramClient();

    await expect(sendTelegramMessage("chat-123", "Atlas Alert\n\nReady")).resolves.toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bottelegram-token/sendMessage",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: "chat-123",
          text: "Atlas Alert\n\nReady",
          disable_web_page_preview: true,
        }),
      }),
    );
  });

  it("returns false when the Telegram API rejects the send", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: jest.fn().mockResolvedValueOnce({ ok: false, description: "Bad Request: chat not found" }),
    });

    const { sendTelegramMessage } = loadTelegramClient();
    const { logger } = require("../../lib/logger");

    await expect(sendTelegramMessage("chat-404", "Hello")).resolves.toBe(false);
    expect((logger.error as jest.Mock)).toHaveBeenCalledWith(
      {
        chatId: "chat-404",
        status: 400,
        description: "Bad Request: chat not found",
      },
      "[telegram] Telegram API sendMessage failed",
    );
  });

  it("returns false when the network request throws", async () => {
    const requestError = new Error("network down");
    (global.fetch as jest.Mock).mockRejectedValueOnce(requestError);

    const { sendTelegramMessage } = loadTelegramClient();
    const { logger } = require("../../lib/logger");

    await expect(sendTelegramMessage("chat-500", "Hello")).resolves.toBe(false);
    expect((logger.error as jest.Mock)).toHaveBeenCalledWith(
      { err: requestError, chatId: "chat-500" },
      "[telegram] Telegram API request failed",
    );
  });
});
