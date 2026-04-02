type PrismaMock = {
  user: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
  };
  alert: {
    findMany: jest.Mock;
  };
  alertSubscription: {
    findMany: jest.Mock;
  };
};

type TelegramContext = {
  message: { text: string };
  chat: { id: number };
  reply: jest.Mock;
};

type BotHandler = (ctx: TelegramContext) => unknown | Promise<unknown>;

type MockTelegrafInstance = {
  token: string;
  start: jest.Mock;
  help: jest.Mock;
  command: jest.Mock;
  launch: jest.Mock;
  stop: jest.Mock;
  telegram: {
    sendMessage: jest.Mock;
  };
  startHandler?: BotHandler;
  helpHandler?: BotHandler;
  commandHandlers: Record<string, BotHandler>;
};

const flushPromises = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const createPrismaMock = (): PrismaMock => ({
  user: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  alert: {
    findMany: jest.fn(),
  },
  alertSubscription: {
    findMany: jest.fn(),
  },
});

const createContext = (text: string, chatId = 123): TelegramContext => ({
  message: { text },
  chat: { id: chatId },
  reply: jest.fn(),
});

describe("telegram", () => {
  let prismaMock: PrismaMock;
  let telegrafInstances: MockTelegrafInstance[];
  let launchImplementation: jest.Mock;

  const loadTelegramModule = (token = "telegram-token") => {
    jest.resetModules();
    prismaMock = createPrismaMock();
    telegrafInstances = [];
    launchImplementation = jest.fn().mockResolvedValue(undefined);

    jest.doMock("../../lib/config", () => ({
      config: {
        TELEGRAM_BOT_TOKEN: token,
      },
    }));

    jest.doMock("../../lib/prisma", () => ({
      prisma: prismaMock,
    }));

    jest.doMock("telegraf", () => ({
      Telegraf: class MockTelegraf {
        token: string;
        start: jest.Mock;
        help: jest.Mock;
        command: jest.Mock;
        launch: jest.Mock;
        stop: jest.Mock;
        telegram: { sendMessage: jest.Mock };
        startHandler?: BotHandler;
        helpHandler?: BotHandler;
        commandHandlers: Record<string, BotHandler>;

        constructor(botToken: string) {
          this.token = botToken;
          this.commandHandlers = {};
          this.telegram = {
            sendMessage: jest.fn(),
          };
          this.start = jest.fn((handler: BotHandler) => {
            this.startHandler = handler;
            return this;
          });
          this.help = jest.fn((handler: BotHandler) => {
            this.helpHandler = handler;
            return this;
          });
          this.command = jest.fn((name: string, handler: BotHandler) => {
            this.commandHandlers[name] = handler;
            return this;
          });
          this.launch = jest.fn(() => launchImplementation());
          this.stop = jest.fn();
          telegrafInstances.push(this as unknown as MockTelegrafInstance);
        }
      },
    }));

    return require("../../lib/telegram") as typeof import("../../lib/telegram");
  };

  const getBotInstance = () => telegrafInstances[0];

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(process, "once").mockImplementation(((..._args: unknown[]) => process) as typeof process.once);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("returns null and warns when TELEGRAM_BOT_TOKEN is not set", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { initBot, getBot } = loadTelegramModule("");

    expect(initBot()).toBeNull();
    expect(getBot()).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      "[telegram] TELEGRAM_BOT_TOKEN not set — Telegram bot disabled"
    );
    expect(telegrafInstances).toHaveLength(0);
  });

  it("initializes the bot, registers handlers, and starts polling", async () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const onceSpy = jest.spyOn(process, "once");
    const { initBot, getBot } = loadTelegramModule();

    const bot = initBot();
    await flushPromises();

    expect(bot).toBe(getBot());
    expect(bot).toBeTruthy();
    expect(getBotInstance().token).toBe("telegram-token");
    expect(getBotInstance().start).toHaveBeenCalledTimes(1);
    expect(getBotInstance().help).toHaveBeenCalledTimes(1);
    expect(getBotInstance().command).toHaveBeenCalledTimes(4);
    expect(Object.keys(getBotInstance().commandHandlers)).toEqual([
      "link",
      "unlink",
      "alerts",
      "subscriptions",
    ]);
    expect(getBotInstance().launch).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("[telegram] Bot started (long polling)");
    expect(onceSpy).toHaveBeenNthCalledWith(1, "SIGINT", expect.any(Function));
    expect(onceSpy).toHaveBeenNthCalledWith(2, "SIGTERM", expect.any(Function));
  });

  it("stops the bot on shutdown signals", async () => {
    const signalHandlers: Record<string, () => void> = {};
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(process, "once").mockImplementation(((signal: string, handler: () => void) => {
      signalHandlers[signal] = handler;
      return process;
    }) as typeof process.once);

    const { initBot } = loadTelegramModule();
    initBot();
    await flushPromises();

    signalHandlers.SIGINT();
    signalHandlers.SIGTERM();

    expect(getBotInstance().stop).toHaveBeenCalledWith("SIGINT");
    expect(getBotInstance().stop).toHaveBeenCalledWith("SIGTERM");
  });

  it("logs bot launch failures", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { initBot } = loadTelegramModule();
    launchImplementation.mockRejectedValueOnce(new Error("launch failed"));

    initBot();
    await flushPromises();

    expect(errorSpy).toHaveBeenCalledWith("[telegram] Bot launch failed:", "launch failed");
  });

  it("replies to /start and /help commands", async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    const { initBot } = loadTelegramModule();
    initBot();
    await flushPromises();

    const startCtx = createContext("/start");
    const helpCtx = createContext("/help");

    await getBotInstance().startHandler?.(startCtx);
    await getBotInstance().helpHandler?.(helpCtx);

    expect(startCtx.reply).toHaveBeenCalledWith(
      "Welcome to Atlas by Delphi Digital.\n\n" +
        "Link your Atlas account to receive alerts here.\n\n" +
        "Use /link <your-handle> to connect.\n" +
        "Use /help to see all commands."
    );
    expect(helpCtx.reply).toHaveBeenCalledWith(
      "Atlas Bot Commands:\n\n" +
        "/link <handle> — Link your Atlas account\n" +
        "/unlink — Disconnect your account\n" +
        "/alerts — Show recent alerts\n" +
        "/subscriptions — List active subscriptions\n" +
        "/help — Show this message"
    );
  });

  it("handles /link usage errors, missing users, conflicts, success, and recovery", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
    const { initBot } = loadTelegramModule();
    initBot();
    await flushPromises();

    const usageCtx = createContext("/link");
    await getBotInstance().commandHandlers.link(usageCtx);
    expect(usageCtx.reply).toHaveBeenCalledWith("Usage: /link <your-atlas-handle>");

    prismaMock.user.findUnique.mockResolvedValueOnce(null);
    const missingCtx = createContext("/link missing-user");
    await getBotInstance().commandHandlers.link(missingCtx);
    expect(missingCtx.reply).toHaveBeenCalledWith(
      'No Atlas account found with handle "missing-user".'
    );

    prismaMock.user.findUnique.mockResolvedValueOnce({ id: "user-1", handle: "atlas" });
    prismaMock.user.findFirst.mockResolvedValueOnce({ id: "user-2", telegramChatId: "321" });
    const conflictCtx = createContext("/link atlas", 321);
    await getBotInstance().commandHandlers.link(conflictCtx);
    expect(conflictCtx.reply).toHaveBeenCalledWith(
      "This Telegram account is already linked to a different Atlas user. Use /unlink first on the other account."
    );

    prismaMock.user.findUnique.mockResolvedValueOnce({ id: "user-1", handle: "atlas" });
    prismaMock.user.findFirst.mockResolvedValueOnce(null);
    prismaMock.user.update.mockResolvedValueOnce({
      id: "user-1",
      handle: "atlas",
      telegramChatId: "654",
    });
    const successCtx = createContext("/link atlas", 654);
    await getBotInstance().commandHandlers.link(successCtx);
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { telegramChatId: "654" },
    });
    expect(successCtx.reply).toHaveBeenCalledWith(
      "Linked to Atlas account @atlas. You'll now receive alerts here."
    );

    prismaMock.user.findUnique.mockRejectedValueOnce(new Error("db down"));
    const failureCtx = createContext("/link atlas");
    await getBotInstance().commandHandlers.link(failureCtx);
    expect(errorSpy).toHaveBeenCalledWith("[telegram] Link error:", expect.any(Error));
    expect(failureCtx.reply).toHaveBeenCalledWith("Something went wrong. Please try again.");
  });

  it("handles /unlink cases", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
    const { initBot } = loadTelegramModule();
    initBot();
    await flushPromises();

    prismaMock.user.findFirst.mockResolvedValueOnce(null);
    const missingCtx = createContext("/unlink", 555);
    await getBotInstance().commandHandlers.unlink(missingCtx);
    expect(missingCtx.reply).toHaveBeenCalledWith(
      "No Atlas account is linked to this Telegram chat."
    );

    prismaMock.user.findFirst.mockResolvedValueOnce({ id: "user-1", telegramChatId: "555" });
    prismaMock.user.update.mockResolvedValueOnce({ id: "user-1", telegramChatId: null });
    const successCtx = createContext("/unlink", 555);
    await getBotInstance().commandHandlers.unlink(successCtx);
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { telegramChatId: null },
    });
    expect(successCtx.reply).toHaveBeenCalledWith(
      "Unlinked. You will no longer receive alerts here."
    );

    prismaMock.user.findFirst.mockRejectedValueOnce(new Error("db down"));
    const failureCtx = createContext("/unlink", 555);
    await getBotInstance().commandHandlers.unlink(failureCtx);
    expect(errorSpy).toHaveBeenCalledWith("[telegram] Unlink error:", expect.any(Error));
    expect(failureCtx.reply).toHaveBeenCalledWith("Something went wrong. Please try again.");
  });

  it("handles /alerts cases and formats recent alerts", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
    const { initBot } = loadTelegramModule();
    initBot();
    await flushPromises();

    prismaMock.user.findFirst.mockResolvedValueOnce(null);
    const unlinkedCtx = createContext("/alerts", 999);
    await getBotInstance().commandHandlers.alerts(unlinkedCtx);
    expect(unlinkedCtx.reply).toHaveBeenCalledWith("Link your account first with /link <handle>");

    prismaMock.user.findFirst.mockResolvedValueOnce({ id: "user-1", telegramChatId: "999" });
    prismaMock.alert.findMany.mockResolvedValueOnce([]);
    const emptyCtx = createContext("/alerts", 999);
    await getBotInstance().commandHandlers.alerts(emptyCtx);
    expect(emptyCtx.reply).toHaveBeenCalledWith("No active alerts.");
    expect(prismaMock.alert.findMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    });

    prismaMock.user.findFirst.mockResolvedValueOnce({ id: "user-1", telegramChatId: "999" });
    prismaMock.alert.findMany.mockResolvedValueOnce([
      {
        title: "BTC breakout",
        sentiment: "bullish",
        context: "A".repeat(120),
        sourceUrl: "https://example.com/btc",
      },
      {
        title: "ETH funding reset",
        sentiment: null,
        context: null,
        sourceUrl: null,
      },
    ]);
    const successCtx = createContext("/alerts", 999);
    await getBotInstance().commandHandlers.alerts(successCtx);
    expect(successCtx.reply).toHaveBeenCalledWith(
      "Recent alerts:\n\n" +
        "1. BTC breakout [bullish]\n" +
        `   ${"A".repeat(100)}\n` +
        "   https://example.com/btc\n\n" +
        "2. ETH funding reset"
    );

    prismaMock.user.findFirst.mockRejectedValueOnce(new Error("db down"));
    const failureCtx = createContext("/alerts", 999);
    await getBotInstance().commandHandlers.alerts(failureCtx);
    expect(errorSpy).toHaveBeenCalledWith("[telegram] Alerts error:", expect.any(Error));
    expect(failureCtx.reply).toHaveBeenCalledWith("Failed to fetch alerts.");
  });

  it("handles /subscriptions cases and formats active subscriptions", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
    const { initBot } = loadTelegramModule();
    initBot();
    await flushPromises();

    prismaMock.user.findFirst.mockResolvedValueOnce(null);
    const unlinkedCtx = createContext("/subscriptions", 222);
    await getBotInstance().commandHandlers.subscriptions(unlinkedCtx);
    expect(unlinkedCtx.reply).toHaveBeenCalledWith("Link your account first with /link <handle>");

    prismaMock.user.findFirst.mockResolvedValueOnce({ id: "user-1", telegramChatId: "222" });
    prismaMock.alertSubscription.findMany.mockResolvedValueOnce([]);
    const emptyCtx = createContext("/subscriptions", 222);
    await getBotInstance().commandHandlers.subscriptions(emptyCtx);
    expect(emptyCtx.reply).toHaveBeenCalledWith(
      "No active subscriptions. Set them up in Atlas at /alerts."
    );

    prismaMock.user.findFirst.mockResolvedValueOnce({ id: "user-1", telegramChatId: "222" });
    prismaMock.alertSubscription.findMany.mockResolvedValueOnce([
      { type: "CATEGORY", value: "DeFi", delivery: ["PORTAL", "TELEGRAM"] },
      { type: "ACCOUNT", value: "@delphi", delivery: ["TELEGRAM"] },
    ]);
    const successCtx = createContext("/subscriptions", 222);
    await getBotInstance().commandHandlers.subscriptions(successCtx);
    expect(successCtx.reply).toHaveBeenCalledWith(
      "Active subscriptions:\n\n" +
        "1. CATEGORY: DeFi → PORTAL, TELEGRAM\n" +
        "2. ACCOUNT: @delphi → TELEGRAM"
    );

    prismaMock.user.findFirst.mockRejectedValueOnce(new Error("db down"));
    const failureCtx = createContext("/subscriptions", 222);
    await getBotInstance().commandHandlers.subscriptions(failureCtx);
    expect(errorSpy).toHaveBeenCalledWith("[telegram] Subscriptions error:", expect.any(Error));
    expect(failureCtx.reply).toHaveBeenCalledWith("Failed to fetch subscriptions.");
  });

  it("sends alert messages with formatting and truncation", async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    const { initBot, deliverAlert } = loadTelegramModule();
    initBot();
    await flushPromises();
    getBotInstance().telegram.sendMessage.mockResolvedValueOnce(undefined);

    const delivered = await deliverAlert(
      {
        title: "Macro update",
        sentiment: "bullish",
        context: "B".repeat(350),
        sourceUrl: "https://example.com/macro",
      },
      "chat-123"
    );

    expect(delivered).toBe(true);
    expect(getBotInstance().telegram.sendMessage).toHaveBeenCalledWith(
      "chat-123",
      "Atlas Alert [BULLISH]\n\nMacro update\n\n" +
        `${"B".repeat(300)}\n\n` +
        "Source: https://example.com/macro"
    );
  });

  it("returns false when delivery cannot be sent", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
    const { deliverAlert, initBot } = loadTelegramModule();

    expect(
      await deliverAlert(
        {
          title: "No bot",
        },
        "chat-123"
      )
    ).toBe(false);

    initBot();
    await flushPromises();
    getBotInstance().telegram.sendMessage.mockRejectedValueOnce(new Error("send failed"));

    await expect(
      deliverAlert(
        {
          title: "Delivery failed",
          context: "Details",
        },
        "chat-123"
      )
    ).resolves.toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      "[telegram] Failed to deliver alert to chat chat-123:",
      expect.any(Error)
    );
  });

  it("looks up linked users before delivering alerts", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
    const { initBot, deliverAlertToUser } = loadTelegramModule();
    initBot();
    await flushPromises();

    prismaMock.user.findUnique.mockResolvedValueOnce({ telegramChatId: null });
    await expect(
      deliverAlertToUser(
        {
          title: "Missing chat",
        },
        "user-1"
      )
    ).resolves.toBe(false);
    expect(getBotInstance().telegram.sendMessage).not.toHaveBeenCalled();

    prismaMock.user.findUnique.mockResolvedValueOnce({ telegramChatId: "chat-999" });
    getBotInstance().telegram.sendMessage.mockResolvedValueOnce(undefined);
    await expect(
      deliverAlertToUser(
        {
          title: "Delivered",
          sourceUrl: "https://example.com",
        },
        "user-2"
      )
    ).resolves.toBe(true);
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
      where: { id: "user-2" },
      select: { telegramChatId: true },
    });
    expect(getBotInstance().telegram.sendMessage).toHaveBeenCalledWith(
      "chat-999",
      "Atlas Alert\n\nDelivered\n\nSource: https://example.com"
    );

    prismaMock.user.findUnique.mockRejectedValueOnce(new Error("lookup failed"));
    await expect(
      deliverAlertToUser(
        {
          title: "Lookup failed",
        },
        "user-3"
      )
    ).resolves.toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      "[telegram] Failed to look up user user-3:",
      expect.any(Error)
    );
  });
});
