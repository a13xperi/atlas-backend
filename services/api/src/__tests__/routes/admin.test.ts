/**
 * Admin routes test suite
 * Tests GET /overview, /roster, /pipeline, /adoption, /activity-daily
 * Mocks: Prisma, auth middleware
 */

import request from "supertest";
import express from "express";
import { adminRouter } from "../../routes/admin";
import { requestIdMiddleware } from "../../middleware/requestId";
import { expectErrorResponse, expectSuccessResponse } from "../helpers/response";

/* ── Auth mock ────────────────────────────────────────────────── */
jest.mock("../../middleware/auth", () => ({
  authenticate: jest.fn((req: any, res: any, next: any) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer "))
      return res.status(401).json({ error: "Missing authorization token" });
    req.userId = "user-admin";
    next();
  }),
  AuthRequest: {},
}));

jest.mock("../../lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("../../lib/logger", () => ({ logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() } }));

jest.mock("../../lib/prompt-catalog", () => ({
  getPromptCatalog: jest.fn(),
  getPromptById: jest.fn(),
  renderTemplate: jest.fn(),
}));

jest.mock("../../lib/anthropic", () => ({
  getAnthropicClient: jest.fn(),
}));

/* ── Prisma mock ──────────────────────────────────────────────── */
jest.mock("../../lib/prisma", () => ({
  prisma: {
    user: {
      count: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    analyticsEvent: {
      count: jest.fn(),
      groupBy: jest.fn(),
      findMany: jest.fn(),
    },
    tweetDraft: {
      aggregate: jest.fn(),
      groupBy: jest.fn(),
    },
    voiceProfile: {
      count: jest.fn(),
    },
    alertSubscription: {
      groupBy: jest.fn(),
    },
    briefing: {
      groupBy: jest.fn(),
    },
    campaign: {
      groupBy: jest.fn(),
    },
  },
}));

import { prisma } from "../../lib/prisma";
import { getPromptCatalog, getPromptById, renderTemplate } from "../../lib/prompt-catalog";
import { getAnthropicClient } from "../../lib/anthropic";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

/* ── App setup ────────────────────────────────────────────────── */
const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/admin", adminRouter);

const AUTH = { Authorization: "Bearer mock_token" };

beforeAll(() => {
  process.env.JWT_SECRET = "test-secret";
});

afterAll(() => {
  delete process.env.JWT_SECRET;
});

/* ── Helper: make findUnique return an ADMIN user ─────────────── */
function mockAdmin() {
  (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
    id: "user-admin",
    role: "ADMIN",
  });
}

function mockNonAdmin() {
  (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
    id: "user-admin",
    role: "ANALYST",
  });
}

