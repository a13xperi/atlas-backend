import request from "supertest";
import express from "express";
import { requestIdMiddleware } from "../../middleware/requestId";
import { expectSuccessResponse } from "../helpers/response";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://localhost:5432/atlas_test";

type UserRecord = {
  id: string;
  handle: string;
  email: string;
  passwordHash: string | null;
  role: "ANALYST" | "MANAGER" | "ADMIN";
  supabaseId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: Date;
};

type VoiceProfileRecord = {
  id: string;
  userId: string;
  humor: number;
  formality: number;
  brevity: number;
  contrarianTone: number;
  maturity: "BEGINNER" | "INTERMEDIATE" | "ADVANCED";
};

type DraftRecord = {
  id: string;
  userId: string;
  content: string;
  status: "DRAFT" | "APPROVED" | "POSTED" | "ARCHIVED";
  sourceType: string | null;
  sourceContent: string | null;
  blendId: string | null;
  feedback: string | null;
  confidence: number | null;
  predictedEngagement: number | null;
  actualEngagement: number | null;
  engagementMetrics: Record<string, unknown> | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

type AnalyticsEventRecord = {
  id: string;
  userId: string;
  type: string;
  value?: number | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
};

type AlertSubscriptionRecord = {
  id: string;
  userId: string;
  type: "CATEGORY" | "ACCOUNT" | "REPORT_TYPE";
  value: string;
  isActive: boolean;
  delivery: Array<"PORTAL" | "TELEGRAM">;
};

type AlertRecord = {
  id: string;
  userId: string;
  type: string;
  title: string;
  context: string | null;
  sourceUrl: string | null;
  sentiment: string | null;
  relevance: number | null;
  createdAt: Date;
  expiresAt: Date | null;
};

type ResearchResultRecord = {
  id: string;
  userId: string;
  query: string;
  summary: string;
  keyFacts: string[];
  sentiment: "bullish" | "bearish" | "neutral" | "mixed";
  relatedTopics: string[];
  sources: string[];
  confidence: number;
  createdAt: Date;
};

type MockState = {
  users: UserRecord[];
  voiceProfiles: VoiceProfileRecord[];
  drafts: DraftRecord[];
  analyticsEvents: AnalyticsEventRecord[];
  alertSubscriptions: AlertSubscriptionRecord[];
  alerts: AlertRecord[];
  researchResults: ResearchResultRecord[];
  referenceVoices: Array<{
    id: string;
    userId: string;
    name: string;
    handle: string | null;
    isActive: boolean;
    createdAt: Date;
  }>;
};

const clone = <T>(value: T): T => structuredClone(value);

let sequence = 0;
let mockState = createState();

function createState(): MockState {
  sequence = 0;
  return {
    users: [],
    voiceProfiles: [],
    drafts: [],
    analyticsEvents: [],
    alertSubscriptions: [],
    alerts: [],
    researchResults: [],
    referenceVoices: [],
  };
}

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

function page<T>(items: T[], take?: number, skip?: number): T[] {
  return items.slice(skip ?? 0, (skip ?? 0) + (take ?? items.length));
}

function findUser(where: Record<string, string | undefined | null>) {
  if (where.id) return mockState.users.find((user) => user.id === where.id) ?? null;
  if (where.handle) return mockState.users.find((user) => user.handle === where.handle) ?? null;
  if (where.email) return mockState.users.find((user) => user.email === where.email) ?? null;
  if (where.supabaseId) return mockState.users.find((user) => user.supabaseId === where.supabaseId) ?? null;
  return null;
}

function buildUserResponse(user: UserRecord, include?: Record<string, boolean>) {
  if (include?.voiceProfile) {
    return clone({
      ...user,
      voiceProfile: mockState.voiceProfiles.find((profile) => profile.userId === user.id) ?? null,
    });
  }

  return clone(user);
}

const mockRedisClient = {
  ping: jest.fn().mockResolvedValue("PONG"),
};

const mockPrisma = {
  $queryRaw: jest.fn().mockResolvedValue(1),
  user: {
    findUnique: jest.fn(async (args: any) => {
      const user = findUser(args?.where ?? {});
      if (!user) return null;
      return buildUserResponse(user, args?.include);
    }),
    findFirst: jest.fn(async (args: any) => {
      const user = findUser(args?.where ?? {});
      if (!user) return null;
      return clone(user);
    }),
    create: jest.fn(async (args: any) => {
      const now = new Date();
      const user: UserRecord = {
        id: nextId("user"),
        handle: args.data.handle,
        email: args.data.email,
        passwordHash: args.data.passwordHash ?? null,
        role: "ANALYST",
        supabaseId: args.data.supabaseId ?? null,
        displayName: args.data.displayName ?? null,
        avatarUrl: args.data.avatarUrl ?? null,
        createdAt: now,
      };

      mockState.users.push(user);

      if (args.data.voiceProfile?.create) {
        mockState.voiceProfiles.push({
          id: nextId("voice"),
          userId: user.id,
          humor: 50,
          formality: 50,
          brevity: 50,
          contrarianTone: 50,
          maturity: "INTERMEDIATE",
        });
      }

      return buildUserResponse(user, args.include);
    }),
    update: jest.fn(async (args: any) => {
      const user = findUser(args.where ?? {});
      if (!user) throw new Error("User not found");

      Object.assign(user, args.data);
      return clone(user);
    }),
    findMany: jest.fn(async () => clone(mockState.users)),
  },
  voiceProfile: {
    findUnique: jest.fn(async (args: any) => {
      const profile = mockState.voiceProfiles.find((item) => item.userId === args.where.userId) ?? null;
      return profile ? clone(profile) : null;
    }),
    update: jest.fn(async (args: any) => {
      const profile = mockState.voiceProfiles.find((item) => item.userId === args.where.userId);
      if (!profile) throw new Error("Voice profile not found");

      Object.assign(profile, args.data);
      return clone(profile);
    }),
  },
  referenceVoice: {
    findMany: jest.fn(async (args: any) => {
      const voices = mockState.referenceVoices.filter(
        (voice) => voice.userId === args.where.userId && voice.isActive === args.where.isActive
      );
      return clone(page(voices, args.take, args.skip));
    }),
  },
  tweetDraft: {
    count: jest.fn(async (args: any) => {
      let drafts = mockState.drafts.filter((draft) => draft.userId === args.where.userId);
      if (args.where.status) {
        drafts = drafts.filter((draft) => draft.status === args.where.status);
      }
      if (args.where.createdAt?.gte) {
        drafts = drafts.filter((draft) => draft.createdAt >= args.where.createdAt.gte);
      }
      return drafts.length;
    }),
    findMany: jest.fn(async (args: any) => {
      let drafts = mockState.drafts.filter((draft) => draft.userId === args.where.userId);

      if (args.where.status) {
        drafts = drafts.filter((draft) => draft.status === args.where.status);
      }

      drafts.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return clone(page(drafts, args.take, args.skip));
    }),
    findFirst: jest.fn(async (args: any) => {
      const draft =
        mockState.drafts.find(
          (item) => item.id === args.where.id && item.userId === args.where.userId
        ) ?? null;
      return draft ? clone(draft) : null;
    }),
    create: jest.fn(async (args: any) => {
      const now = new Date();
      const draft: DraftRecord = {
        id: nextId("draft"),
        userId: args.data.userId,
        content: args.data.content,
        status: args.data.status ?? "DRAFT",
        sourceType: args.data.sourceType ?? null,
        sourceContent: args.data.sourceContent ?? null,
        blendId: args.data.blendId ?? null,
        feedback: args.data.feedback ?? null,
        confidence: args.data.confidence ?? null,
        predictedEngagement: args.data.predictedEngagement ?? null,
        actualEngagement: args.data.actualEngagement ?? null,
        engagementMetrics: args.data.engagementMetrics ?? null,
        version: args.data.version ?? 1,
        createdAt: now,
        updatedAt: now,
      };

      mockState.drafts.push(draft);
      return clone(draft);
    }),
  },
  analyticsEvent: {
    count: jest.fn(async (args: any) => {
      return mockState.analyticsEvents.filter((event) => {
        if (args.where.userId && event.userId !== args.where.userId) return false;
        if (args.where.type && event.type !== args.where.type) return false;
        if (args.where.createdAt?.gte && event.createdAt < args.where.createdAt.gte) return false;
        return true;
      }).length;
    }),
    create: jest.fn(async (args: any) => {
      const event: AnalyticsEventRecord = {
        id: nextId("event"),
        userId: args.data.userId,
        type: args.data.type,
        value: args.data.value ?? null,
        metadata: args.data.metadata ?? null,
        createdAt: new Date(),
      };

      mockState.analyticsEvents.push(event);
      return clone(event);
    }),
    findMany: jest.fn(async () => clone(mockState.analyticsEvents)),
  },
  alertSubscription: {
    findMany: jest.fn(async (args: any) => {
      const subscriptions = mockState.alertSubscriptions.filter(
        (subscription) => subscription.userId === args.where.userId
      );
      return clone(page(subscriptions, args.take, args.skip));
    }),
  },
  alert: {
    findMany: jest.fn(async (args: any) => {
      let alerts = mockState.alerts.filter((alert) => alert.userId === args.where.userId);

      if (args.where.expiresAt?.gt) {
        alerts = alerts.filter(
          (alert) => alert.expiresAt !== null && alert.expiresAt > args.where.expiresAt.gt
        );
      }

      if (args.orderBy?.createdAt === "desc") {
        alerts = [...alerts].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }

      if (args.orderBy?.relevance === "desc") {
        alerts = [...alerts].sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
      }

      return clone(page(alerts, args.take, args.skip));
    }),
  },
  researchResult: {
    findMany: jest.fn(async (args: any) => {
      const results = mockState.researchResults
        .filter((result) => result.userId === args.where.userId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      return clone(page(results, args.take, args.skip));
    }),
  },
  learningLogEntry: {
    findMany: jest.fn(async () => []),
  },
  session: {
    findMany: jest.fn(async () => []),
    findFirst: jest.fn(async () => null),
    delete: jest.fn(async () => null),
  },
  savedBlend: {
    findMany: jest.fn(async () => []),
  },
};

jest.mock("../../lib/prisma", () => ({ prisma: mockPrisma }));

jest.mock("../../lib/supabase", () => ({ supabaseAdmin: null }));

jest.mock("../../middleware/rateLimit", () => ({
  rateLimit: () => (_req: any, _res: any, next: any) => next(),
  rateLimitByUser: () => (_req: any, _res: any, next: any) => next(),
  clearRateLimitStore: jest.fn(),
}));

jest.mock("../../lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../../lib/redis", () => ({
  getRedis: jest.fn(() => mockRedisClient),
  getCached: jest.fn(),
  setCache: jest.fn(),
}));

// C-6: the e2e smoke flow re-uses a freshly minted JWT across many endpoints,
// so the jti blacklist must answer "not revoked" for the duration of the test.
// We stub the revocation helpers directly instead of teaching mockRedisClient
// to speak get/set, which would require synchronizing two separate fakes.
jest.mock("../../lib/jwt-revocation", () => ({
  isJtiRevoked: jest.fn().mockResolvedValue(false),
  revokeJti: jest.fn().mockResolvedValue(true),
  remainingTtlSeconds: jest.fn().mockReturnValue(3600),
}));

jest.mock("../../lib/research", () => ({
  conductResearch: jest.fn(),
}));

jest.mock("../../lib/grok", () => ({
  searchTrending: jest.fn(),
}));

jest.mock("../../lib/twitter", () => ({
  fetchTweetsByHandle: jest.fn(),
}));

jest.mock("../../lib/calibrate", () => ({
  calibrateFromTweets: jest.fn(),
}));

jest.mock("../../lib/telegram", () => ({
  initBot: jest.fn(),
  deliverAlert: jest.fn(),
  deliverAlertToUser: jest.fn(),
}));

jest.mock("bcryptjs", () => ({
  __esModule: true,
  default: {
    hash: jest.fn().mockResolvedValue("hashed-password"),
    compare: jest.fn().mockResolvedValue(true),
  },
}));

import { prisma } from "../../lib/prisma";
import { getRedis } from "../../lib/redis";
import { authRouter } from "../../routes/auth";
import { usersRouter } from "../../routes/users";
import { voiceRouter } from "../../routes/voice";
import { draftsRouter } from "../../routes/drafts";
import { analyticsRouter } from "../../routes/analytics";
import { alertsRouter } from "../../routes/alerts";
import { researchRouter } from "../../routes/research";
import { trendingRouter } from "../../routes/trending";

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);

app.get("/health", async (_req, res) => {
  const checks: Record<string, string> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.db = "ok";
  } catch {
    checks.db = "error";
  }

  try {
    const redis = getRedis();
    if (redis) {
      await redis.ping();
      checks.redis = "ok";
    } else {
      checks.redis = "not_configured";
    }
  } catch {
    checks.redis = "error";
  }

  const allOk = Object.values(checks).every((value) => value === "ok" || value === "not_configured");

  res.status(allOk ? 200 : 503).json({
    status: allOk ? "ok" : "degraded",
    service: "atlas-api",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    checks,
  });
});

