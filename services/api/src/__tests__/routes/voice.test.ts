/**
 * Voice routes test suite
 * Tests GET/PATCH /profile, GET/POST /references, GET/POST /blends
 * Mocks: Prisma, jsonwebtoken
 */

import request from "supertest";
import express from "express";
import { voiceRouter } from "../../routes/voice";
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
    voiceProfile: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      upsert: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    referenceVoice: {
      findMany: jest.fn(),
      create: jest.fn(),
    },
    savedBlend: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    blendVoice: {
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  },
}));

import { prisma } from "../../lib/prisma";
const mockPrisma = prisma as jest.Mocked<typeof prisma>;

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/voice", voiceRouter);

const AUTH = { Authorization: "Bearer mock_token" };

const mockProfile = {
  id: "vp-1",
  userId: "user-123",
  humor: 50,
  formality: 50,
  brevity: 50,
  contrarianTone: 30,
  directness: 5,
  warmth: 5,
  technicalDepth: 5,
  confidence: 5,
  evidenceOrientation: 5,
  solutionOrientation: 5,
  socialPosture: 5,
  selfPromotionalIntensity: 5,
  maturity: "INTERMEDIATE",
};

beforeAll(() => {
  process.env.JWT_SECRET = "test-secret";
});

afterAll(() => {
  delete process.env.JWT_SECRET;
});

describe("GET /api/voice/profile", () => {
  it("returns 401 without token", async () => {
    const res = await request(app).get("/api/voice/profile");
    expect(res.status).toBe(401);
  });

  it("returns 404 for new user without profile", async () => {
    (mockPrisma.voiceProfile.findUnique as jest.Mock).mockResolvedValueOnce(null);
    const res = await request(app).get("/api/voice/profile").set(AUTH);
    expect(res.status).toBe(404);
  });

  it("returns voice profile", async () => {
    (mockPrisma.voiceProfile.findUnique as jest.Mock).mockResolvedValueOnce(mockProfile);
    const res = await request(app).get("/api/voice/profile").set(AUTH);
    expect(res.status).toBe(200);
    expect(expectSuccessResponse<any>(res.body).profile.humor).toBe(50);
    expect(expectSuccessResponse<any>(res.body).profile.directness).toBe(5);
  });
});

describe("GET /api/voice/profiles", () => {
  it("returns the current voice profile with all 12 dimensions", async () => {
    (mockPrisma.voiceProfile.findUnique as jest.Mock).mockResolvedValueOnce(mockProfile);

    const res = await request(app).get("/api/voice/profiles").set(AUTH);

    expect(res.status).toBe(200);
    const profile = expectSuccessResponse<any>(res.body).profile;
    expect(profile.humor).toBe(50);
    expect(profile.selfPromotionalIntensity).toBe(5);
  });
});

describe("POST /api/voice/profiles", () => {
  it("returns 401 without token", async () => {
    const res = await request(app).post("/api/voice/profiles").send({ humor: 80 });
    expect(res.status).toBe(401);
  });

  it("upserts voice dimensions and keeps new fields optional", async () => {
    const saved = { ...mockProfile, humor: 80, directness: 7.5 };
    (mockPrisma.voiceProfile.upsert as jest.Mock).mockResolvedValueOnce(saved);

    const res = await request(app)
      .post("/api/voice/profiles")
      .set(AUTH)
      .send({ humor: 80, directness: 7.5 });

    expect(res.status).toBe(200);
    expect(expectSuccessResponse<any>(res.body).profile.humor).toBe(80);
    expect(expectSuccessResponse<any>(res.body).profile.directness).toBe(7.5);
    expect(mockPrisma.voiceProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-123" },
        update: { humor: 80, directness: 7.5 },
        create: expect.objectContaining({ userId: "user-123", humor: 80, directness: 7.5 }),
      })
    );
  });
});

describe("PATCH /api/voice/profile", () => {
  it("returns 401 without token", async () => {
    const res = await request(app).patch("/api/voice/profile").send({ humor: 80 });
    expect(res.status).toBe(401);
  });

  it("updates voice dimensions", async () => {
    const updated = { ...mockProfile, humor: 80, warmth: 7 };
    (mockPrisma.voiceProfile.update as jest.Mock).mockResolvedValueOnce(updated);

    const res = await request(app)
      .patch("/api/voice/profile")
      .set(AUTH)
      .send({ humor: 80, warmth: 7 });

    expect(res.status).toBe(200);
    expect(expectSuccessResponse<any>(res.body).profile.humor).toBe(80);
    expect(expectSuccessResponse<any>(res.body).profile.warmth).toBe(7);
  });
});

