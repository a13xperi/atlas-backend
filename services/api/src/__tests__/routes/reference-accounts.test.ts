import request from "supertest";
import express from "express";
import { referenceAccountsRouter } from "../../routes/voice";
import { requestIdMiddleware } from "../../middleware/requestId";
import { expectErrorResponse, expectSuccessResponse } from "../helpers/response";

jest.mock("../../lib/prisma", () => ({
  prisma: {
    referenceVoice: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    referenceVoiceProfile: {
      upsert: jest.fn(),
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
app.use("/api/voice", referenceAccountsRouter);

const seededAccount = {
  id: "ref-1",
  name: "Paul Graham",
  handle: "paulgraham",
  avatarUrl: "https://example.com/paul.jpg",
  category: "Philosophy",
};

const seededProfile = {
  humor: 42,
  formality: 71,
  brevity: 84,
  contrarianTone: 76,
  directness: 68,
  warmth: 44,
  technicalDepth: 51,
  confidence: 83,
  evidenceOrientation: 57,
  solutionOrientation: 62,
  socialPosture: 38,
  selfPromotionalIntensity: 29,
  calibrationConfidence: 0.91,
  analysis: "Crisp, declarative, and idea-driven with a mentor-like tone.",
  tweetsAnalyzed: 18,
  sampleTweets: [
    "Do things that don't scale.",
    "Great work usually comes from curiosity, not obligation.",
  ],
};

describe("GET /api/voice/reference-accounts", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns global seeded accounts with voice profiles", async () => {
    (mockPrisma.referenceVoice.findMany as jest.Mock).mockResolvedValueOnce([
      { ...seededAccount, voiceProfile: seededProfile },
    ]);

    const res = await request(app).get("/api/voice/reference-accounts");

    expect(res.status).toBe(200);
    const body = expectSuccessResponse<{ accounts: Array<Record<string, unknown>> }>(res.body);
    expect(body.accounts).toEqual([
      expect.objectContaining({
        id: "ref-1",
        handle: "paulgraham",
        displayName: "Paul Graham",
        sampleTweets: seededProfile.sampleTweets,
        voiceProfile: expect.objectContaining({
          humor: 42,
          analysis: seededProfile.analysis,
        }),
      }),
    ]);
  });

  it("returns 500 when loading accounts fails", async () => {
    (mockPrisma.referenceVoice.findMany as jest.Mock).mockRejectedValueOnce(new Error("db unavailable"));

    const res = await request(app).get("/api/voice/reference-accounts");

    expect(res.status).toBe(500);
    expectErrorResponse(res.body, "Failed to load reference accounts");
  });
});

describe("POST /api/voice/reference-accounts/seed", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("validates the request body", async () => {
    const res = await request(app)
      .post("/api/voice/reference-accounts/seed")
      .send({});

    expect(res.status).toBe(400);
    const body = expectErrorResponse(res.body, "Invalid request");
    expect(Array.isArray(body.details)).toBe(true);
  });

  it("creates a new seeded reference account and profile", async () => {
    mockFetchTweetsByHandle.mockResolvedValueOnce({
      user: {
        id: "tw-1",
        username: "paulgraham",
        name: "Paul Graham",
        profile_image_url: "https://example.com/paul.jpg",
      },
      tweets: [
        { id: "t1", text: "Do things that don't scale." },
        { id: "t2", text: "Great founders notice what other people ignore." },
      ],
    });
    mockCalibrateFromTweets.mockResolvedValueOnce({
      ...seededProfile,
      tweetsAnalyzed: 2,
    });
    (mockPrisma.referenceVoice.findFirst as jest.Mock).mockResolvedValueOnce(null);
    (mockPrisma.referenceVoice.create as jest.Mock).mockResolvedValueOnce(seededAccount);
    (mockPrisma.referenceVoiceProfile.upsert as jest.Mock).mockResolvedValueOnce({
      ...seededProfile,
      tweetsAnalyzed: 2,
      sampleTweets: [
        "Do things that don't scale.",
        "Great founders notice what other people ignore.",
      ],
    });

    const res = await request(app)
      .post("/api/voice/reference-accounts/seed")
      .send({ handle: "@paulgraham" });

    expect(res.status).toBe(200);
    expect(mockFetchTweetsByHandle).toHaveBeenCalledWith("paulgraham", 30);
    expect(mockCalibrateFromTweets).toHaveBeenCalledWith([
      "Do things that don't scale.",
      "Great founders notice what other people ignore.",
    ]);
    expect(mockPrisma.referenceVoice.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "Paul Graham",
        handle: "paulgraham",
        avatarUrl: "https://example.com/paul.jpg",
        isGlobal: true,
        isActive: true,
      }),
    });
    expect(mockPrisma.referenceVoiceProfile.upsert).toHaveBeenCalledWith({
      where: { referenceVoiceId: "ref-1" },
      update: expect.objectContaining({
        humor: 42,
        tweetsAnalyzed: 2,
        sampleTweets: [
          "Do things that don't scale.",
          "Great founders notice what other people ignore.",
        ],
      }),
      create: expect.objectContaining({
        referenceVoiceId: "ref-1",
        humor: 42,
      }),
    });

    const body = expectSuccessResponse<Record<string, unknown>>(res.body);
    expect(body).toEqual(
      expect.objectContaining({
        id: "ref-1",
        handle: "paulgraham",
        displayName: "Paul Graham",
        sampleTweets: [
          "Do things that don't scale.",
          "Great founders notice what other people ignore.",
        ],
        voiceProfile: expect.objectContaining({
          humor: 42,
          tweetsAnalyzed: 2,
        }),
      }),
    );
  });

  it("updates an existing seeded reference account", async () => {
    mockFetchTweetsByHandle.mockResolvedValueOnce({
      user: {
        id: "tw-1",
        username: "paulgraham",
        name: "Paul Graham",
        profile_image_url: "https://example.com/new-paul.jpg",
      },
      tweets: [{ id: "t1", text: "Build for the future." }],
    });
    mockCalibrateFromTweets.mockResolvedValueOnce({
      ...seededProfile,
      tweetsAnalyzed: 1,
    });
    (mockPrisma.referenceVoice.findFirst as jest.Mock).mockResolvedValueOnce({
      id: "ref-existing",
      handle: "@paulgraham",
    });
    (mockPrisma.referenceVoice.update as jest.Mock).mockResolvedValueOnce({
      ...seededAccount,
      id: "ref-existing",
      avatarUrl: "https://example.com/new-paul.jpg",
    });
    (mockPrisma.referenceVoiceProfile.upsert as jest.Mock).mockResolvedValueOnce({
      ...seededProfile,
      tweetsAnalyzed: 1,
      sampleTweets: ["Build for the future."],
    });

    const res = await request(app)
      .post("/api/voice/reference-accounts/seed")
      .send({ handle: "PaulGraham" });

    expect(res.status).toBe(200);
    expect(mockPrisma.referenceVoice.update).toHaveBeenCalledWith({
      where: { id: "ref-existing" },
      data: expect.objectContaining({
        handle: "paulgraham",
        avatarUrl: "https://example.com/new-paul.jpg",
      }),
    });
  });

  it("returns 400 when no tweets are found", async () => {
    mockFetchTweetsByHandle.mockResolvedValueOnce({
      user: {
        id: "tw-1",
        username: "paulgraham",
        name: "Paul Graham",
      },
      tweets: [],
    });

    const res = await request(app)
      .post("/api/voice/reference-accounts/seed")
      .send({ handle: "paulgraham" });

    expect(res.status).toBe(400);
    expectErrorResponse(res.body, "No tweets found for @paulgraham");
    expect(mockCalibrateFromTweets).not.toHaveBeenCalled();
  });
});
