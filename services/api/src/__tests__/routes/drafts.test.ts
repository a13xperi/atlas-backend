/**
 * Drafts routes test suite
 * Tests: GET /, GET /:id, POST /, PATCH /:id, DELETE /:id, POST /generate, POST /:id/regenerate
 * Mocks: Prisma, pipeline (runGenerationPipeline), JWT
 */

import request from "supertest";
import express from "express";
import { draftsRouter } from "../../routes/drafts";
import { requestIdMiddleware } from "../../middleware/requestId";

// --- Mocks ---

jest.mock("../../middleware/auth", () => ({
  authenticate: jest.fn((req: any, res: any, next: any) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "Missing authorization token" });
    req.userId = "user-123";
    next();
  }),
  AuthRequest: {},
}));

jest.mock("../../lib/supabase", () => ({ supabaseAdmin: null }));

jest.mock("../../lib/prisma", () => ({
  prisma: {
    tweetDraft: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    voiceProfile: {
      findUnique: jest.fn(),
    },
    savedBlend: {
      findFirst: jest.fn(),
    },
    analyticsEvent: {
      create: jest.fn(),
    },
  },
}));

jest.mock("../../lib/pipeline", () => ({
  runGenerationPipeline: jest.fn(),
}));

import { prisma } from "../../lib/prisma";
import { runGenerationPipeline } from "../../lib/pipeline";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockRunPipeline = runGenerationPipeline as jest.Mock;

// --- App setup ---

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/drafts", draftsRouter);

const AUTH = "Bearer mock_token";

const mockDraft = {
  id: "draft-1",
  userId: "user-123",
  content: "Hello crypto world!",
  status: "DRAFT",
  sourceType: "MANUAL",
  sourceContent: null,
  blendId: null,
  feedback: null,
  confidence: 0.8,
  predictedEngagement: 1500,
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockVoiceProfile = {
  id: "vp-1",
  userId: "user-123",
  humor: 50,
  formality: 50,
  brevity: 50,
  contrarianTone: 30,
  maturity: "INTERMEDIATE",
};

// --- GET / ---

beforeAll(() => {
  process.env.JWT_SECRET = "test-secret";
});

afterAll(() => {
  delete process.env.JWT_SECRET;
});

describe("GET /api/drafts", () => {
  it("returns 401 without auth token", async () => {
    const res = await request(app).get("/api/drafts");
    expect(res.status).toBe(401);
  });

  it("returns list of drafts for authenticated user", async () => {
    (mockPrisma.tweetDraft.findMany as jest.Mock).mockResolvedValueOnce([mockDraft]);

    const res = await request(app)
      .get("/api/drafts")
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(res.body.drafts).toHaveLength(1);
    expect(res.body.drafts[0].id).toBe("draft-1");
  });

  it("passes status filter to Prisma", async () => {
    (mockPrisma.tweetDraft.findMany as jest.Mock).mockResolvedValueOnce([]);

    await request(app)
      .get("/api/drafts?status=POSTED")
      .set("Authorization", AUTH);

    expect(mockPrisma.tweetDraft.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "POSTED" }),
      })
    );
  });

  it("uses default pagination (limit=20, offset=0)", async () => {
    (mockPrisma.tweetDraft.findMany as jest.Mock).mockResolvedValueOnce([]);

    await request(app)
      .get("/api/drafts")
      .set("Authorization", AUTH);

    expect(mockPrisma.tweetDraft.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20, skip: 0 })
    );
  });

  it("returns 500 when listing drafts fails", async () => {
    (mockPrisma.tweetDraft.findMany as jest.Mock).mockRejectedValueOnce(new Error("db down"));

    const res = await request(app)
      .get("/api/drafts")
      .set("Authorization", AUTH);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to load drafts");
    expect(res.body.requestId).toBeDefined();
  });
});

describe("GET /api/drafts/team", () => {
  it("uses default pagination for team drafts", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ role: "MANAGER" });
    (mockPrisma.tweetDraft.findMany as jest.Mock).mockResolvedValueOnce([]);

    const res = await request(app)
      .get("/api/drafts/team")
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(mockPrisma.tweetDraft.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50, skip: 0 })
    );
  });
});

// --- GET /:id ---

describe("GET /api/drafts/:id", () => {
  it("returns 404 when draft not found", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(null);

    const res = await request(app)
      .get("/api/drafts/nonexistent")
      .set("Authorization", AUTH);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Draft not found");
  });

  it("returns draft when found", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(mockDraft);

    const res = await request(app)
      .get("/api/drafts/draft-1")
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(res.body.draft.id).toBe("draft-1");
  });

  it("returns 500 when loading a draft fails", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockRejectedValueOnce(new Error("db down"));

    const res = await request(app)
      .get("/api/drafts/draft-1")
      .set("Authorization", AUTH);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to get draft");
    expect(res.body.requestId).toBeDefined();
  });
});

