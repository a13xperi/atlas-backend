/**
 * Transcribe route test suite.
 * Tests POST /api/transcribe — voice note → text via OpenAI Whisper.
 */

import request from "supertest";
import express from "express";
import { transcribeRouter } from "../../routes/transcribe";
import { requestIdMiddleware } from "../../middleware/requestId";

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

jest.mock("../../lib/supabase", () => ({ supabaseAdmin: null }));

const mockCreate = jest.fn();
jest.mock("openai", () => {
  return jest.fn().mockImplementation(() => ({
    audio: {
      transcriptions: { create: mockCreate },
    },
  }));
});

jest.mock("../../lib/logger", () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

// Need to mock config to control OPENAI_API_KEY
jest.mock("../../lib/config", () => ({
  config: {
    OPENAI_API_KEY: "sk-test-key",
    RATE_LIMIT_AI_GENERATION_MAX_REQUESTS: 100,
    RATE_LIMIT_AI_GENERATION_WINDOW_MS: 60000,
  },
}));

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/transcribe", transcribeRouter);

const AUTH = { Authorization: "Bearer mock_token" };
const ROUTE = "/api/transcribe";

describe("POST /api/transcribe", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns 401 without auth", async () => {
    const res = await request(app)
      .post(ROUTE)
      .attach("audio", Buffer.from("fake audio"), {
        filename: "note.webm",
        contentType: "audio/webm",
      });
    expect(res.status).toBe(401);
  });

  it("returns 400 when no audio file is attached", async () => {
    const res = await request(app).post(ROUTE).set(AUTH).send();
    expect(res.status).toBe(400);
  });

  it("transcribes audio and returns text", async () => {
    mockCreate.mockResolvedValueOnce({ text: "Bitcoin is going to the moon" });

    const res = await request(app)
      .post(ROUTE)
      .set(AUTH)
      .attach("audio", Buffer.from("fake audio data"), {
        filename: "note.webm",
        contentType: "audio/webm",
      });

    expect(res.status).toBe(200);
    expect(res.body.data.text).toBe("Bitcoin is going to the moon");
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "whisper-1",
        language: "en",
      }),
    );
  });

  it("returns 500 when Whisper API fails", async () => {
    mockCreate.mockRejectedValueOnce(new Error("OpenAI quota exceeded"));

    const res = await request(app)
      .post(ROUTE)
      .set(AUTH)
      .attach("audio", Buffer.from("fake audio"), {
        filename: "note.webm",
        contentType: "audio/webm",
      });

    expect(res.status).toBe(500);
  });

  it("rejects unexpected body fields (strict schema)", async () => {
    const res = await request(app)
      .post(ROUTE)
      .set(AUTH)
      .field("unexpected", "value")
      .attach("audio", Buffer.from("fake audio"), {
        filename: "note.webm",
        contentType: "audio/webm",
      });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/transcribe — OPENAI_API_KEY not set", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Temporarily override config
    const { config } = require("../../lib/config");
    config.OPENAI_API_KEY = "";
  });

  afterEach(() => {
    const { config } = require("../../lib/config");
    config.OPENAI_API_KEY = "sk-test-key";
  });

  it("returns 503 when OPENAI_API_KEY is not configured", async () => {
    const res = await request(app)
      .post(ROUTE)
      .set(AUTH)
      .attach("audio", Buffer.from("fake audio"), {
        filename: "note.webm",
        contentType: "audio/webm",
      });

    expect(res.status).toBe(503);
  });
});
