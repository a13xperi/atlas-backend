/**
 * Alert Scanner lib test suite
 * Tests scanTrendingForUser and runGlobalAlertScan
 * Mocks: Prisma, Grok, socket, alertDelivery, monitors
 */

jest.mock("../../lib/prisma", () => ({
  prisma: {
    alertSubscription: { findMany: jest.fn() },
    nlpMonitor: { findMany: jest.fn(), update: jest.fn() },
    alert: { create: jest.fn() },
    analyticsEvent: { create: jest.fn() },
  },
}));

jest.mock("../../lib/grok", () => ({
  searchTrending: jest.fn(),
}));

jest.mock("../../lib/socket", () => ({
  emitToUser: jest.fn(),
}));

jest.mock("../../lib/alertDelivery", () => ({
  dispatchAlert: jest.fn(),
}));

jest.mock("../../routes/monitors", () => ({
  matchMonitorKeywords: jest.fn(),
}));

import { scanTrendingForUser, runGlobalAlertScan } from "../../lib/alertScanner";
import { prisma } from "../../lib/prisma";
import { searchTrending } from "../../lib/grok";
import { emitToUser } from "../../lib/socket";
import { dispatchAlert } from "../../lib/alertDelivery";
import { matchMonitorKeywords } from "../../routes/monitors";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockSearchTrending = searchTrending as jest.Mock;
const mockEmitToUser = emitToUser as jest.Mock;
const mockDispatchAlert = dispatchAlert as jest.Mock;
const mockMatchMonitorKeywords = matchMonitorKeywords as jest.Mock;

const mockTrendingItem = {
  topic: "DeFi",
  headline: "DeFi TVL hits record high",
  context: "Total Value Locked...",
  tweetUrl: "https://x.com/example",
  sentiment: "bullish",
  relevanceScore: 0.9,
};

const mockAlert = {
  id: "alert-1",
  type: "DeFi",
  title: "DeFi TVL hits record high",
  context: "Total Value Locked...",
  sourceUrl: "https://x.com/example",
  sentiment: "bullish",
  relevance: 0.9,
  userId: "user-123",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDispatchAlert.mockResolvedValue(undefined);
});

