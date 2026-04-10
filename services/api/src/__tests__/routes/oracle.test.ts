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
    voiceProfile: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    tweetDraft: {
      count: jest.fn().mockResolvedValue(0),
    },
  },
}));

jest.mock("../../lib/anthropic", () => ({
  getAnthropicClient: jest.fn(),
}));

jest.mock("../../lib/providers/router", () => ({
  routeCompletion: jest.fn(),
}));

jest.mock("../../lib/openclaw-router", () => ({
  runOracleCompletion: jest.fn(),
  resolveProfileForPhase: jest.fn((phase?: string) => {
    if (!phase) return "fast";
    const p = phase.toLowerCase();
    return p.includes("calibrat") || p.includes("analy") || p.includes("smart")
      ? "smart"
      : "fast";
  }),
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
import { runOracleCompletion } from "../../lib/openclaw-router";
import { oracleRouter } from "../../routes/oracle";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockGetAnthropicClient = getAnthropicClient as jest.Mock;
const mockAnthropicCreate = jest.fn();
const mockRunOracleCompletion = runOracleCompletion as jest.MockedFunction<
  typeof runOracleCompletion
>;

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

describe("POST /api/oracle/chat (OpenClaw shape)", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app)
      .post("/api/oracle/chat")
      .send({ message: "Hey Oracle" });
    expect(res.status).toBe(401);
  });

  it("routes `message` payloads through the OpenClaw router", async () => {
    mockRunOracleCompletion.mockResolvedValueOnce({
      reply: "Your voice leans contrarian — lean in.",
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      tokens: 248,
      latencyMs: 512,
    });

    const res = await request(app)
      .post("/api/oracle/chat")
      .set(AUTH)
      .send({
        message: "Help me calibrate my voice",
        phase: "calibration",
        context: { track: "a" },
      });

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);
    expect(data.reply).toContain("contrarian");
    expect(data.model).toBe("claude-haiku-4-5-20251001");
    expect(data.tokens).toBe(248);

    expect(mockRunOracleCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: "smart",
        userMessage: "Help me calibrate my voice",
        systemPrompt: expect.stringContaining("Current phase: calibration"),
      }),
    );
  });

  it("defaults to the fast profile for quick chat", async () => {
    mockRunOracleCompletion.mockResolvedValueOnce({
      reply: "Try opening with a contrarian hook.",
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      tokens: 90,
      latencyMs: 320,
    });

    const res = await request(app)
      .post("/api/oracle/chat")
      .set(AUTH)
      .send({ message: "What should I tweet about ETH?" });

    expect(res.status).toBe(200);
    expect(mockRunOracleCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "fast" }),
    );
  });

  it("still supports the legacy { messages, page } shape", async () => {
    const { routeCompletion } = jest.requireMock("../../lib/providers/router");
    (routeCompletion as jest.Mock).mockResolvedValueOnce({
      content: "Legacy reply",
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      latencyMs: 100,
    });

    const res = await request(app)
      .post("/api/oracle/chat")
      .set(AUTH)
      .send({
        messages: [{ role: "user", content: "hi" }],
        page: "dashboard",
      });

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);
    expect(data.text).toBe("Legacy reply");
    expect(mockRunOracleCompletion).not.toHaveBeenCalled();
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