function mockUserNotFound() {
  (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(null);
}

// ═══════════════════════════════════════════════════════════════
// GET /api/admin/overview
// ═══════════════════════════════════════════════════════════════

describe("GET /api/admin/overview", () => {
  it("returns 401 without token", async () => {
    const res = await request(app).get("/api/admin/overview");
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin user", async () => {
    mockNonAdmin();
    const res = await request(app).get("/api/admin/overview").set(AUTH);
    expect(res.status).toBe(403);
    expectErrorResponse(res.body, "Admin access required");
  });

  it("returns 403 when user not found", async () => {
    mockUserNotFound();
    const res = await request(app).get("/api/admin/overview").set(AUTH);
    expect(res.status).toBe(403);
  });

  it("returns platform-wide KPIs", async () => {
    mockAdmin();

    (mockPrisma.user.count as jest.Mock).mockResolvedValueOnce(42);
    (mockPrisma.analyticsEvent.groupBy as jest.Mock).mockResolvedValueOnce(
      // activeUsers7d — 3 distinct users
      [{ userId: "u1" }, { userId: "u2" }, { userId: "u3" }],
    );
    (mockPrisma.analyticsEvent.count as jest.Mock)
      .mockResolvedValueOnce(100) // draftsCreated30d
      .mockResolvedValueOnce(25) // draftsPosted30d
      .mockResolvedValueOnce(8); // imagesGenerated30d
    (mockPrisma.tweetDraft.aggregate as jest.Mock).mockResolvedValueOnce({
      _avg: { actualEngagement: 4.5, predictedEngagement: 3.2 },
    });

    const res = await request(app).get("/api/admin/overview").set(AUTH);
    expect(res.status).toBe(200);

    const data = expectSuccessResponse<any>(res.body);
    expect(data.totalUsers).toBe(42);
    expect(data.activeUsers7d).toBe(3);
    expect(data.draftsCreated30d).toBe(100);
    expect(data.draftsPosted30d).toBe(25);
    expect(data.imagesGenerated30d).toBe(8);
    expect(data.avgActualEngagement30d).toBe(4.5);
    expect(data.avgPredictedEngagement30d).toBe(3.2);
  });

  it("returns null engagement when no posted drafts", async () => {
    mockAdmin();

    (mockPrisma.user.count as jest.Mock).mockResolvedValueOnce(1);
    (mockPrisma.analyticsEvent.groupBy as jest.Mock).mockResolvedValueOnce([]);
    (mockPrisma.analyticsEvent.count as jest.Mock)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);
    (mockPrisma.tweetDraft.aggregate as jest.Mock).mockResolvedValueOnce({
      _avg: { actualEngagement: null, predictedEngagement: null },
    });

    const res = await request(app).get("/api/admin/overview").set(AUTH);
    expect(res.status).toBe(200);

    const data = expectSuccessResponse<any>(res.body);
    expect(data.avgActualEngagement30d).toBeNull();
    expect(data.avgPredictedEngagement30d).toBeNull();
  });

  it("returns 500 on prisma error", async () => {
    mockAdmin();
    (mockPrisma.user.count as jest.Mock).mockRejectedValueOnce(new Error("DB down"));

    const res = await request(app).get("/api/admin/overview").set(AUTH);
    expect(res.status).toBe(500);
    expectErrorResponse(res.body, "Failed to load admin overview");
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /api/admin/roster
// ═══════════════════════════════════════════════════════════════

describe("GET /api/admin/roster", () => {
  it("returns 401 without token", async () => {
    const res = await request(app).get("/api/admin/roster");
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin user", async () => {
    mockNonAdmin();
    const res = await request(app).get("/api/admin/roster").set(AUTH);
    expect(res.status).toBe(403);
    expectErrorResponse(res.body, "Admin access required");
  });

  it("returns user roster with usage stats", async () => {
    mockAdmin();

    const now = new Date();
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: "u1",
        handle: "alice",
        displayName: "Alice",
        role: "ANALYST",
        onboardingTrack: "CRYPTO",
        tourCompleted: true,
        createdAt: now,
        xHandle: "alice_x",
        passwordHash: "should-be-stripped",
        voiceProfile: { maturity: "ADVANCED", tweetsAnalyzed: 50 },
        _count: { tweetDrafts: 20 },
      },
      {
        id: "u2",
        handle: "bob",
        displayName: "Bob",
        role: "MANAGER",
        onboardingTrack: null,
        tourCompleted: false,
        createdAt: now,
        xHandle: null,
        passwordHash: "also-stripped",
        voiceProfile: null,
        _count: { tweetDrafts: 0 },
      },
    ]);
    (mockPrisma.tweetDraft.groupBy as jest.Mock).mockResolvedValueOnce([
      { userId: "u1", _count: { _all: 10 } },
    ]);
    (mockPrisma.analyticsEvent.groupBy as jest.Mock).mockResolvedValueOnce([
      { userId: "u1", _count: { _all: 35 }, _max: { createdAt: now } },
    ]);

    const res = await request(app).get("/api/admin/roster").set(AUTH);
    expect(res.status).toBe(200);

    const data = expectSuccessResponse<any>(res.body);
    expect(data.users).toHaveLength(2);

    const alice = data.users[0];
    expect(alice.id).toBe("u1");
    expect(alice.handle).toBe("alice");
    expect(alice.voiceMaturity).toBe("ADVANCED");
    expect(alice.tweetsAnalyzed).toBe(50);
    expect(alice.totalDrafts).toBe(20);
    expect(alice.totalPosts).toBe(10);
    expect(alice.events30d).toBe(35);
    expect(alice.lastSeen).toBe(now.toISOString());
    // passwordHash must not be in the response
    expect(alice.passwordHash).toBeUndefined();

    const bob = data.users[1];
    expect(bob.voiceMaturity).toBeNull();
    expect(bob.tweetsAnalyzed).toBe(0);
    expect(bob.totalPosts).toBe(0);
    expect(bob.events30d).toBe(0);
    expect(bob.lastSeen).toBeNull();
  });

  it("returns empty roster when no users", async () => {
    mockAdmin();

    (mockPrisma.user.findMany as jest.Mock).mockResolvedValueOnce([]);
    (mockPrisma.tweetDraft.groupBy as jest.Mock).mockResolvedValueOnce([]);
    (mockPrisma.analyticsEvent.groupBy as jest.Mock).mockResolvedValueOnce([]);

    const res = await request(app).get("/api/admin/roster").set(AUTH);
    expect(res.status).toBe(200);
    expect(expectSuccessResponse<any>(res.body).users).toEqual([]);
  });

  it("returns 500 on prisma error", async () => {
    mockAdmin();
    (mockPrisma.user.findMany as jest.Mock).mockRejectedValueOnce(new Error("DB down"));

    const res = await request(app).get("/api/admin/roster").set(AUTH);
    expect(res.status).toBe(500);
    expectErrorResponse(res.body, "Failed to load admin roster");
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /api/admin/pipeline
// ═══════════════════════════════════════════════════════════════

describe("GET /api/admin/pipeline", () => {
  it("returns 401 without token", async () => {
    const res = await request(app).get("/api/admin/pipeline");
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin user", async () => {
    mockNonAdmin();
    const res = await request(app).get("/api/admin/pipeline").set(AUTH);
    expect(res.status).toBe(403);
    expectErrorResponse(res.body, "Admin access required");
  });

  it("returns funnel and sourceTypes with data", async () => {
    mockAdmin();

    (mockPrisma.tweetDraft.groupBy as jest.Mock)
      .mockResolvedValueOnce([
        // status groups
        { status: "DRAFT", _count: { _all: 15 } },
        { status: "POSTED", _count: { _all: 8 } },
        { status: "APPROVED", _count: { _all: 3 } },
      ])
      .mockResolvedValueOnce([
        // source groups
        { sourceType: "REPORT", _count: { _all: 10 } },
        { sourceType: "TWEET", _count: { _all: 5 } },
        { sourceType: null, _count: { _all: 2 } },
      ]);

    const res = await request(app).get("/api/admin/pipeline").set(AUTH);
    expect(res.status).toBe(200);

    const data = expectSuccessResponse<any>(res.body);
    expect(data.funnel).toEqual({
      DRAFT: 15,
      APPROVED: 3,
      SCHEDULED: 0,
      POSTED: 8,
      ARCHIVED: 0,
    });
    expect(data.sourceTypes.REPORT).toBe(10);
    expect(data.sourceTypes.TWEET).toBe(5);
    // null sourceType entries are skipped
    expect(data.sourceTypes.MANUAL).toBe(0);
  });

  it("returns zeroed funnel when no drafts exist", async () => {
    mockAdmin();

    (mockPrisma.tweetDraft.groupBy as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await request(app).get("/api/admin/pipeline").set(AUTH);
    expect(res.status).toBe(200);

    const data = expectSuccessResponse<any>(res.body);
    expect(data.funnel).toEqual({
      DRAFT: 0,
      APPROVED: 0,
      SCHEDULED: 0,
      POSTED: 0,
      ARCHIVED: 0,
    });
    expect(data.sourceTypes).toEqual({
      REPORT: 0,
      ARTICLE: 0,
      TWEET: 0,
      TRENDING_TOPIC: 0,
      VOICE_NOTE: 0,
      MANUAL: 0,
    });
  });

  it("returns 500 on prisma error", async () => {
    mockAdmin();
    (mockPrisma.tweetDraft.groupBy as jest.Mock).mockRejectedValueOnce(
      new Error("DB down"),
    );

    const res = await request(app).get("/api/admin/pipeline").set(AUTH);
    expect(res.status).toBe(500);
    expectErrorResponse(res.body, "Failed to load admin pipeline");
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /api/admin/adoption
// ═══════════════════════════════════════════════════════════════

describe("GET /api/admin/adoption", () => {
  it("returns 401 without token", async () => {
    const res = await request(app).get("/api/admin/adoption");
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin user", async () => {
    mockNonAdmin();
    const res = await request(app).get("/api/admin/adoption").set(AUTH);
    expect(res.status).toBe(403);
    expectErrorResponse(res.body, "Admin access required");
  });

  it("returns feature adoption counts", async () => {
    mockAdmin();

    (mockPrisma.user.count as jest.Mock).mockResolvedValueOnce(50);
    (mockPrisma.voiceProfile.count as jest.Mock).mockResolvedValueOnce(30);
    (mockPrisma.analyticsEvent.groupBy as jest.Mock)
      .mockResolvedValueOnce([{ userId: "u1" }, { userId: "u2" }]) // researchUsed
      .mockResolvedValueOnce([{ userId: "u1" }, { userId: "u3" }, { userId: "u4" }]); // imagesGenerated
    (mockPrisma.alertSubscription.groupBy as jest.Mock).mockResolvedValueOnce([
      { userId: "u1" },
    ]);
    (mockPrisma.briefing.groupBy as jest.Mock).mockResolvedValueOnce([
      { userId: "u1" },
      { userId: "u2" },
      { userId: "u3" },
    ]);
    (mockPrisma.campaign.groupBy as jest.Mock).mockResolvedValueOnce([
      { userId: "u1" },
      { userId: "u2" },
    ]);

    const res = await request(app).get("/api/admin/adoption").set(AUTH);
    expect(res.status).toBe(200);

    const data = expectSuccessResponse<any>(res.body);
    expect(data.totalUsers).toBe(50);
    expect(data.voiceCalibrated).toBe(30);
    expect(data.researchUsed30d).toBe(2);
    expect(data.alertsConfigured).toBe(1);
    expect(data.briefingsGenerated30d).toBe(3);
    expect(data.campaignsCreated).toBe(2);
    expect(data.imagesGenerated30d).toBe(3);
  });

  it("returns zeros when no adoption data", async () => {
    mockAdmin();

    (mockPrisma.user.count as jest.Mock).mockResolvedValueOnce(0);
    (mockPrisma.voiceProfile.count as jest.Mock).mockResolvedValueOnce(0);
    (mockPrisma.analyticsEvent.groupBy as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    (mockPrisma.alertSubscription.groupBy as jest.Mock).mockResolvedValueOnce([]);
    (mockPrisma.briefing.groupBy as jest.Mock).mockResolvedValueOnce([]);
    (mockPrisma.campaign.groupBy as jest.Mock).mockResolvedValueOnce([]);

    const res = await request(app).get("/api/admin/adoption").set(AUTH);
    expect(res.status).toBe(200);

    const data = expectSuccessResponse<any>(res.body);
    expect(data.totalUsers).toBe(0);
    expect(data.voiceCalibrated).toBe(0);
    expect(data.researchUsed30d).toBe(0);
    expect(data.alertsConfigured).toBe(0);
    expect(data.briefingsGenerated30d).toBe(0);
    expect(data.campaignsCreated).toBe(0);
    expect(data.imagesGenerated30d).toBe(0);
  });

  it("returns 500 on prisma error", async () => {
    mockAdmin();
    (mockPrisma.user.count as jest.Mock).mockRejectedValueOnce(new Error("DB down"));

    const res = await request(app).get("/api/admin/adoption").set(AUTH);
    expect(res.status).toBe(500);
    expectErrorResponse(res.body, "Failed to load admin adoption");
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /api/admin/activity-daily
// ═══════════════════════════════════════════════════════════════

describe("GET /api/admin/activity-daily", () => {
  it("returns 401 without token", async () => {
    const res = await request(app).get("/api/admin/activity-daily");
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin user", async () => {
    mockNonAdmin();
    const res = await request(app).get("/api/admin/activity-daily").set(AUTH);
    expect(res.status).toBe(403);
    expectErrorResponse(res.body, "Admin access required");
  });

  it("returns 30 days of activity data with events bucketed", async () => {
    mockAdmin();

    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    (mockPrisma.analyticsEvent.findMany as jest.Mock).mockResolvedValueOnce([
      { type: "DRAFT_CREATED", createdAt: today },
      { type: "DRAFT_CREATED", createdAt: today },
      { type: "DRAFT_POSTED", createdAt: today },
      { type: "DRAFT_CREATED", createdAt: yesterday },
      { type: "DRAFT_POSTED", createdAt: yesterday },
      { type: "DRAFT_POSTED", createdAt: yesterday },
    ]);

    const res = await request(app).get("/api/admin/activity-daily").set(AUTH);
    expect(res.status).toBe(200);

    const data = expectSuccessResponse<any>(res.body);
    expect(data.days).toHaveLength(30);

    // Each day has date, created, posted
    for (const day of data.days) {
      expect(day).toHaveProperty("date");
      expect(day).toHaveProperty("created");
      expect(day).toHaveProperty("posted");
      expect(typeof day.date).toBe("string");
      expect(typeof day.created).toBe("number");
      expect(typeof day.posted).toBe("number");
    }

    // Today's bucket
    const todayKey = today.toISOString().slice(0, 10);
    const todayBucket = data.days.find((d: any) => d.date === todayKey);
    if (todayBucket) {
      expect(todayBucket.created).toBe(2);
      expect(todayBucket.posted).toBe(1);
    }

    // Yesterday's bucket
    const yesterdayKey = yesterday.toISOString().slice(0, 10);
    const yesterdayBucket = data.days.find((d: any) => d.date === yesterdayKey);
    if (yesterdayBucket) {
      expect(yesterdayBucket.created).toBe(1);
      expect(yesterdayBucket.posted).toBe(2);
    }
  });

  it("returns 30 zeroed days when no events exist", async () => {
    mockAdmin();
    (mockPrisma.analyticsEvent.findMany as jest.Mock).mockResolvedValueOnce([]);

    const res = await request(app).get("/api/admin/activity-daily").set(AUTH);
    expect(res.status).toBe(200);

    const data = expectSuccessResponse<any>(res.body);
    expect(data.days).toHaveLength(30);

    for (const day of data.days) {
      expect(day.created).toBe(0);
      expect(day.posted).toBe(0);
    }
  });

  it("days are sorted chronologically", async () => {
    mockAdmin();
    (mockPrisma.analyticsEvent.findMany as jest.Mock).mockResolvedValueOnce([]);

    const res = await request(app).get("/api/admin/activity-daily").set(AUTH);
    expect(res.status).toBe(200);

    const data = expectSuccessResponse<any>(res.body);
    const dates = data.days.map((d: any) => d.date);
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
  });

  it("returns 500 on prisma error", async () => {
    mockAdmin();
    (mockPrisma.analyticsEvent.findMany as jest.Mock).mockRejectedValueOnce(
      new Error("DB down"),
    );

    const res = await request(app).get("/api/admin/activity-daily").set(AUTH);
    expect(res.status).toBe(500);
    expectErrorResponse(res.body, "Failed to load admin activity daily");
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /api/admin/prompts
// ═══════════════════════════════════════════════════════════════

describe("GET /api/admin/prompts", () => {
  it("returns 401 without token", async () => {
    const res = await request(app).get("/api/admin/prompts");
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin user", async () => {
    mockNonAdmin();
    const res = await request(app).get("/api/admin/prompts").set(AUTH);
    expect(res.status).toBe(403);
    expectErrorResponse(res.body, "Admin access required");
  });

  it("returns the prompt catalog", async () => {
    mockAdmin();
    const catalog = [
      { id: "draft-gen", name: "Draft Generation", model: "sonnet" },
      { id: "refine", name: "Refine Draft", model: "haiku" },
    ];
    (getPromptCatalog as jest.Mock).mockReturnValue(catalog);

    const res = await request(app).get("/api/admin/prompts").set(AUTH);
    expect(res.status).toBe(200);

    const data = expectSuccessResponse<any>(res.body);
    expect(data.prompts).toEqual(catalog);
    expect(data.prompts).toHaveLength(2);
  });

  it("returns empty array when no prompts configured", async () => {
    mockAdmin();
    (getPromptCatalog as jest.Mock).mockReturnValue([]);

    const res = await request(app).get("/api/admin/prompts").set(AUTH);
    expect(res.status).toBe(200);

    const data = expectSuccessResponse<any>(res.body);
    expect(data.prompts).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// POST /api/admin/prompts/test
// ═══════════════════════════════════════════════════════════════

describe("POST /api/admin/prompts/test", () => {
  it("returns 401 without token", async () => {
    const res = await request(app)
      .post("/api/admin/prompts/test")
      .send({ promptId: "draft-gen" });
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin user", async () => {
    mockNonAdmin();
    const res = await request(app)
      .post("/api/admin/prompts/test")
      .set(AUTH)
      .send({ promptId: "draft-gen" });
    expect(res.status).toBe(403);
  });

  it("returns 400 for missing promptId", async () => {
    mockAdmin();
    const res = await request(app)
      .post("/api/admin/prompts/test")
      .set(AUTH)
      .send({ variables: {} });
    expect(res.status).toBe(400);
  });

  it("returns 400 for empty promptId", async () => {
    mockAdmin();
    const res = await request(app)
      .post("/api/admin/prompts/test")
      .set(AUTH)
      .send({ promptId: "" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown prompt", async () => {
    mockAdmin();
    (getPromptById as jest.Mock).mockReturnValue(null);

    const res = await request(app)
      .post("/api/admin/prompts/test")
      .set(AUTH)
      .send({ promptId: "nonexistent" });

    expect(res.status).toBe(404);
    expectErrorResponse(res.body, "Unknown promptId: nonexistent");
  });

  it("renders template, calls Anthropic Haiku, returns output", async () => {
    mockAdmin();

    const prompt = {
      id: "draft-gen",
      systemPrompt: "You are a {{tone}} writer.",
      userPromptTemplate: "Write about {{topic}}.",
    };
    (getPromptById as jest.Mock).mockReturnValue(prompt);
    (renderTemplate as jest.Mock)
      .mockReturnValueOnce("You are a casual writer.")
      .mockReturnValueOnce("Write about BTC.");

    const mockCreate = jest.fn().mockResolvedValue({
      content: [{ type: "text", text: "  BTC is the future.  " }],
      usage: { input_tokens: 40, output_tokens: 15 },
    });
    (getAnthropicClient as jest.Mock).mockReturnValue({
      messages: { create: mockCreate },
    });

    const res = await request(app)
      .post("/api/admin/prompts/test")
      .set(AUTH)
      .send({
        promptId: "draft-gen",
        variables: { tone: "casual", topic: "BTC" },
      });

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);
    expect(data.output).toBe("BTC is the future."); // trimmed
    expect(data.tokensUsed).toBe(55);
    expect(typeof data.latencyMs).toBe("number");
    expect(data.latencyMs).toBeGreaterThanOrEqual(0);

    // Verify Haiku model is used for cost efficiency
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        system: "You are a casual writer.",
        messages: [{ role: "user", content: "Write about BTC." }],
      }),
    );
  });

  it("defaults variables to empty object", async () => {
    mockAdmin();

    const prompt = {
      id: "simple",
      systemPrompt: "sys",
      userPromptTemplate: "usr",
    };
    (getPromptById as jest.Mock).mockReturnValue(prompt);
    (renderTemplate as jest.Mock).mockReturnValue("rendered");
    (getAnthropicClient as jest.Mock).mockReturnValue({
      messages: {
        create: jest.fn().mockResolvedValue({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
      },
    });

    const res = await request(app)
      .post("/api/admin/prompts/test")
      .set(AUTH)
      .send({ promptId: "simple" }); // no variables field

    expect(res.status).toBe(200);
  });

  it("returns 502 when Anthropic call fails", async () => {
    mockAdmin();

    const prompt = { id: "p1", systemPrompt: "s", userPromptTemplate: "u" };
    (getPromptById as jest.Mock).mockReturnValue(prompt);
    (renderTemplate as jest.Mock).mockReturnValue("rendered");
    (getAnthropicClient as jest.Mock).mockReturnValue({
      messages: {
        create: jest.fn().mockRejectedValue(new Error("rate limited")),
      },
    });

    const res = await request(app)
      .post("/api/admin/prompts/test")
      .set(AUTH)
      .send({ promptId: "p1" });

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("rate limited");
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /api/admin/feed
// ═══════════════════════════════════════════════════════════════

describe("GET /api/admin/feed", () => {
  it("returns 401 without token", async () => {
    const res = await request(app).get("/api/admin/feed");
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin user", async () => {
    mockNonAdmin();
    const res = await request(app).get("/api/admin/feed").set(AUTH);
    expect(res.status).toBe(403);
    expectErrorResponse(res.body, "Admin access required");
  });

  it("returns recent events with user info", async () => {
    mockAdmin();

    const mockEvents = [
      {
        id: "e1",
        type: "DRAFT_CREATED",
        createdAt: new Date("2026-04-10T14:00:00Z"),
        metadata: { sourceType: "REPORT" },
        user: { handle: "hasu", displayName: "Hasu" },
      },
      {
        id: "e2",
        type: "DRAFT_POSTED",
        createdAt: new Date("2026-04-10T15:30:00Z"),
        metadata: null,
        user: { handle: "cobie", displayName: "Cobie" },
      },
    ];
    (mockPrisma.analyticsEvent.findMany as jest.Mock).mockResolvedValueOnce(
      mockEvents,
    );

    const res = await request(app).get("/api/admin/feed").set(AUTH);
    expect(res.status).toBe(200);

    const data = expectSuccessResponse<any>(res.body);
    expect(data.events).toHaveLength(2);

    expect(data.events[0].id).toBe("e1");
    expect(data.events[0].type).toBe("DRAFT_CREATED");
    expect(data.events[0].handle).toBe("hasu");
    expect(data.events[0].displayName).toBe("Hasu");
    expect(data.events[0].metadata).toEqual({ sourceType: "REPORT" });
    expect(data.events[0].createdAt).toBe("2026-04-10T14:00:00.000Z");

    expect(data.events[1].handle).toBe("cobie");
    expect(data.events[1].metadata).toBeNull();
  });

  it("returns empty array when no events exist", async () => {
    mockAdmin();
    (mockPrisma.analyticsEvent.findMany as jest.Mock).mockResolvedValueOnce([]);

    const res = await request(app).get("/api/admin/feed").set(AUTH);
    expect(res.status).toBe(200);

    const data = expectSuccessResponse<any>(res.body);
    expect(data.events).toEqual([]);
  });

  it("returns 500 on prisma error", async () => {
    mockAdmin();
    (mockPrisma.analyticsEvent.findMany as jest.Mock).mockRejectedValueOnce(
      new Error("DB down"),
    );

    const res = await request(app).get("/api/admin/feed").set(AUTH);
    expect(res.status).toBe(500);
    expectErrorResponse(res.body, "Failed to load admin feed");
  });
});

// ═══════════════════════════════════════════════════════════════
// POST /api/admin/promote
// ═══════════════════════════════════════════════════════════════

describe("POST /api/admin/promote", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 without token", async () => {
    const res = await request(app)
      .post("/api/admin/promote")
      .send({ handle: "alice", role: "MANAGER" });
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin user", async () => {
    mockNonAdmin();
    const res = await request(app)
      .post("/api/admin/promote")
      .set(AUTH)
      .send({ handle: "alice", role: "MANAGER" });
    expect(res.status).toBe(403);
    expectErrorResponse(res.body, "Admin access required");
  });

  it("returns 404 when target user not found", async () => {
    mockAdmin();
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(null);

    const res = await request(app)
      .post("/api/admin/promote")
      .set(AUTH)
      .send({ handle: "unknown", role: "MANAGER" });

    expect(res.status).toBe(404);
    expectErrorResponse(res.body, "User not found");
  });

  it("promotes user and returns updated user", async () => {
    mockAdmin();
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
      id: "user-alice",
      handle: "alice",
    });
    (mockPrisma.user.update as jest.Mock).mockResolvedValueOnce({
      id: "user-alice",
      handle: "alice",
      role: "MANAGER",
    });

    const res = await request(app)
      .post("/api/admin/promote")
      .set(AUTH)
      .send({ handle: "alice", role: "MANAGER" });

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);
    expect(data.handle).toBe("alice");
    expect(data.role).toBe("MANAGER");
    expect(data.id).toBe("user-alice");
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-alice" },
        data: { role: "MANAGER" },
      }),
    );
  });

  it("returns 400 for invalid request body", async () => {
    mockAdmin();
    const res = await request(app)
      .post("/api/admin/promote")
      .set(AUTH)
      .send({ handle: "", role: "MANAGER" });

    expect(res.status).toBe(400);
    expectErrorResponse(res.body, "Invalid request");
  });

  it("returns 500 on prisma error", async () => {
    mockAdmin();
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
      id: "user-alice",
      handle: "alice",
    });
    (mockPrisma.user.update as jest.Mock).mockRejectedValueOnce(new Error("DB down"));

    const res = await request(app)
      .post("/api/admin/promote")
      .set(AUTH)
      .send({ handle: "alice", role: "MANAGER" });

    expect(res.status).toBe(500);
    expectErrorResponse(res.body, "Failed to promote user");
  });
});
