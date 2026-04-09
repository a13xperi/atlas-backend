import request from "supertest";
import express from "express";
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

jest.mock("../../lib/config", () => ({
  config: {
    PAPERCLIP_WEBHOOK_SECRET: "paperclip-webhook-secret",
  },
}));

jest.mock("../../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
    },
    briefing: {
      create: jest.fn(),
    },
  },
}));

jest.mock("../../lib/telegram", () => ({
  deliverAlertToUser: jest.fn(),
}));

jest.mock("../../lib/paperclip", () => {
  class MockPaperclipError extends Error {
    constructor(
      message: string,
      public readonly statusCode = 502,
      public readonly details?: unknown,
    ) {
      super(message);
      this.name = "PaperclipError";
    }
  }

  return {
    PaperclipError: MockPaperclipError,
    triggerPaperclipTask: jest.fn(),
  };
});

import { prisma } from "../../lib/prisma";
import { deliverAlertToUser } from "../../lib/telegram";
import { PaperclipError, triggerPaperclipTask } from "../../lib/paperclip";
import { paperclipRouter } from "../../routes/paperclip";

const mockPrisma = prisma as unknown as {
  user: {
    findUnique: jest.Mock;
  };
  briefing: {
    create: jest.Mock;
  };
};
const mockDeliverAlertToUser = deliverAlertToUser as jest.MockedFunction<
  typeof deliverAlertToUser
>;
const mockTriggerPaperclipTask = triggerPaperclipTask as jest.MockedFunction<
  typeof triggerPaperclipTask
>;

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/paperclip", paperclipRouter);

const AUTH = { Authorization: "Bearer mock-token" };
const WEBHOOK_HEADERS = { "x-paperclip-secret": "paperclip-webhook-secret" };

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /api/paperclip/webhook", () => {
  it("rejects requests with an invalid secret", async () => {
    const res = await request(app)
      .post("/api/paperclip/webhook")
      .set("x-paperclip-secret", "wrong-secret")
      .send({ type: "task.completed" });

    expect(res.status).toBe(401);
    expectErrorResponse(res.body, "Invalid Paperclip secret");
  });

  it("acknowledges non-digest events", async () => {
    const res = await request(app)
      .post("/api/paperclip/webhook")
      .set(WEBHOOK_HEADERS)
      .send({ type: "task.completed", data: { taskId: "task-1" } });

    expect(res.status).toBe(200);
    expect(expectSuccessResponse<{ received: boolean; event: string }>(res.body)).toEqual({
      received: true,
      event: "task.completed",
    });
    expect(mockPrisma.briefing.create).not.toHaveBeenCalled();
  });

  it("stores digest events as briefings and notifies Telegram when linked", async () => {
    (mockPrisma.briefing.create as jest.Mock).mockResolvedValueOnce({ id: "briefing-1" });
    mockDeliverAlertToUser.mockResolvedValueOnce(true);

    const res = await request(app)
      .post("/api/paperclip/webhook")
      .set(WEBHOOK_HEADERS)
      .send({
        type: "digest.ready",
        data: {
          userId: "user-123",
          digest: {
            title: "Morning Alpha",
            summary: "BTC and SOL flows accelerated overnight.",
            sections: [
              {
                heading: "Flows",
                emoji: "📈",
                bullets: ["BTC ETF demand stayed firm."],
              },
            ],
            topics: ["BTC", "SOL"],
            sources: ["Paperclip"],
          },
        },
      });

    expect(res.status).toBe(200);
    expect(
      expectSuccessResponse<{
        received: boolean;
        event: string;
        briefingId: string;
        telegramNotified: boolean;
      }>(res.body),
    ).toEqual({
      received: true,
      event: "digest.ready",
      briefingId: "briefing-1",
      telegramNotified: true,
    });
    expect(mockPrisma.briefing.create).toHaveBeenCalledWith({
      data: {
        userId: "user-123",
        title: "Morning Alpha",
        summary: "BTC and SOL flows accelerated overnight.",
        sections: [
          {
            heading: "Flows",
            emoji: "📈",
            bullets: ["BTC ETF demand stayed firm."],
          },
        ],
        topics: ["BTC", "SOL"],
        sources: ["Paperclip"],
      },
    });
    expect(mockDeliverAlertToUser).toHaveBeenCalledWith(
      {
        title: "Morning Alpha",
        context: "BTC and SOL flows accelerated overnight.",
      },
      "user-123",
    );
  });

  it("returns 400 for malformed digest payloads", async () => {
    const res = await request(app)
      .post("/api/paperclip/webhook")
      .set(WEBHOOK_HEADERS)
      .send({ type: "digest.ready", data: { digest: { title: "Missing user" } } });

    expect(res.status).toBe(400);
    expectErrorResponse(res.body, "Invalid digest payload");
  });
});

describe("POST /api/paperclip/trigger", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/paperclip/trigger").send({
      agentId: "agent-1",
      taskType: "digest.generate",
      payload: {},
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Missing authorization token");
  });

  it("requires an admin user", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ role: "ANALYST" });

    const res = await request(app)
      .post("/api/paperclip/trigger")
      .set(AUTH)
      .send({
        agentId: "agent-1",
        taskType: "digest.generate",
        payload: {},
      });

    expect(res.status).toBe(403);
    expectErrorResponse(res.body, "Admin access required");
  });

  it("validates the trigger payload", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ role: "ADMIN" });

    const res = await request(app)
      .post("/api/paperclip/trigger")
      .set(AUTH)
      .send({
        taskType: "digest.generate",
        payload: {},
      });

    expect(res.status).toBe(400);
    expectErrorResponse(res.body, "Invalid request");
    expect(mockTriggerPaperclipTask).not.toHaveBeenCalled();
  });

  it("triggers Paperclip tasks for admins", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ role: "ADMIN" });
    mockTriggerPaperclipTask.mockResolvedValueOnce({ id: "task-1", status: "queued" });

    const res = await request(app)
      .post("/api/paperclip/trigger")
      .set(AUTH)
      .send({
        agentId: "agent-1",
        taskType: "digest.generate",
        payload: { userId: "user-123" },
      });

    expect(res.status).toBe(201);
    expect(expectSuccessResponse<{ task: { id: string; status: string } }>(res.body)).toEqual({
      task: { id: "task-1", status: "queued" },
    });
    expect(mockTriggerPaperclipTask).toHaveBeenCalledWith({
      agentId: "agent-1",
      taskType: "digest.generate",
      payload: { userId: "user-123" },
    });
  });

  it("surfaces upstream Paperclip errors", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ role: "ADMIN" });
    mockTriggerPaperclipTask.mockRejectedValueOnce(
      new PaperclipError("Paperclip unavailable", 502, { error: "down" }),
    );

    const res = await request(app)
      .post("/api/paperclip/trigger")
      .set(AUTH)
      .send({
        agentId: "agent-1",
        taskType: "digest.generate",
        payload: {},
      });

    expect(res.status).toBe(502);
    const body = expectErrorResponse(res.body, "Paperclip unavailable");
    expect(body.details).toEqual({ error: "down" });
  });
});
