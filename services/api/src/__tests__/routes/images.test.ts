/**
 * Images routes test suite
 * Tests POST /generate, POST /generate-for-draft, GET /for-draft/:draftId
 * Mocks: Prisma, generateVisualConcept, jsonwebtoken
 */

import request from "supertest";
import express from "express";
import { imagesRouter } from "../../routes/images";
import { requestIdMiddleware } from "../../middleware/requestId";
import { expectErrorResponse, expectSuccessResponse } from "../helpers/response";

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
    generatedImage: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
    tweetDraft: {
      findFirst: jest.fn(),
    },
    analyticsEvent: {
      create: jest.fn(),
    },
  },
}));

jest.mock("../../lib/gemini", () => ({
  generateVisualConcept: jest.fn(),
}));

import { prisma } from "../../lib/prisma";
import { generateVisualConcept } from "../../lib/gemini";
const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockGenerateVisualConcept = generateVisualConcept as jest.Mock;

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/images", imagesRouter);

const AUTH = { Authorization: "Bearer mock_token" };

const mockConcept = {
  description: "A bold crypto-themed graphic",
  colorScheme: ["#F7931A", "#FFFFFF"],
  layout: "centered",
};

const mockImage = {
  id: "img-1",
  userId: "user-123",
  prompt: "BTC is mooning",
  style: "quote_card",
  imageUrl: JSON.stringify(mockConcept),
  mimeType: "application/json",
};

beforeAll(() => {
  process.env.JWT_SECRET = "test-secret";
});

afterAll(() => {
  delete process.env.JWT_SECRET;
});

describe("POST /api/images/generate", () => {
  it("returns 401 without token", async () => {
    const res = await request(app).post("/api/images/generate").send({ prompt: "test" });
    expect(res.status).toBe(401);
  });

  it("returns 400 for missing prompt", async () => {
    const res = await request(app).post("/api/images/generate").set(AUTH).send({});
    expect(res.status).toBe(400);
    expectErrorResponse(res.body, "Invalid request");
  });

  it("generates image concept and returns it", async () => {
    mockGenerateVisualConcept.mockResolvedValueOnce(mockConcept);
    (mockPrisma.generatedImage.create as jest.Mock).mockResolvedValueOnce(mockImage);
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValueOnce({});

    const res = await request(app)
      .post("/api/images/generate")
      .set(AUTH)
      .send({ prompt: "BTC is mooning", style: "quote_card" });

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);
    expect(data.image.id).toBe("img-1");
    expect(data.image.concept).toEqual(mockConcept);
  });

  it("returns 502 when AI generation fails", async () => {
    mockGenerateVisualConcept.mockRejectedValueOnce(new Error("Gemini error"));

    const res = await request(app)
      .post("/api/images/generate")
      .set(AUTH)
      .send({ prompt: "BTC is mooning" });

    expect(res.status).toBe(502);
    expectErrorResponse(res.body, "Image generation failed");
  });
});

describe("POST /api/images/generate-for-draft", () => {
  it("returns 400 for missing draftId", async () => {
    const res = await request(app)
      .post("/api/images/generate-for-draft")
      .set(AUTH)
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 when draft not found", async () => {
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(null);

    const res = await request(app)
      .post("/api/images/generate-for-draft")
      .set(AUTH)
      .send({ draftId: "nonexistent" });

    expect(res.status).toBe(404);
    expectErrorResponse(res.body, "Draft not found");
  });

  it("generates image for a draft", async () => {
    const draft = { id: "draft-1", content: "BTC is mooning", userId: "user-123" };
    (mockPrisma.tweetDraft.findFirst as jest.Mock).mockResolvedValueOnce(draft);
    mockGenerateVisualConcept.mockResolvedValueOnce(mockConcept);
    const img = { ...mockImage, draftId: "draft-1" };
    (mockPrisma.generatedImage.create as jest.Mock).mockResolvedValueOnce(img);
    (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValueOnce({});

    const res = await request(app)
      .post("/api/images/generate-for-draft")
      .set(AUTH)
      .send({ draftId: "draft-1" });

    expect(res.status).toBe(200);
    expect(expectSuccessResponse<any>(res.body).image.concept).toEqual(mockConcept);
  });
});

describe("GET /api/images/for-draft/:draftId", () => {
  it("returns 401 without token", async () => {
    const res = await request(app).get("/api/images/for-draft/draft-1");
    expect(res.status).toBe(401);
  });

  it("returns images for a draft", async () => {
    (mockPrisma.generatedImage.findMany as jest.Mock).mockResolvedValueOnce([mockImage]);

    const res = await request(app).get("/api/images/for-draft/draft-1").set(AUTH);
    expect(res.status).toBe(200);
    expect(expectSuccessResponse<any>(res.body).images).toHaveLength(1);
  });

  it("returns 500 when loading images fails", async () => {
    (mockPrisma.generatedImage.findMany as jest.Mock).mockRejectedValueOnce(new Error("db down"));

    const res = await request(app).get("/api/images/for-draft/draft-1").set(AUTH);

    expect(res.status).toBe(500);
    expect(expectErrorResponse(res.body, "Failed to load images").details.message).toBe("db down");
  });

  it("returns 500 when loading images fails", async () => {
    (mockPrisma.generatedImage.findMany as jest.Mock).mockRejectedValueOnce(new Error("db down"));

    const res = await request(app).get("/api/images/for-draft/draft-1").set(AUTH);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to load images");
    expect(res.body.ok).toBe(false);
  });
});
