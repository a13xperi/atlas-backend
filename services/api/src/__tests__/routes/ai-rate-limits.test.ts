/**
 * Integration test for the AI generation per-user rate limiter.
 *
 * #88075 — closes the demo-blocker gap where /api/research, /api/oracle,
 * /api/campaigns/generate-from-pdf, /api/transcribe, and /api/images all
 * called paid LLM/transcription APIs without a per-user cap. The general
 * /api limiter is too loose for these (60-100/min); a single demo account
 * could burn the project's monthly Anthropic / OpenAI / Gemini budget in
 * minutes.
 *
 * The cap reuses `RATE_LIMIT_AI_GENERATION_MAX_REQUESTS` (already used by
 * drafts.ts), so this test pins the wiring at the router level: third
 * request from the same user must 429, fourth from a different user must
 * still pass. Coverage on the limiter mechanics themselves lives in
 * middleware/rateLimit.test.ts — this test only proves the middleware is
 * present on the route.
 */

import request from "supertest";
import express from "express";
import { requestIdMiddleware } from "../../middleware/requestId";
import { clearRateLimitStore } from "../../middleware/rateLimiter";
import { expectSuccessResponse } from "../helpers/response";

// Mock auth so the test can pin a deterministic userId per request via the
// Authorization header. Mirrors the pattern in routes/paperclip.test.ts.
jest.mock("../../middleware/auth", () => ({
  authenticate: jest.fn((req: any, res: any, next: any) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing authorization token" });
    }
    req.userId = header.slice("Bearer ".length);
    next();
  }),
  AuthRequest: {},
}));

// Tight cap so the test can prove the limiter trips without sending 20+
// requests. The router reads config at import time, so this mock must
// land before the route module is required.
jest.mock("../../lib/config", () => ({
  config: {
    NODE_ENV: "test",
    RATE_LIMIT_AI_GENERATION_MAX_REQUESTS: 2,
    RATE_LIMIT_AI_GENERATION_WINDOW_MS: 60_000,
  },
}));

// Stub the research backend so handler logic is hermetic — the limiter is
// what we're exercising, not the Anthropic call path.
jest.mock("../../lib/research", () => ({
  conductResearch: jest.fn().mockResolvedValue({
    summary: "stubbed",
    keyFacts: [],
    sentiment: "neutral",
    relatedTopics: [],
    sources: [],
    confidence: 0.5,
  }),
}));

jest.mock("../../lib/twitter", () => ({
  fetchTweetsByHandle: jest.fn(),
}));

jest.mock("../../lib/calibrate", () => ({
  calibrateFromTweets: jest.fn(),
}));