describe("GET /api/voice/references", () => {
  it("returns list of reference voices", async () => {
    const voices = [{ id: "rv-1", name: "Balaji", handle: "@balajis" }];
    (mockPrisma.referenceVoice.findMany as jest.Mock).mockResolvedValueOnce(voices);

    const res = await request(app).get("/api/voice/references").set(AUTH);
    expect(res.status).toBe(200);
    expect(expectSuccessResponse<any>(res.body).voices).toHaveLength(1);
    expect(mockPrisma.referenceVoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-123", isActive: true },
        take: 20,
        skip: 0,
      })
    );
  });

  it("applies pagination to reference voices", async () => {
    (mockPrisma.referenceVoice.findMany as jest.Mock).mockResolvedValueOnce([]);

    await request(app).get("/api/voice/references?limit=5&offset=2").set(AUTH);

    expect(mockPrisma.referenceVoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-123", isActive: true },
        take: 5,
        skip: 2,
      })
    );
  });

  it("returns 500 when loading reference voices fails", async () => {
    (mockPrisma.referenceVoice.findMany as jest.Mock).mockRejectedValueOnce(new Error("db down"));

    const res = await request(app).get("/api/voice/references").set(AUTH);

    expect(res.status).toBe(500);
    expect(expectErrorResponse(res.body, "Failed to load reference voices").details.message).toBe("db down");
  });
});

describe("POST /api/voice/references", () => {
  it("returns 400 when name is missing", async () => {
    const res = await request(app)
      .post("/api/voice/references")
      .set(AUTH)
      .send({ handle: "@someone" });
    expect(res.status).toBe(400);
    expectErrorResponse(res.body, "Name is required");
  });

  it("creates reference voice", async () => {
    const voice = { id: "rv-2", name: "Vitalik", handle: "@VitalikButerin" };
    (mockPrisma.referenceVoice.create as jest.Mock).mockResolvedValueOnce(voice);

    const res = await request(app)
      .post("/api/voice/references")
      .set(AUTH)
      .send({ name: "Vitalik", handle: "@VitalikButerin" });

    expect(res.status).toBe(200);
    expect(expectSuccessResponse<any>(res.body).voice.name).toBe("Vitalik");
  });
});

describe("GET /api/voice/blends", () => {
  it("returns list of saved blends", async () => {
    const blends = [{ id: "b-1", name: "Tech Blend", voices: [] }];
    (mockPrisma.savedBlend.findMany as jest.Mock).mockResolvedValueOnce(blends);

    const res = await request(app).get("/api/voice/blends").set(AUTH);
    expect(res.status).toBe(200);
    expect(expectSuccessResponse<any>(res.body).blends).toHaveLength(1);
    expect(mockPrisma.savedBlend.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-123" },
        take: 20,
        skip: 0,
      })
    );
  });

  it("applies pagination to saved blends", async () => {
    (mockPrisma.savedBlend.findMany as jest.Mock).mockResolvedValueOnce([]);

    await request(app).get("/api/voice/blends?limit=5&offset=2").set(AUTH);

    expect(mockPrisma.savedBlend.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-123" },
        take: 5,
        skip: 2,
      })
    );
  });

  it("returns 500 when loading blends fails", async () => {
    (mockPrisma.savedBlend.findMany as jest.Mock).mockRejectedValueOnce(new Error("db down"));

    const res = await request(app).get("/api/voice/blends").set(AUTH);

    expect(res.status).toBe(500);
    expect(expectErrorResponse(res.body, "Failed to load blends").details.message).toBe("db down");
  });
});

describe("POST /api/voice/blends", () => {
  it("returns 400 when name or voices missing", async () => {
    const res = await request(app).post("/api/voice/blends").set(AUTH).send({ name: "Blend" });
    expect(res.status).toBe(400);
    const body = expectErrorResponse(res.body, "Invalid request");
    expect(Array.isArray(body.details)).toBe(true);
  });

  it("creates a blend", async () => {
    const blend = {
      id: "b-2",
      name: "My Blend",
      voices: [{ label: "Balaji", percentage: 60 }],
    };
    (mockPrisma.savedBlend.create as jest.Mock).mockResolvedValueOnce(blend);

    const res = await request(app)
      .post("/api/voice/blends")
      .set(AUTH)
      .send({ name: "My Blend", voices: [{ label: "Balaji", percentage: 60 }] });

    expect(res.status).toBe(200);
    expect(expectSuccessResponse<any>(res.body).blend.name).toBe("My Blend");
  });
});