// --- POST / ---

describe("POST /api/drafts", () => {
  it("returns 400 when content is missing", async () => {
    const res = await request(app)
      .post("/api/drafts")
      .set("Authorization", AUTH)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  }, 15000);

  it("creates draft and logs analytics event", async () => {
    (mockPrisma.tweetDraft.create as jest.Mock).mockResolvedValueOnce(mockDraft);
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValueOnce({});

    const res = await request(app)
      .post("/api/drafts")
      .set("Authorization", AUTH)
      .send({ content: "Hello crypto world!", sourceType: "MANUAL" });

    expect(res.status).toBe(200);
    expect(res.body.draft.content).toBe("Hello crypto world!");
    expect(mockPrisma.analyticsEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "DRAFT_CREATED" }),
      })
    );
  });

  it("returns 500 when creating a draft fails", async () => {
    (mockPrisma.tweetDraft.create as jest.Mock).mockRejectedValueOnce(new Error("db down"));

    const res = await request(app)
      .post("/api/drafts")
      .set("Authorization", AUTH)
      .send({ content: "Hello crypto world!" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to create draft");
    expect(res.body.requestId).toBeDefined();
  });
});

// --- PATCH /:id ---

describe("PATCH /api/drafts/:id", () => {
  it("returns 404 when draft not found", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(null);

    const res = await request(app)
      .patch("/api/drafts/nonexistent")
      .set("Authorization", AUTH)
      .send({ content: "updated" });

    expect(res.status).toBe(404);
  });

  it("updates draft content", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(mockDraft);
    const updated = { ...mockDraft, content: "updated content" };
    (mockPrisma.tweetDraft.update as jest.Mock).mockResolvedValueOnce(updated);

    const res = await request(app)
      .patch("/api/drafts/draft-1")
      .set("Authorization", AUTH)
      .send({ content: "updated content" });

    expect(res.status).toBe(200);
    expect(res.body.draft.content).toBe("updated content");
  });

  it("logs FEEDBACK_GIVEN event when feedback is provided", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(mockDraft);
    (mockPrisma.tweetDraft.update as jest.Mock).mockResolvedValueOnce({ ...mockDraft, feedback: "too long" });
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValue({});

    await request(app)
      .patch("/api/drafts/draft-1")
      .set("Authorization", AUTH)
      .send({ feedback: "too long" });

    expect(mockPrisma.analyticsEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "FEEDBACK_GIVEN" }),
      })
    );
  });

  it("logs DRAFT_POSTED event when status is POSTED", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(mockDraft);
    (mockPrisma.tweetDraft.update as jest.Mock).mockResolvedValueOnce({ ...mockDraft, status: "POSTED" });
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValue({});

    await request(app)
      .patch("/api/drafts/draft-1")
      .set("Authorization", AUTH)
      .send({ status: "POSTED" });

    expect(mockPrisma.analyticsEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "DRAFT_POSTED" }),
      })
    );
  });

  it("returns 400 for invalid patch payloads", async () => {
    const res = await request(app)
      .patch("/api/drafts/draft-1")
      .set("Authorization", AUTH)
      .send({ status: "NOT_A_STATUS" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  it("returns 500 when updating a draft fails", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(mockDraft);
    (mockPrisma.tweetDraft.update as jest.Mock).mockRejectedValueOnce(new Error("db down"));

    const res = await request(app)
      .patch("/api/drafts/draft-1")
      .set("Authorization", AUTH)
      .send({ content: "updated content" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to update draft");
    expect(res.body.requestId).toBeDefined();
  });
});

// --- DELETE /:id ---

describe("DELETE /api/drafts/:id", () => {
  it("returns 404 when draft not found", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(null);

    const res = await request(app)
      .delete("/api/drafts/nonexistent")
      .set("Authorization", AUTH);

    expect(res.status).toBe(404);
  });

  it("deletes draft and returns success", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(mockDraft);
    (mockPrisma.tweetDraft.delete as jest.Mock).mockResolvedValueOnce(mockDraft);

    const res = await request(app)
      .delete("/api/drafts/draft-1")
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 500 when deleting a draft fails", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(mockDraft);
    (mockPrisma.tweetDraft.delete as jest.Mock).mockRejectedValueOnce(new Error("db down"));

    const res = await request(app)
      .delete("/api/drafts/draft-1")
      .set("Authorization", AUTH);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to delete draft");
    expect(res.body.requestId).toBeDefined();
  });
});

// --- POST /generate ---

describe("POST /api/drafts/generate", () => {
  it("returns 400 when required fields are missing", async () => {
    const res = await request(app)
      .post("/api/drafts/generate")
      .set("Authorization", AUTH)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  it("returns 400 when voice profile not found", async () => {
    mockRunPipeline.mockRejectedValueOnce(new Error("Voice profile not found. Complete onboarding first."));

    const res = await request(app)
      .post("/api/drafts/generate")
      .set("Authorization", AUTH)
      .send({ sourceContent: "BTC hits ATH", sourceType: "TWEET" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Voice profile not found/);
  });

  it("generates tweet, saves draft, logs analytics event", async () => {
    mockRunPipeline.mockResolvedValueOnce({
      ctx: {
        generatedContent: "BTC just hit ATH!",
        confidence: 0.85,
        predictedEngagement: 2000,
        stepResults: [],
      },
      steps: [],
      totalMs: 500,
    });
    (mockPrisma.tweetDraft.create as jest.Mock).mockResolvedValueOnce({
      ...mockDraft,
      content: "BTC just hit ATH!",
    });
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValueOnce({});

    const res = await request(app)
      .post("/api/drafts/generate")
      .set("Authorization", AUTH)
      .send({ sourceContent: "BTC hits ATH", sourceType: "TWEET" });

    expect(res.status).toBe(200);
    expect(res.body.draft).toBeDefined();
    expect(mockRunPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-123",
        sourceContent: "BTC hits ATH",
        sourceType: "TWEET",
      })
    );
    expect(mockPrisma.analyticsEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "DRAFT_CREATED" }),
      })
    );
  });

  it("returns 502 when AI generation fails", async () => {
    mockRunPipeline.mockRejectedValueOnce(new Error("OpenAI timeout"));

    const res = await request(app)
      .post("/api/drafts/generate")
      .set("Authorization", AUTH)
      .send({ sourceContent: "BTC hits ATH", sourceType: "TWEET" });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("AI generation failed");
  });
});

