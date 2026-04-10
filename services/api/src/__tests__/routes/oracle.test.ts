import request from "supertest";
import express from "express";
import { oracleRouter } from "../../routes/oracle";
import { requestIdMiddleware } from "../../middleware/requestId";
import { expectSuccessResponse } from "../helpers/response";

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
      findUnique: jest.fn(),
    },
    voiceProfile: {
      findUnique: jest.fn(),
    },
    tweetDraft: {
      findMany: jest.fn(),
    },
    briefingPreference: {
      findUnique: jest.fn(),
    },
    oracleSession: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
    analyticsEvent: {
      create: jest.fn(),
    },
  },
}));

jest.mock("../../lib/oracle-chat", () => ({
  streamOracleResponse: jest.fn(),
}));

import { prisma } from "../../lib/prisma";
import { streamOracleResponse } from "../../lib/oracle-chat";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockStreamOracleResponse = streamOracleResponse as jest.MockedFunction<typeof streamOracleResponse>;

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/oracle", oracleRouter);

const AUTH = { Authorization: "Bearer mock-token" };

const mockUser = {
  id: "user-123",
  handle: "atlas",
  displayName: "Atlas Analyst",
  avatarUrl: null,
  onboardingTrack: "TRACK_A",
  xHandle: "atlas_x",
};

const mockVoiceProfile = {
  humor: 61,
  formality: 48,
  brevity: 72,
  contrarianTone: 66,
  directness: 58,
  warmth: 44,
  technicalDepth: 70,
  confidence: 64,
  evidenceOrientation: 73,
  solutionOrientation: 67,
  socialPosture: 52,
  selfPromotionalIntensity: 33,
  maturity: "ADVANCED",
  tweetsAnalyzed: 18,
  updatedAt: new Date("2026-04-01T12:00:00.000Z"),
};

const mockDrafts = [
  {
    id: "draft-1",
    content: "ETH beta is a positioning story before it is a valuation story.",
    status: "DRAFT",
    sourceType: "MANUAL",
    updatedAt: new Date("2026-04-08T08:00:00.000Z"),
  },
];

const mockBriefingPreference = {
  topics: ["DeFi", "L2s"],
  sources: ["X", "Research"],
  channel: "PORTAL",
};

beforeEach(() => {
  jest.clearAllMocks();

  (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
  (mockPrisma.voiceProfile.findUnique as jest.Mock).mockResolvedValue(mockVoiceProfile);
  (mockPrisma.tweetDraft.findMany as jest.Mock).mockResolvedValue(mockDrafts);
  (mockPrisma.briefingPreference.findUnique as jest.Mock).mockResolvedValue(mockBriefingPreference);
  (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValue({});
});

describe("POST /api/oracle/session", () => {
  it("creates a new persistent session with enriched context", async () => {
    (mockPrisma.oracleSession.findFirst as jest.Mock).mockResolvedValueOnce(null);
    (mockPrisma.oracleSession.create as jest.Mock).mockImplementation(async ({ data }) => ({
      id: "oracle-session-1",
      userId: data.userId,
      messages: data.messages,
      context: data.context,
      createdAt: new Date("2026-04-09T10:00:00.000Z"),
      updatedAt: new Date("2026-04-09T10:00:00.000Z"),
    }));

    const res = await request(app)
      .post("/api/oracle/session")
      .set(AUTH)
      .send({
        context: {
          currentPage: "/dashboard",
          goals: ["Grow reach", "Sharpen voice"],
        },
      });

    expect(res.status).toBe(201);
    const data = expectSuccessResponse<{ session: any; created: boolean }>(res.body);
    expect(data.created).toBe(true);
    expect(data.session.id).toBe("oracle-session-1");

    expect(mockPrisma.oracleSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-123",
          context: expect.objectContaining({
            currentPage: "/dashboard",
            goals: ["Grow reach", "Sharpen voice"],
            user: expect.objectContaining({ handle: "atlas" }),
            recentTweets: expect.arrayContaining([
              expect.objectContaining({ id: "draft-1" }),
            ]),
          }),
        }),
      }),
    );
  });

  it("retrieves an existing session by id and refreshes context", async () => {
    const existingSession = {
      id: "oracle-session-1",
      userId: "user-123",
      messages: [],
      context: {
        currentPage: "/crafting",
        goals: ["Existing goal"],
      },
      createdAt: new Date("2026-04-08T10:00:00.000Z"),
      updatedAt: new Date("2026-04-08T10:00:00.000Z"),
    };

    (mockPrisma.oracleSession.findFirst as jest.Mock).mockResolvedValueOnce(existingSession);
    (mockPrisma.oracleSession.update as jest.Mock).mockImplementation(async ({ data }) => ({
      ...existingSession,
      context: data.context,
      updatedAt: new Date("2026-04-09T11:00:00.000Z"),
    }));

    const res = await request(app)
      .post("/api/oracle/session")
      .set(AUTH)
      .send({
        sessionId: "oracle-session-1",
        context: { currentPage: "/analytics" },
      });

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<{ session: any; created: boolean }>(res.body);
    expect(data.created).toBe(false);
    expect(data.session.context.currentPage).toBe("/analytics");
    expect(data.session.context.goals).toEqual(["Existing goal"]);
  });
});

