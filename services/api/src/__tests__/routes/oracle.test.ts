import express from "express";
import request from "supertest";
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
    oracleSession: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock("../../lib/anthropic", () => ({
  getAnthropicClient: jest.fn(),
}));

jest.mock("../../lib/providers/router", () => ({
  routeCompletion: jest.fn(),
}));

jest.mock("../../lib/oracle-prompt", () => ({
  buildOracleSystemPrompt: jest.fn(() => "Oracle system prompt"),
  buildCalibrationCommentary: jest.fn(),
  buildBlendPreview: jest.fn(),
  buildDimensionReaction: jest.fn(),
  buildFreeTextResponse: jest.fn(),
}));

jest.mock("../../lib/oracle-tools", () => ({
  ORACLE_TOOLS: [],
  CONFIRMATION_REQUIRED: new Set(),
  SERVER_EXECUTABLE: new Set(),
}));

jest.mock("../../lib/timeout", () => ({
  withTimeout: jest.fn((promise: Promise<unknown>) => promise),
}));

jest.mock("../../lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { prisma } from "../../lib/prisma";
import { getAnthropicClient } from "../../lib/anthropic";
import { oracleRouter } from "../../routes/oracle";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockGetAnthropicClient = getAnthropicClient as jest.Mock;
const mockAnthropicCreate = jest.fn();

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/oracle", oracleRouter);

const AUTH = { Authorization: "Bearer mock-token" };

const baseSession = {
  id: "oracle-session-1",
  userId: "user-123",
  messages: [],
  context: null,
  createdAt: new Date("2026-04-10T08:00:00.000Z"),
  updatedAt: new Date("2026-04-10T08:00:00.000Z"),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAnthropicClient.mockReturnValue({
    messages: {
      create: mockAnthropicCreate,
    },
  });
});

describe("GET /api/oracle/session", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/oracle/session");
    expect(res.status).toBe(401);
  });

  it("creates a session when one does not exist", async () => {
    (mockPrisma.oracleSession.findFirst as jest.Mock).mockResolvedValueOnce(null);
    (mockPrisma.oracleSession.create as jest.Mock).mockResolvedValueOnce(baseSession);

    const res = await request(app).get("/api/oracle/session").set(AUTH);

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);
    expect(data.sessionId).toBe("oracle-session-1");
    expect(data.messages).toEqual([]);
    expect(mockPrisma.oracleSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-123",
        }),
      }),
    );
  });

  it("returns the existing session state", async () => {
    const existingSession = {
      ...baseSession,
      messages: [
        {
          role: "user",
          content: "What should I write about today?",
          timestamp: "2026-04-10T08:01:00.000Z",
        },
      ],
      context: {
        page: "oracle",
      },
    };

    (mockPrisma.oracleSession.findFirst as jest.Mock).mockResolvedValueOnce(existingSession);

    const res = await request(app).get("/api/oracle/session").set(AUTH);

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);
    expect(data.messages).toHaveLength(1);
    expect(data.context.page).toBe("oracle");
  });
});

describe("POST /api/oracle/message", () => {
  it("returns 400 for empty content", async () => {
    const res = await request(app)
      .post("/api/oracle/message")
      .set(AUTH)
      .send({ content: "" });

    expect(res.status).toBe(400);
    expectErrorResponse(res.body, "Invalid request");
  });

  it("persists the user message and assistant reply", async () => {
    (mockPrisma.oracleSession.findFirst as jest.Mock).mockResolvedValueOnce(baseSession);

    const sessionAfterUserMessage = {
      ...baseSession,
      messages: [
        {
          role: "user",
          content: "Give me a contrarian BTC take.",
          timestamp: "2026-04-10T08:02:00.000Z",
        },
      ],
      context: {
        page: "oracle",
      },
    };

    const sessionAfterAssistantReply = {
      ...baseSession,
      messages: [
        ...sessionAfterUserMessage.messages,
        {
          role: "assistant",
          content: "Everyone wants upside. The better trade is patience until conviction returns.",
          timestamp: "2026-04-10T08:02:05.000Z",
        },
      ],
      context: {
        page: "oracle",
      },
    };

    (mockPrisma.oracleSession.update as jest.Mock)
      .mockResolvedValueOnce(sessionAfterUserMessage)
      .mockResolvedValueOnce(sessionAfterAssistantReply);

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: "Everyone wants upside. The better trade is patience until conviction returns.",
        },
      ],
    });

    const res = await request(app)
      .post("/api/oracle/message")
      .set(AUTH)
      .send({
        content: "Give me a contrarian BTC take.",
        context: { page: "oracle" },
      });

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);
    expect(data.reply.role).toBe("assistant");
    expect(data.reply.content).toContain("Everyone wants upside.");
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0].role).toBe("user");
    expect(data.messages[1].role).toBe("assistant");

    expect(mockAnthropicCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-4-6",
        system: expect.stringContaining("Oracle system prompt"),
        messages: [
          {
            role: "user",
            content: "Give me a contrarian BTC take.",
          },
        ],
      }),
    );

    expect(mockPrisma.oracleSession.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: "oracle-session-1" },
        data: expect.objectContaining({
          context: { page: "oracle" },
        }),
      }),
    );
    expect(mockPrisma.oracleSession.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: "oracle-session-1" },
      }),
    );
  });
});

describe("DELETE /api/oracle/session", () => {
  it("clears persisted session messages", async () => {
    const populatedSession = {
      ...baseSession,
      messages: [
        {
          role: "user",
          content: "Hello",
          timestamp: "2026-04-10T08:01:00.000Z",
        },
      ],
    };

    (mockPrisma.oracleSession.findFirst as jest.Mock).mockResolvedValueOnce(populatedSession);
    (mockPrisma.oracleSession.update as jest.Mock).mockResolvedValueOnce(baseSession);

    const res = await request(app).delete("/api/oracle/session").set(AUTH);

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);
    expect(data.messages).toEqual([]);
    expect(mockPrisma.oracleSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "oracle-session-1" },
        data: expect.objectContaining({
          messages: [],
        }),
      }),
    );
  });
});