app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/voice", voiceRouter);
app.use("/api/drafts", draftsRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/alerts", alertsRouter);
app.use("/api/research", researchRouter);
app.use("/api/trending", trendingRouter);

function createCredentials() {
  const suffix = Date.now().toString(36);
  return {
    handle: `smoke_${suffix}`,
    email: `smoke_${suffix}@atlas.test`,
    password: "SmokeTest123",
  };
}

describe("API E2E smoke suite", () => {
  beforeEach(() => {
    mockState = createState();
    jest.clearAllMocks();
    mockPrisma.$queryRaw.mockResolvedValue(1);
    mockRedisClient.ping.mockResolvedValue("PONG");
  });

  it("exercises the public API surface with one registered user", async () => {
    const credentials = createCredentials();

    const healthResponse = await request(app).get("/health");
    expect(healthResponse.status).toBe(200);
    expect(healthResponse.body).toEqual(
      expect.objectContaining({
        status: "ok",
      })
    );

    const registerResponse = await request(app)
      .post("/api/auth/register")
      .send(credentials);

    // The current router returns 200 on success; keep 201 accepted if the route is normalized later.
    expect([200, 201]).toContain(registerResponse.status);
    const registerData = expectSuccessResponse<any>(registerResponse.body);
    expect(registerData.token).toEqual(expect.any(String));

    const token = registerData.token as string;
    const auth = { Authorization: `Bearer ${token}` };

    const loginResponse = await request(app)
      .post("/api/auth/login")
      .send({ email: credentials.email, password: credentials.password });

    expect(loginResponse.status).toBe(200);
    expect(expectSuccessResponse<any>(loginResponse.body).token).toEqual(expect.any(String));

    const meResponse = await request(app).get("/api/auth/me").set(auth);
    expect(meResponse.status).toBe(200);

    const profileResponse = await request(app).get("/api/users/profile").set(auth);
    expect(profileResponse.status).toBe(200);

    // The concrete route is singular in the current app: /api/voice/profile.
    const voiceProfileResponse = await request(app).get("/api/voice/profile").set(auth);
    expect(voiceProfileResponse.status).toBe(200);

    const voiceReferencesResponse = await request(app).get("/api/voice/references").set(auth);
    expect(voiceReferencesResponse.status).toBe(200);

    const listDraftsResponse = await request(app).get("/api/drafts").set(auth);
    expect(listDraftsResponse.status).toBe(200);

    const createDraftResponse = await request(app)
      .post("/api/drafts")
      .set(auth)
      .send({
        content: "Atlas smoke draft about ETH liquidity conditions.",
        sourceType: "MANUAL",
      });

    // The current router returns 200 on success; keep 201 accepted if the route is normalized later.
    expect([200, 201]).toContain(createDraftResponse.status);

    const analyticsSummaryResponse = await request(app).get("/api/analytics/summary").set(auth);
    expect(analyticsSummaryResponse.status).toBe(200);

    const alertSubscriptionsResponse = await request(app)
      .get("/api/alerts/subscriptions")
      .set(auth);
    expect(alertSubscriptionsResponse.status).toBe(200);

    const alertFeedResponse = await request(app).get("/api/alerts/feed").set(auth);
    expect(alertFeedResponse.status).toBe(200);

    const researchHistoryResponse = await request(app).get("/api/research/history").set(auth);
    expect(researchHistoryResponse.status).toBe(200);

    // The concrete route is /api/trending/topics in the current app.
    const trendingTopicsResponse = await request(app).get("/api/trending/topics").set(auth);
    expect(trendingTopicsResponse.status).toBe(200);
  }, 15000);
});
