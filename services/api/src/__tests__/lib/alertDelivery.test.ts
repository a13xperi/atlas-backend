/**
 * Alert delivery test suite
 * Tests: channel routing, Telegram dispatch, error handling
 * Mocks: Prisma, Telegram delivery
 */

jest.mock("../../lib/prisma", () => ({
  prisma: {
    alertSubscription: {
      findMany: jest.fn(),
    },
    alert: {
      // Stamping path: dispatchAlert calls prisma.alert.update with
      // { deliveredAt } when deliverAlertToUser resolves to true. The
      // mock has to exist on the module-level prisma reference so the
      // .then() callback in alertDelivery.ts can call .catch() on the
      // returned chain without throwing.
      update: jest.fn().mockReturnValue({ catch: jest.fn() }),
    },
  },
}));

jest.mock("../../lib/telegram", () => ({
  deliverAlertToUser: jest.fn(),
}));

import { logger } from "../../lib/logger";

jest.mock("../../lib/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));



import { prisma } from "../../lib/prisma";
import { deliverAlertToUser } from "../../lib/telegram";
import { dispatchAlert } from "../../lib/alertDelivery";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockDeliverAlertToUser = deliverAlertToUser as jest.Mock;

const flushPromises = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const baseAlert = {
  id: "alert-1",
  title: "BTC Alert",
  type: "CATEGORY",
  context: "Bitcoin broke resistance",
  sourceUrl: "https://example.com/report",
  sentiment: "bullish",
  userId: "user-123",
};

describe("dispatchAlert", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns early when alert has no userId", async () => {
    await dispatchAlert({ ...baseAlert, userId: null });

    expect(mockPrisma.alertSubscription.findMany).not.toHaveBeenCalled();
    expect(mockDeliverAlertToUser).not.toHaveBeenCalled();
  });

  it("checks TELEGRAM subscriptions before dispatching", async () => {
    (mockPrisma.alertSubscription.findMany as jest.Mock).mockResolvedValueOnce([]);

    await dispatchAlert(baseAlert);

    expect(mockPrisma.alertSubscription.findMany).toHaveBeenCalledWith({
      where: {
        userId: "user-123",
        isActive: true,
        delivery: { has: "TELEGRAM" },
      },
    });
    expect(mockDeliverAlertToUser).not.toHaveBeenCalled();
  });

  it("dispatches to Telegram when an active TELEGRAM subscription exists", async () => {
    (mockPrisma.alertSubscription.findMany as jest.Mock).mockResolvedValueOnce([
      { id: "sub-1", delivery: ["TELEGRAM"] },
    ]);
    mockDeliverAlertToUser.mockResolvedValueOnce(undefined);

    await dispatchAlert(baseAlert);

    expect(mockDeliverAlertToUser).toHaveBeenCalledWith(baseAlert, "user-123");
  });

  it("logs Telegram delivery failures without throwing", async () => {
    const error = new Error("telegram offline");
    const errorSpy = logger.error as jest.Mock;
    (mockPrisma.alertSubscription.findMany as jest.Mock).mockResolvedValueOnce([
      { id: "sub-1", delivery: ["TELEGRAM"] },
    ]);
    mockDeliverAlertToUser.mockRejectedValueOnce(error);

    await dispatchAlert(baseAlert);
    await flushPromises();

    expect(errorSpy).toHaveBeenCalledWith({ err: error }, "[alertDelivery] Telegram delivery failed for alert alert-1");

    errorSpy.mockRestore();
  });

  it("logs subscription lookup failures without throwing", async () => {
    const error = new Error("db unavailable");
    const errorSpy = logger.error as jest.Mock;
    (mockPrisma.alertSubscription.findMany as jest.Mock).mockRejectedValueOnce(error);

    await expect(dispatchAlert(baseAlert)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith({ err: error }, "[alertDelivery] Dispatch failed for alert alert-1");

    errorSpy.mockRestore();
  });

  // ── deliveredAt stamping (Alert.deliveredAt + Telegram delivery tracking) ──
  //
  // dispatchAlert fires deliverAlertToUser without awaiting it, then attaches
  // a `.then((ok) => { if (ok) prisma.alert.update(...) })` callback. The two
  // tests below pin both branches of that callback so the field gets stamped
  // exactly when delivery actually succeeded — and never on failure.

  it("stamps deliveredAt on the Alert row when Telegram delivery succeeds", async () => {
    (mockPrisma.alertSubscription.findMany as jest.Mock).mockResolvedValueOnce([
      { id: "sub-1", delivery: ["TELEGRAM"] },
    ]);
    // Telegram delivery returns truthy → stamping branch fires.
    mockDeliverAlertToUser.mockResolvedValueOnce(true);
    // Reset the chained-mock so we can assert against this single call.
    (mockPrisma.alert.update as jest.Mock).mockClear();
    (mockPrisma.alert.update as jest.Mock).mockReturnValueOnce({ catch: jest.fn() });

    await dispatchAlert(baseAlert);
    // The .then() handler runs on the next microtask after the awaited
    // deliverAlertToUser promise resolves; flushing twice covers both the
    // deliver promise and the chained .then.
    await flushPromises();
    await flushPromises();

    expect(mockPrisma.alert.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.alert.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "alert-1" },
        data: expect.objectContaining({ deliveredAt: expect.any(Date) }),
      }),
    );
  });

  it("leaves deliveredAt unset when Telegram delivery fails", async () => {
    (mockPrisma.alertSubscription.findMany as jest.Mock).mockResolvedValueOnce([
      { id: "sub-1", delivery: ["TELEGRAM"] },
    ]);
    // Telegram delivery returns falsy → stamping branch must NOT fire.
    // (Falsy here means the bot couldn't reach the user — not an exception.
    // Exception path is covered by the existing "logs Telegram delivery
    // failures" test above.)
    mockDeliverAlertToUser.mockResolvedValueOnce(false);
    (mockPrisma.alert.update as jest.Mock).mockClear();

    await dispatchAlert(baseAlert);
    await flushPromises();
    await flushPromises();

    expect(mockPrisma.alert.update).not.toHaveBeenCalled();
  });
});
