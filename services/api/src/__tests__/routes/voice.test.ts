/**
 * Voice routes test suite
 * Tests GET/PATCH /profile, GET/POST /references, GET/POST /blends
 * Mocks: Prisma, jsonwebtoken
 */

import request from "supertest";
import express from "express";
import { voiceRouter } from "../../routes/voice";
import { requestIdMiddleware } from "../../middleware/requestId";

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
      update: jest.fn(),
    },
    referenceVoice: {
      findMany: jest.fn(),
      create: jest.fn(),
    },
    savedBlend: {
      findMany: jest.fn(),
      create: jest.fn(),
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

  it("returns 404 when profile not found", async () => {
    (mockPrisma.voiceProfile.findUnique as jest.Mock).mockResolvedValueOnce(null);
    const res = await request(app).get("/api/voice/profile").set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Voice profile not found");
  });

  it("returns voice profile", async () => {
    (mockPrisma.voiceProfile.findUnique as jest.Mock).mockResolvedValueOnce(mockProfile);
    const res = await request(app).get("/api/voice/profile").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.profile.humor).toBe(50);
  });
});

describe("PATCH /api/voice/profile", () => {
  it("returns 401 without token", async () => {
    const res = await request(app).patch("/api/voice/profile").send({ humor: 80 });
    expect(res.status).toBe(401);
  });

  it("updates voice dimensions", async () => {
    const updated = { ...mockProfile, humor: 80 };
    (mockPrisma.voiceProfile.update as jest.Mock).mockResolvedValueOnce(updated);

    const res = await request(app).patch("/api/voice/profile").set(AUTH).send({ humor: 80 });
    expect(res.status).toBe(200);
    expect(res.body.profile.humor).toBe(80);
  });
});

describe("GET /api/voice/references", () => {
  it("returns list of reference voices", async () => {
    const voices = [{ id: "rv-1", name: "Balaji", handle: "@balajis" }];
    (mockPrisma.referenceVoice.findMany as jest.Mock).mockResolvedValueOnce(voices);

    const res = await request(app).get("/api/voice/references").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.voices).toHaveLength(1);
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
    expect(res.body.error).toBe("Failed to load reference voices");
    expect(res.body.message).toBe("db down");
  });
});

describe("POST /api/voice/references", () => {
  it("returns 400 when name is missing", async () => {
    const res = await request(app)
      .post("/api/voice/references")
      .set(AUTH)
      .send({ handle: "@someone" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Name is required");
  });

  it("creates reference voice", async () => {
    const voice = { id: "rv-2", name: "Vitalik", handle: "@VitalikButerin" };
    (mockPrisma.referenceVoice.create as jest.Mock).mockResolvedValueOnce(voice);

    const res = await request(app)
      .post("/api/voice/references")
      .set(AUTH)
      .send({ name: "Vitalik", handle: "@VitalikButerin" });

    expect(res.status).toBe(200);
    expect(res.body.voice.name).toBe("Vitalik");
  });
});

describe("GET /api/voice/blends", () => {
  it("returns list of saved blends", async () => {
    const blends = [{ id: "b-1", name: "Tech Blend", voices: [] }];
    (mockPrisma.savedBlend.findMany as jest.Mock).mockResolvedValueOnce(blends);

    const res = await request(app).get("/api/voice/blends").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.blends).toHaveLength(1);
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
    expect(res.body.error).toBe("Failed to load blends");
    expect(res.body.message).toBe("db down");
  });
});

describe("POST /api/voice/blends", () => {
  it("returns 400 when name or voices missing", async () => {
    const res = await request(app).post("/api/voice/blends").set(AUTH).send({ name: "Blend" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Name and voices required");
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
    expect(res.body.blend.name).toBe("My Blend");
  });
});
