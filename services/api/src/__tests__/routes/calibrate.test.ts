import request from "supertest";
import express from "express";
import { voiceRouter } from "../../routes/voice";
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
    voiceProfile: {
      upsert: jest.fn(),
    },
    analyticsEvent: {
      create: jest.fn(),
    },
  },
}));

jest.mock("../../lib/twitter", () => ({
  fetchTweetsByHandle: jest.fn(),
}));

jest.mock("../../lib/calibrate", () => ({
  calibrateFromTweets: jest.fn(),
}));

import { prisma } from "../../lib/prisma";
import { fetchTweetsByHandle } from "../../lib/twitter";
import { calibrateFromTweets } from "../../lib/calibrate";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockFetchTweetsByHandle = fetchTweetsByHandle as jest.MockedFunction<typeof fetchTweetsByHandle>;
const mockCalibrateFromTweets = calibrateFromTweets as jest.MockedFunction<typeof calibrateFromTweets>;

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/voice", voiceRouter);

const AUTH = { Authorization: "Bearer mock_token" };

const twitterUser = {
  id: "twitter-user-1",
  username: "atlasanalyst",
  name: "Atlas Analyst",
};

function makeTweets(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `tweet-${index + 1}`,
    text: `Tweet ${index + 1} about markets and crypto structure`,
  }));
}

function makeCalibration(overrides: Partial<Awaited<ReturnType<typeof calibrateFromTweets>>> = {}) {
  return {
    humor: 61,
    formality: 48,
    brevity: 73,
    contrarianTone: 57,
    directness: 7.1,
    warmth: 4.6,
    technicalDepth: 8.2,
    confidence: 8.7,
    evidenceOrientation: 8.4,
    solutionOrientation: 6.3,
    socialPosture: 5.2,
    selfPromotionalIntensity: 3.1,
    calibrationConfidence: 0.89,
    analysis: "Measured, technical, and concise with a mildly contrarian edge.",
    tweetsAnalyzed: 12,
    ...overrides,
  };
}