// --- POST /:id/regenerate ---

describe("POST /api/drafts/:id/regenerate", () => {
  it("returns 404 when original draft not found", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(null);

    const res = await request(app)
      .post("/api/drafts/nonexistent/regenerate")
      .set("Authorization", AUTH)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Draft not found");
  });

  it("returns 400 when original draft has no sourceContent", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce({
      ...mockDraft,
      sourceContent: null,
    });

    const res = await request(app)
      .post("/api/drafts/draft-1/regenerate")
      .set("Authorization", AUTH)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Cannot regenerate a manual draft/);
  });

  it("regenerates with new version number", async () => {
    const existingWithSource = { ...mockDraft, sourceContent: "BTC ATH analysis", version: 1 };
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(existingWithSource);
    mockRunPipeline.mockResolvedValueOnce({
      ctx: {
        generatedContent: "New version!",
        confidence: 0.9,
        predictedEngagement: 2200,
        stepResults: [],
      },
      steps: [],
      totalMs: 400,
    });
    (mockPrisma.tweetDraft.create as jest.Mock).mockResolvedValueOnce({
      ...mockDraft,
      content: "New version!",
      version: 2,
    });
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValue({});

    const res = await request(app)
      .post("/api/drafts/draft-1/regenerate")
      .set("Authorization", AUTH)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.draft.version).toBe(2);
  });

  it("logs FEEDBACK_GIVEN when feedback is provided on regenerate", async () => {
    const existingWithSource = { ...mockDraft, sourceContent: "BTC ATH", version: 1 };
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(existingWithSource);
    mockRunPipeline.mockResolvedValueOnce({
      ctx: {
        generatedContent: "Refined tweet",
        confidence: 0.88,
        predictedEngagement: 1800,
        stepResults: [],
      },
      steps: [],
      totalMs: 300,
    });
    (mockPrisma.tweetDraft.create as jest.Mock).mockResolvedValueOnce({ ...mockDraft, version: 2 });
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValue({});

    await request(app)
      .post("/api/drafts/draft-1/regenerate")
      .set("Authorization", AUTH)
      .send({ feedback: "make it shorter" });

    const feedbackCall = (mockPrisma.analyticsEvent.create as jest.Mock).mock.calls.find(
      (call) => call[0].data.type === "FEEDBACK_GIVEN"
    );
    expect(feedbackCall).toBeDefined();
  });

  it("returns 502 when AI generation fails on regenerate", async () => {
    const existingWithSource = { ...mockDraft, sourceContent: "BTC ATH", version: 1 };
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(existingWithSource);
    mockRunPipeline.mockRejectedValueOnce(new Error("API failure"));

    const res = await request(app)
      .post("/api/drafts/draft-1/regenerate")
      .set("Authorization", AUTH)
      .send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("AI generation failed");
  });
});