describe("scanTrendingForUser", () => {
  it("uses subscriptions topics when available", async () => {
    (mockPrisma.alertSubscription.findMany as jest.Mock).mockResolvedValueOnce([
      { value: "DeFi" },
    ]);
    mockSearchTrending.mockResolvedValueOnce([mockTrendingItem]);
    (mockPrisma.alert.create as jest.Mock).mockResolvedValueOnce(mockAlert);
    (mockPrisma.nlpMonitor.findMany as jest.Mock).mockResolvedValueOnce([]);
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValueOnce({});

    const result = await scanTrendingForUser("user-123");

    expect(mockSearchTrending).toHaveBeenCalledWith(
      expect.objectContaining({ topics: ["DeFi"] })
    );
    expect(result.alerts).toBe(1);
    expect(result.monitorAlerts).toBe(0);
  });

  it("falls back to default topics when no subscriptions", async () => {
    (mockPrisma.alertSubscription.findMany as jest.Mock).mockResolvedValueOnce([]);
    mockSearchTrending.mockResolvedValueOnce([]);
    (mockPrisma.nlpMonitor.findMany as jest.Mock).mockResolvedValueOnce([]);
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValueOnce({});

    await scanTrendingForUser("user-123");

    expect(mockSearchTrending).toHaveBeenCalledWith(
      expect.objectContaining({ topics: ["DeFi", "ETH", "Bitcoin", "AI", "Crypto"] })
    );
  });

  it("emits websocket events and dispatches alerts for base alerts", async () => {
    (mockPrisma.alertSubscription.findMany as jest.Mock).mockResolvedValueOnce([
      { value: "DeFi" },
    ]);
    mockSearchTrending.mockResolvedValueOnce([mockTrendingItem]);
    (mockPrisma.alert.create as jest.Mock).mockResolvedValueOnce(mockAlert);
    (mockPrisma.nlpMonitor.findMany as jest.Mock).mockResolvedValueOnce([]);
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValueOnce({});

    await scanTrendingForUser("user-123");

    expect(mockEmitToUser).toHaveBeenCalledWith("user-123", "alert:new", mockAlert);
    expect(mockDispatchAlert).toHaveBeenCalledWith({
      id: "alert-1",
      title: "DeFi TVL hits record high",
      type: "DeFi",
      context: "Total Value Locked...",
      sourceUrl: "https://x.com/example",
      sentiment: "bullish",
      userId: "user-123",
    });
  });

  it("creates monitor alerts when keywords match", async () => {
    (mockPrisma.alertSubscription.findMany as jest.Mock).mockResolvedValueOnce([]);
    mockSearchTrending.mockResolvedValueOnce([mockTrendingItem]);
    (mockPrisma.alert.create as jest.Mock)
      .mockResolvedValueOnce(mockAlert)
      .mockResolvedValueOnce({
        id: "alert-2",
        type: "MONITOR",
        title: "[MyMonitor] DeFi TVL hits record high",
        context: "Matched keywords: TVL. Total Value Locked...",
        userId: "user-123",
      });
    (mockPrisma.nlpMonitor.findMany as jest.Mock).mockResolvedValueOnce([
      { id: "mon-1", name: "MyMonitor", keywords: ["TVL"], minRelevance: 0.5 },
    ]);
    mockMatchMonitorKeywords.mockReturnValueOnce({
      matched: true,
      matchedKeywords: ["TVL"],
      score: 1.0,
    });
    (mockPrisma.nlpMonitor.update as jest.Mock).mockResolvedValueOnce({});
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValueOnce({});

    const result = await scanTrendingForUser("user-123");

    expect(result.monitorAlerts).toBe(1);
    expect(mockEmitToUser).toHaveBeenCalledWith(
      "user-123",
      "alert:new",
      expect.objectContaining({ type: "MONITOR" })
    );
    expect(mockPrisma.nlpMonitor.update).toHaveBeenCalledWith({
      where: { id: "mon-1" },
      data: { matchCount: { increment: 1 } },
    });
  });

  it("logs analytics event with total alert count", async () => {
    (mockPrisma.alertSubscription.findMany as jest.Mock).mockResolvedValueOnce([]);
    mockSearchTrending.mockResolvedValueOnce([mockTrendingItem]);
    (mockPrisma.alert.create as jest.Mock).mockResolvedValueOnce(mockAlert);
    (mockPrisma.nlpMonitor.findMany as jest.Mock).mockResolvedValueOnce([]);
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValueOnce({});

    await scanTrendingForUser("user-123");

    expect(mockPrisma.analyticsEvent.create).toHaveBeenCalledWith({
      data: {
        userId: "user-123",
        type: "ALERT_GENERATED",
        value: 1,
      },
    });
  });
});

describe("runGlobalAlertScan", () => {
  it("scans for all users with active subscriptions or monitors", async () => {
    // First call = global distinct users from alertSubscription
    // Subsequent calls = per-user topic lookup inside scanTrendingForUser
    (mockPrisma.alertSubscription.findMany as jest.Mock)
      .mockResolvedValueOnce([{ userId: "user-a" }, { userId: "user-b" }])
      .mockResolvedValue([]);

    // First call = global distinct users from nlpMonitor
    // Subsequent calls = per-user monitor lookup inside scanTrendingForUser
    (mockPrisma.nlpMonitor.findMany as jest.Mock)
      .mockResolvedValueOnce([{ userId: "user-b" }, { userId: "user-c" }])
      .mockResolvedValue([]);

    mockSearchTrending.mockResolvedValue([]);
    (mockPrisma.alert.create as jest.Mock).mockResolvedValue(mockAlert);
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValue({});

    const result = await runGlobalAlertScan();

    expect(result.users).toBe(3);
    expect(mockSearchTrending).toHaveBeenCalledTimes(3);
  });

  it("counts failures but continues scanning remaining users", async () => {
    (mockPrisma.alertSubscription.findMany as jest.Mock)
      .mockResolvedValueOnce([{ userId: "user-a" }, { userId: "user-b" }])
      .mockResolvedValue([]);

    (mockPrisma.nlpMonitor.findMany as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValue([]);

    mockSearchTrending
      .mockRejectedValueOnce(new Error("Grok down"))
      .mockResolvedValueOnce([]);

    (mockPrisma.alert.create as jest.Mock).mockResolvedValue(mockAlert);
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValue({});

    const result = await runGlobalAlertScan();

    expect(result.failed).toBe(1);
    expect(result.users).toBe(2);
  });
});