function makeProfile(
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "vp-1",
    userId: "user-123",
    humor: 61,
    formality: 48,
    brevity: 73,
    contrarianTone: 57,
    directness: 7.1,
    warmth: 4.6,
    technicalDepth: 8.2,
    confidence: 8.7,
    evidenceOrientation: 8.4,
    solutionOrientation: 6.3,
    socialPosture: 5.2,
    selfPromotionalIntensity: 3.1,
    tweetsAnalyzed: 12,
    maturity: "BEGINNER",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

function buildDimensionData(calibration: ReturnType<typeof makeCalibration>) {
  return {
    humor: calibration.humor,
    formality: calibration.formality,
    brevity: calibration.brevity,
    contrarianTone: calibration.contrarianTone,
    directness: calibration.directness,
    warmth: calibration.warmth,
    technicalDepth: calibration.technicalDepth,
    confidence: calibration.confidence,
    evidenceOrientation: calibration.evidenceOrientation,
    solutionOrientation: calibration.solutionOrientation,
    socialPosture: calibration.socialPosture,
    selfPromotionalIntensity: calibration.selfPromotionalIntensity,
    tweetsAnalyzed: calibration.tweetsAnalyzed,
    maturity: calibration.tweetsAnalyzed >= 100 ? "ADVANCED"
      : calibration.tweetsAnalyzed >= 20 ? "INTERMEDIATE"
      : "BEGINNER",
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValue({ id: "event-1" });
});

describe("POST /api/voice/calibrate", () => {
  it("returns 401 without auth token", async () => {
    const res = await request(app)
      .post("/api/voice/calibrate")
      .send({ handle: "atlasanalyst" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Missing authorization token");
  });

  it("returns 400 when handle is missing", async () => {
    const res = await request(app)
      .post("/api/voice/calibrate")
      .set(AUTH)
      .send({});

    expect(res.status).toBe(400);
    const body = expectErrorResponse(res.body, "Invalid request");
    expect(Array.isArray(body.details)).toBe(true);
    expect(mockFetchTweetsByHandle).not.toHaveBeenCalled();
  });

  it("returns 400 when handle is empty string", async () => {
    const res = await request(app)
      .post("/api/voice/calibrate")
      .set(AUTH)
      .send({ handle: "" });

    expect(res.status).toBe(400);
    const body = expectErrorResponse(res.body, "Invalid request");
    expect(Array.isArray(body.details)).toBe(true);
    expect(mockFetchTweetsByHandle).not.toHaveBeenCalled();
  });

  it("returns 400 when no tweets found", async () => {
    mockFetchTweetsByHandle.mockResolvedValueOnce({
      user: twitterUser,
      tweets: [],
    });

    const res = await request(app)
      .post("/api/voice/calibrate")
      .set(AUTH)
      .send({ handle: "atlasanalyst" });

    expect(res.status).toBe(400);
    expectErrorResponse(res.body, "No tweets found for @atlasanalyst");
    expect(mockCalibrateFromTweets).not.toHaveBeenCalled();
    expect(mockPrisma.voiceProfile.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.analyticsEvent.create).not.toHaveBeenCalled();
  });

  it("calibrates successfully with mocked tweets and returns correct shape", async () => {
    const tweets = makeTweets(12);
    const calibration = makeCalibration({ tweetsAnalyzed: tweets.length, calibrationConfidence: 0.93 });
    const dimensionData = buildDimensionData(calibration);
    const profile = makeProfile(dimensionData);

    mockFetchTweetsByHandle.mockResolvedValueOnce({ user: twitterUser, tweets });
    mockCalibrateFromTweets.mockResolvedValueOnce(calibration);
    (mockPrisma.voiceProfile.upsert as jest.Mock).mockResolvedValueOnce(profile);

    const res = await request(app)
      .post("/api/voice/calibrate")
      .set(AUTH)
      .send({ handle: "atlasanalyst" });

    expect(res.status).toBe(200);
    expect(mockFetchTweetsByHandle).toHaveBeenCalledWith("atlasanalyst");
    expect(mockCalibrateFromTweets).toHaveBeenCalledWith(tweets.map((tweet) => tweet.text));
    expect(mockPrisma.voiceProfile.upsert).toHaveBeenCalledWith({
      where: { userId: "user-123" },
      update: dimensionData,
      create: { userId: "user-123", ...dimensionData },
    });

    const body = expectSuccessResponse<{
      profile: typeof profile;
      calibration: {
        confidence: number;
        analysis: string;
        tweetsAnalyzed: number;
        twitterUser: { username: string; name: string };
      };
    }>(res.body);

    expect(body.profile).toEqual({
      ...profile,
      createdAt: profile.createdAt.toISOString(),
      updatedAt: profile.updatedAt.toISOString(),
    });
    expect(body.calibration).toEqual({
      confidence: calibration.calibrationConfidence,
      analysis: calibration.analysis,
      tweetsAnalyzed: calibration.tweetsAnalyzed,
      twitterUser: {
        username: twitterUser.username,
        name: twitterUser.name,
      },
    });
  });

  it("sets maturity to BEGINNER when tweetsAnalyzed is below 20", async () => {
    const tweets = makeTweets(19);
    const calibration = makeCalibration({ tweetsAnalyzed: tweets.length });
    const dimensionData = buildDimensionData(calibration);

    mockFetchTweetsByHandle.mockResolvedValueOnce({ user: twitterUser, tweets });
    mockCalibrateFromTweets.mockResolvedValueOnce(calibration);
    (mockPrisma.voiceProfile.upsert as jest.Mock).mockResolvedValueOnce(
      makeProfile(dimensionData),
    );

    const res = await request(app)
      .post("/api/voice/calibrate")
      .set(AUTH)
      .send({ handle: "atlasanalyst" });

    expect(res.status).toBe(200);
    expect((mockPrisma.voiceProfile.upsert as jest.Mock).mock.calls[0][0].update.maturity).toBe("BEGINNER");
    expect(expectSuccessResponse<any>(res.body).profile.maturity).toBe("BEGINNER");
  });

  it("sets maturity to INTERMEDIATE when tweetsAnalyzed is at least 20", async () => {
    const tweets = makeTweets(20);
    const calibration = makeCalibration({ tweetsAnalyzed: tweets.length });
    const dimensionData = buildDimensionData(calibration);

    mockFetchTweetsByHandle.mockResolvedValueOnce({ user: twitterUser, tweets });
    mockCalibrateFromTweets.mockResolvedValueOnce(calibration);
    (mockPrisma.voiceProfile.upsert as jest.Mock).mockResolvedValueOnce(
      makeProfile(dimensionData),
    );

    const res = await request(app)
      .post("/api/voice/calibrate")
      .set(AUTH)
      .send({ handle: "atlasanalyst" });

    expect(res.status).toBe(200);
    expect((mockPrisma.voiceProfile.upsert as jest.Mock).mock.calls[0][0].update.maturity).toBe("INTERMEDIATE");
    expect(expectSuccessResponse<any>(res.body).profile.maturity).toBe("INTERMEDIATE");
  });

  it("sets maturity to ADVANCED when tweetsAnalyzed is at least 100", async () => {
    const tweets = makeTweets(100);
    const calibration = makeCalibration({ tweetsAnalyzed: tweets.length });
    const dimensionData = buildDimensionData(calibration);

    mockFetchTweetsByHandle.mockResolvedValueOnce({ user: twitterUser, tweets });
    mockCalibrateFromTweets.mockResolvedValueOnce(calibration);
    (mockPrisma.voiceProfile.upsert as jest.Mock).mockResolvedValueOnce(
      makeProfile(dimensionData),
    );

    const res = await request(app)
      .post("/api/voice/calibrate")
      .set(AUTH)
      .send({ handle: "atlasanalyst" });

    expect(res.status).toBe(200);
    expect((mockPrisma.voiceProfile.upsert as jest.Mock).mock.calls[0][0].update.maturity).toBe("ADVANCED");
    expect(expectSuccessResponse<any>(res.body).profile.maturity).toBe("ADVANCED");
  });

  it("logs VOICE_REFINEMENT analytics event", async () => {
    const tweets = makeTweets(12);
    const calibration = makeCalibration({ tweetsAnalyzed: tweets.length });

    mockFetchTweetsByHandle.mockResolvedValueOnce({ user: twitterUser, tweets });
    mockCalibrateFromTweets.mockResolvedValueOnce(calibration);
    (mockPrisma.voiceProfile.upsert as jest.Mock).mockResolvedValueOnce(
      makeProfile(buildDimensionData(calibration)),
    );

    const res = await request(app)
      .post("/api/voice/calibrate")
      .set(AUTH)
      .send({ handle: "atlasanalyst" });

    expect(res.status).toBe(200);
    expect(mockPrisma.analyticsEvent.create).toHaveBeenCalledWith({
      data: { userId: "user-123", type: "VOICE_REFINEMENT" },
    });
  });

  it("returns 502 when Twitter fetch fails", async () => {
    mockFetchTweetsByHandle.mockRejectedValueOnce(new Error("twitter unavailable"));

    const res = await request(app)
      .post("/api/voice/calibrate")
      .set(AUTH)
      .send({ handle: "atlasanalyst" });

    expect(res.status).toBe(502);
    expectErrorResponse(res.body, "Voice calibration failed: twitter unavailable");
    expect(mockCalibrateFromTweets).not.toHaveBeenCalled();
    expect(mockPrisma.voiceProfile.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.analyticsEvent.create).not.toHaveBeenCalled();
  });

  it("returns 502 when calibration fails", async () => {
    const tweets = makeTweets(12);

    mockFetchTweetsByHandle.mockResolvedValueOnce({ user: twitterUser, tweets });
    mockCalibrateFromTweets.mockRejectedValueOnce(new Error("model unavailable"));

    const res = await request(app)
      .post("/api/voice/calibrate")
      .set(AUTH)
      .send({ handle: "atlasanalyst" });

    expect(res.status).toBe(502);
    expectErrorResponse(res.body, "Voice calibration failed: model unavailable");
    expect(mockPrisma.voiceProfile.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.analyticsEvent.create).not.toHaveBeenCalled();
  });
});