describe("PATCH /api/voice/blends/:id", () => {
  it("returns 400 for an invalid blend rename payload", async () => {
    const res = await request(app).patch("/api/voice/blends/blend-1").set(AUTH).send({});

    expect(res.status).toBe(400);
    const body = expectErrorResponse(res.body, "Invalid request");
    expect(Array.isArray(body.details)).toBe(true);
  });

  it("returns 404 when the blend is not owned by the user", async () => {
    (mockPrisma.savedBlend.findFirst as jest.Mock).mockResolvedValueOnce(null);

    const res = await request(app)
      .patch("/api/voice/blends/blend-404")
      .set(AUTH)
      .send({ name: "Renamed Blend" });

    expect(res.status).toBe(404);
    expectErrorResponse(res.body, "Blend not found");
  });

  it("renames a saved blend", async () => {
    const existingBlend = { id: "blend-1", userId: "user-123", name: "Old Blend" };
    const updatedBlend = {
      id: "blend-1",
      userId: "user-123",
      name: "Renamed Blend",
      voices: [],
    };

    (mockPrisma.savedBlend.findFirst as jest.Mock).mockResolvedValueOnce(existingBlend);
    (mockPrisma.savedBlend.update as jest.Mock).mockResolvedValueOnce(updatedBlend);

    const res = await request(app)
      .patch("/api/voice/blends/blend-1")
      .set(AUTH)
      .send({ name: "Renamed Blend" });

    expect(res.status).toBe(200);
    expect(expectSuccessResponse<any>(res.body).blend.name).toBe("Renamed Blend");
    expect(mockPrisma.savedBlend.update).toHaveBeenCalledWith({
      where: { id: "blend-1" },
      data: { name: "Renamed Blend" },
      include: { voices: { include: { referenceVoice: true } } },
    });
  });
});

describe("DELETE /api/voice/blends/:id", () => {
  it("returns 404 when the blend is not owned by the user", async () => {
    (mockPrisma.savedBlend.findFirst as jest.Mock).mockResolvedValueOnce(null);

    const res = await request(app).delete("/api/voice/blends/blend-404").set(AUTH);

    expect(res.status).toBe(404);
    expectErrorResponse(res.body, "Blend not found");
  });

  it("deletes a saved blend", async () => {
    const existingBlend = { id: "blend-1", userId: "user-123", name: "Delete Me" };

    (mockPrisma.savedBlend.findFirst as jest.Mock).mockResolvedValueOnce(existingBlend);
    (mockPrisma.savedBlend.delete as jest.Mock).mockResolvedValueOnce(existingBlend);

    const res = await request(app).delete("/api/voice/blends/blend-1").set(AUTH);

    expect(res.status).toBe(200);
    expect(expectSuccessResponse<any>(res.body).success).toBe(true);
    expect(mockPrisma.savedBlend.delete).toHaveBeenCalledWith({
      where: { id: "blend-1" },
    });
  });
});

describe("PATCH /api/voice/blends/:blendId/voices/:voiceId", () => {
  it("returns 400 for an invalid blend voice update payload", async () => {
    const res = await request(app)
      .patch("/api/voice/blends/blend-1/voices/voice-1")
      .set(AUTH)
      .send({ percentage: 101 });

    expect(res.status).toBe(400);
    const body = expectErrorResponse(res.body, "Invalid request");
    expect(Array.isArray(body.details)).toBe(true);
  });
});

describe("PATCH /api/voice/profiles/:id", () => {
  it("returns 404 when the profile does not belong to the user", async () => {
    (mockPrisma.voiceProfile.findFirst as jest.Mock).mockResolvedValueOnce(null);

    const res = await request(app)
      .patch("/api/voice/profiles/vp-404")
      .set(AUTH)
      .send({ confidence: 9 });

    expect(res.status).toBe(404);
    expectErrorResponse(res.body, "Voice profile not found");
  });

  it("accepts partial updates across the expanded dimensions", async () => {
    const updated = { ...mockProfile, confidence: 8.5, evidenceOrientation: 9 };
    (mockPrisma.voiceProfile.findFirst as jest.Mock).mockResolvedValueOnce(mockProfile);
    (mockPrisma.voiceProfile.update as jest.Mock).mockResolvedValueOnce(updated);

    const res = await request(app)
      .patch("/api/voice/profiles/vp-1")
      .set(AUTH)
      .send({ confidence: 8.5, evidenceOrientation: 9 });

    expect(res.status).toBe(200);
    expect(expectSuccessResponse<any>(res.body).profile.confidence).toBe(8.5);
    expect(mockPrisma.voiceProfile.update).toHaveBeenCalledWith({
      where: { id: "vp-1" },
      data: { confidence: 8.5, evidenceOrientation: 9 },
    });
  });
});
