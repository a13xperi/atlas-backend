import request from "supertest";
import express from "express";
import { telegramRouter } from "../../routes/telegram";
import { requestIdMiddleware } from "../../middleware/requestId";
import { expectErrorResponse, expectSuccessResponse } from "../helpers/response";

jest.mock("../../middleware/auth", () => ({
  authenticate: jest.fn((req: any, res: any, next: any) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing authorization token" });
    }
    req.userId = "user-123";
    next();
  }),
  AuthRequest: {},
}));

jest.mock("../../lib/prisma", () => ({
  prisma: {
    user: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock("../../lib/telegramClient", () => ({
  formatTelegramDispatchMessage: jest.fn((type: string, message: string) => `Atlas ${type}\n\n${message}`),
  sendTelegramMessage: jest.fn(),
}));

import { prisma } from "../../lib/prisma";
import {
  formatTelegramDispatchMessage,
  sendTelegramMessage,
} from "../../lib/telegramClient";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockSendTelegramMessage = sendTelegramMessage as jest.Mock;
const mockFormatTelegramDispatchMessage = formatTelegramDispatchMessage as jest.Mock;

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/telegram", telegramRouter);

const AUTH = { Authorization: "Bearer mock_token" };

beforeAll(() => {
  process.env.JWT_SECRET = "test-secret";
});

afterAll(() => {
  delete process.env.JWT_SECRET;
});

describe("POST /api/telegram/connect", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).post("/api/telegram/connect").send({ chatId: "12345" });
    expect(res.status).toBe(401);
  });

  it("links the current user to a Telegram chat", async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValueOnce(null);
    (mockPrisma.user.update as jest.Mock).mockResolvedValueOnce({
      id: "user-123",
      handle: "atlas",
      telegramChatId: "12345",
    });

    const res = await request(app)
      .post("/api/telegram/connect")
      .set(AUTH)
      .send({ chatId: 12345 });

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);
    expect(data.user.telegramChatId).toBe("12345");
    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith({
      where: {
        telegramChatId: "12345",
        id: { not: "user-123" },
      },
      select: { id: true },
    });
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-123" },
      data: { telegramChatId: "12345" },
      select: { id: true, handle: true, telegramChatId: true },
    });
  });

  it("rejects chats already linked to another user", async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValueOnce({ id: "user-999" });

    const res = await request(app)
      .post("/api/telegram/connect")
      .set(AUTH)
      .send({ chatId: "99999" });

    expect(res.status).toBe(409);
    expectErrorResponse(res.body, "Telegram chat is already linked to another Atlas account");
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid payloads", async () => {
    const res = await request(app).post("/api/telegram/connect").set(AUTH).send({});

    expect(res.status).toBe(400);
    const body = expectErrorResponse(res.body, "Invalid request");
    expect(Array.isArray(body.details)).toBe(true);
  });
});

describe("POST /api/telegram/send", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 403 when an analyst targets another user", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ role: "ANALYST" });

    const res = await request(app)
      .post("/api/telegram/send")
      .set(AUTH)
      .send({ userId: "user-999", message: "Signal", type: "alert" });

    expect(res.status).toBe(403);
    expectErrorResponse(res.body, "Cannot send Telegram messages for another user");
  });

  it("returns 404 when the recipient has no linked Telegram chat", async () => {
    (mockPrisma.user.findUnique as jest.Mock)
      .mockResolvedValueOnce({ role: "MANAGER" })
      .mockResolvedValueOnce({ telegramChatId: null });

    const res = await request(app)
      .post("/api/telegram/send")
      .set(AUTH)
      .send({ userId: "user-456", message: "Signal", type: "digest" });

    expect(res.status).toBe(404);
    expectErrorResponse(res.body, "Telegram is not linked for that user");
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("formats and sends the Telegram message", async () => {
    (mockPrisma.user.findUnique as jest.Mock)
      .mockResolvedValueOnce({ role: "MANAGER" })
      .mockResolvedValueOnce({ telegramChatId: "chat-456" });
    mockSendTelegramMessage.mockResolvedValueOnce(true);

    const res = await request(app)
      .post("/api/telegram/send")
      .set(AUTH)
      .send({ userId: "user-456", message: "  BTC broke out  ", type: "alert" });

    expect(res.status).toBe(200);
    expect(expectSuccessResponse<any>(res.body).sent).toBe(true);
    expect(mockFormatTelegramDispatchMessage).toHaveBeenCalledWith("alert", "BTC broke out");
    expect(mockSendTelegramMessage).toHaveBeenCalledWith("chat-456", "Atlas alert\n\nBTC broke out");
  });

  it("returns 502 when Telegram delivery fails", async () => {
    (mockPrisma.user.findUnique as jest.Mock)
      .mockResolvedValueOnce({ role: "MANAGER" })
      .mockResolvedValueOnce({ telegramChatId: "chat-456" });
    mockSendTelegramMessage.mockResolvedValueOnce(false);

    const res = await request(app)
      .post("/api/telegram/send")
      .set(AUTH)
      .send({ userId: "user-456", message: "Report ready", type: "report" });

    expect(res.status).toBe(502);
    expectErrorResponse(res.body, "Failed to send Telegram message");
  });
});