jest.mock("../../lib/prisma", () => ({
  prisma: {
    researchResult: {
      create: jest.fn().mockResolvedValue({ id: "research-1" }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    analyticsEvent: {
      create: jest.fn().mockResolvedValue({ id: "event-1" }),
    },
    voiceProfile: {
      upsert: jest.fn(),
    },
    user: {
      update: jest.fn(),
    },
  },
}));

import { researchRouter } from "../../routes/research";
import { voiceRouter } from "../../routes/voice";
import { prisma } from "../../lib/prisma";
import { fetchTweetsByHandle } from "../../lib/twitter";
import { calibrateFromTweets } from "../../lib/calibrate";

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/research", researchRouter);
app.use("/api/voice", voiceRouter);

const RESEARCH_BODY = { query: "what is the price of bitcoin" };
const CALIBRATE_BODY = { handle: "atlasanalyst" };

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockFetchTweetsByHandle = fetchTweetsByHandle as jest.MockedFunction<typeof fetchTweetsByHandle>;
const mockCalibrateFromTweets = calibrateFromTweets as jest.MockedFunction<typeof calibrateFromTweets>;

beforeEach(() => {
  jest.clearAllMocks();
  // Memory store is module-level — reset between tests so a previous
  // test's burst doesn't leak into the next one.
  clearRateLimitStore();
  mockFetchTweetsByHandle.mockResolvedValue({
    user: { id: "twitter-user-1", username: "atlasanalyst", name: "Atlas Analyst" },
    tweets: [{ id: "tweet-1", text: "BTC structure still matters." }],
    stats: { pool: 1, topN: 0, recentN: 1 },
  });
  mockCalibrateFromTweets.mockResolvedValue({
    humor: 55,
    formality: 50,
    brevity: 70,
    contrarianTone: 60,
    directness: 60,
    warmth: 45,
    technicalDepth: 80,
    confidence: 75,
    evidenceOrientation: 82,
    solutionOrientation: 63,
    socialPosture: 52,
    selfPromotionalIntensity: 31,
    calibrationConfidence: 0.91,
    analysis: "Stubbed calibration",
    tweetsAnalyzed: 1,
  });
  (mockPrisma.voiceProfile.upsert as jest.Mock).mockResolvedValue({
    id: "vp-1",
    userId: "user-alpha",
    humor: 55,
    formality: 50,
    brevity: 70,
    contrarianTone: 60,
    directness: 60,
    warmth: 45,
    technicalDepth: 80,
    confidence: 75,
    evidenceOrientation: 82,
    solutionOrientation: 63,
    socialPosture: 52,
    selfPromotionalIntensity: 31,
    tweetsAnalyzed: 1,
    analysis: "Stubbed calibration",
    maturity: "BEGINNER",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  (mockPrisma.user.update as jest.Mock).mockResolvedValue({
    id: "user-alpha",
    xAvatarUrl: null,
  });
});

describe("POST /api/research — AI generation rate limit (#88075)", () => {
  it("allows requests up to the configured limit and 429s the next one", async () => {
    const headers = { Authorization: "Bearer user-alpha" };

    const first = await request(app).post("/api/research").set(headers).send(RESEARCH_BODY);
    const second = await request(app).post("/api/research").set(headers).send(RESEARCH_BODY);
    const third = await request(app).post("/api/research").set(headers).send(RESEARCH_BODY);

    expect(first.status).toBe(200);
    expectSuccessResponse(first.body);
    expect(first.headers["x-ratelimit-limit"]).toBe("2");
    expect(first.headers["x-ratelimit-remaining"]).toBe("1");

    expect(second.status).toBe(200);
    expect(second.headers["x-ratelimit-remaining"]).toBe("0");

    expect(third.status).toBe(429);
    expect(third.body.error).toBe("Too many requests. Please try again later.");
    expect(third.headers["retry-after"]).toEqual(expect.any(String));
  });

  it("buckets independently per authenticated user", async () => {
    // Burn user-alpha's quota first.
    await request(app)
      .post("/api/research")
      .set("Authorization", "Bearer user-alpha")
      .send(RESEARCH_BODY);
    await request(app)
      .post("/api/research")
      .set("Authorization", "Bearer user-alpha")
      .send(RESEARCH_BODY);
    const alphaBlocked = await request(app)
      .post("/api/research")
      .set("Authorization", "Bearer user-alpha")
      .send(RESEARCH_BODY);
    expect(alphaBlocked.status).toBe(429);

    // user-beta starts with a fresh quota — proves the limiter buckets by
    // userId, not a shared global counter that would punish unrelated users.
    const betaFresh = await request(app)
      .post("/api/research")
      .set("Authorization", "Bearer user-beta")
      .send(RESEARCH_BODY);
    expect(betaFresh.status).toBe(200);
    expect(betaFresh.headers["x-ratelimit-remaining"]).toBe("1");
  });

  it("does not consume quota for unauthenticated requests (auth runs first)", async () => {
    // No Authorization header → auth middleware should reject with 401
    // before the limiter sees the request, so we don't burn the IP bucket.
    const res = await request(app).post("/api/research").send(RESEARCH_BODY);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/voice/calibrate — AI generation rate limit (#203)", () => {
  it("uses the shared AI limiter on calibration requests", async () => {
    const headers = { Authorization: "Bearer user-alpha" };

    const first = await request(app).post("/api/voice/calibrate").set(headers).send(CALIBRATE_BODY);
    const second = await request(app).post("/api/voice/calibrate").set(headers).send(CALIBRATE_BODY);
    const third = await request(app).post("/api/voice/calibrate").set(headers).send(CALIBRATE_BODY);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(third.body.error).toBe("Too many requests. Please try again later.");
  });
});