describe("GET /api/oracle/session/:id", () => {
  it("returns the session with message history", async () => {
    (mockPrisma.oracleSession.findFirst as jest.Mock).mockResolvedValueOnce({
      id: "oracle-session-1",
      userId: "user-123",
      messages: [
        { role: "user", content: "hello", timestamp: "2026-04-09T10:00:00.000Z" },
        { role: "oracle", content: "gm", timestamp: "2026-04-09T10:00:02.000Z" },
      ],
      context: { currentPage: "/dashboard", goals: ["Grow reach"] },
      createdAt: new Date("2026-04-09T10:00:00.000Z"),
      updatedAt: new Date("2026-04-09T10:00:02.000Z"),
    });

    const res = await request(app)
      .get("/api/oracle/session/oracle-session-1")
      .set(AUTH);

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<{ session: any }>(res.body);
    expect(data.session.messages).toHaveLength(2);
    expect(data.session.messages[1].content).toBe("gm");
  });
});

describe("DELETE /api/oracle/session/:id", () => {
  it("clears the session", async () => {
    (mockPrisma.oracleSession.deleteMany as jest.Mock).mockResolvedValueOnce({ count: 1 });

    const res = await request(app)
      .delete("/api/oracle/session/oracle-session-1")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(expectSuccessResponse<{ deleted: boolean }>(res.body).deleted).toBe(true);
  });
});

describe("POST /api/oracle/message", () => {
  it("streams an Oracle response and persists both user and assistant messages", async () => {
    const baseSession = {
      id: "oracle-session-1",
      userId: "user-123",
      messages: [
        { role: "user", content: "previous", timestamp: "2026-04-09T09:59:00.000Z" },
      ],
      context: { currentPage: "/dashboard", goals: ["Grow reach"] },
      createdAt: new Date("2026-04-09T09:59:00.000Z"),
      updatedAt: new Date("2026-04-09T09:59:00.000Z"),
    };

    let currentSession = { ...baseSession };

    (mockPrisma.oracleSession.findFirst as jest.Mock).mockResolvedValueOnce(baseSession);
    (mockPrisma.oracleSession.update as jest.Mock).mockImplementation(async ({ data }) => {
      currentSession = {
        ...currentSession,
        messages: data.messages,
        context: data.context,
        updatedAt: new Date("2026-04-09T10:05:00.000Z"),
      };

      return currentSession;
    });

    mockStreamOracleResponse.mockImplementation(async ({ onText }) => {
      onText("Hello", "Hello");
      onText(" world", "Hello world");

      return {
        text: "Hello world",
        model: "claude-sonnet-test",
        requestId: "req_123",
      };
    });

    const res = await request(app)
      .post("/api/oracle/message")
      .set(AUTH)
      .send({
        sessionId: "oracle-session-1",
        content: "What should I write next?",
        context: { currentPage: "/crafting" },
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.text).toContain("event: delta");
    expect(res.text).toContain("Hello world");
    expect(res.text).toContain("event: done");

    expect(mockPrisma.oracleSession.update).toHaveBeenCalledTimes(2);
    expect(mockPrisma.oracleSession.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({ role: "user", content: "What should I write next?" }),
            expect.objectContaining({ role: "oracle", content: "Hello world" }),
          ]),
        }),
      }),
    );
  });

  it("keeps the legacy onboarding /message behavior intact", async () => {
    const res = await request(app)
      .post("/api/oracle/message")
      .set(AUTH)
      .send({
        track: "a",
        step: "welcome",
        action: "continue",
      });

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<{ messages: Array<{ content: string; role: string }>; llmGenerated: boolean }>(res.body);
    expect(data.llmGenerated).toBe(false);
    expect(data.messages).toEqual([]);
  });
});
