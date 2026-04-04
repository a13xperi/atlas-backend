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
});
