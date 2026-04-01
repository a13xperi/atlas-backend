/**
 * Auth routes test suite
 * Tests POST /register, POST /login, GET /me, GET /sessions, DELETE /sessions/:id
 * Mocks: Prisma, bcryptjs, jsonwebtoken
 */

import request from "supertest";
import express from "express";
import { authRouter } from "../../routes/auth";

jest.mock("../../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    session: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      delete: jest.fn(),
    },
  },
}));

jest.mock("bcryptjs", () => ({
  hash: jest.fn().mockResolvedValue("hashed_password"),
  compare: jest.fn().mockResolvedValue(true),
}));

jest.mock("jsonwebtoken", () => ({
  sign: jest.fn().mockReturnValue("mock_token"),
  verify: jest.fn().mockReturnValue({ userId: "user-123" }),
}));

import { prisma } from "../../lib/prisma";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

const app = express();
app.use(express.json());
app.use("/api/auth", authRouter);

const AUTH = "Bearer mock_token";

const mockVoiceProfile = {
  id: "voice-1",
  userId: "user-123",
  humor: 55,
  formality: 60,
  brevity: 70,
  contrarianTone: 25,
  maturity: "INTERMEDIATE",
};

const mockUser = {
  id: "user-123",
  handle: "atlasanalyst",
  email: "atlas@example.com",
  passwordHash: "hashed_password",
  role: "ANALYST",
  voiceProfile: mockVoiceProfile,
};

const mockSession = {
  id: "session-1",
  userId: "user-123",
  createdAt: new Date("2026-03-01T10:00:00.000Z"),
  expiresAt: new Date("2026-04-15T10:00:00.000Z"),
};

beforeEach(() => {
  jest.clearAllMocks();
  (bcrypt.hash as jest.Mock).mockResolvedValue("hashed_password");
  (bcrypt.compare as jest.Mock).mockResolvedValue(true);
  (jwt.sign as jest.Mock).mockReturnValue("mock_token");
  (jwt.verify as jest.Mock).mockReturnValue({ userId: "user-123" });
});

describe("POST /api/auth/register", () => {
  it("returns user and token on success", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(null);
    (mockPrisma.user.create as jest.Mock).mockResolvedValueOnce(mockUser);

    const res = await request(app)
      .post("/api/auth/register")
      .send({ handle: "atlasanalyst", email: "atlas@example.com", password: "secret123" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: {
        id: "user-123",
        handle: "atlasanalyst",
        role: "ANALYST",
      },
      token: "mock_token",
    });
    expect(mockPrisma.user.create).toHaveBeenCalledWith({
      data: {
        handle: "atlasanalyst",
        email: "atlas@example.com",
        passwordHash: "hashed_password",
        onboardingTrack: undefined,
        voiceProfile: { create: {} },
      },
      include: { voiceProfile: true },
    });
    expect(bcrypt.hash).toHaveBeenCalledWith("secret123", 10);
    expect(jwt.sign).toHaveBeenCalledWith(
      { userId: "user-123" },
      expect.any(String),
      { expiresIn: "30d" }
    );
  });

  it("returns 409 when handle already exists", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(mockUser);

    const res = await request(app)
      .post("/api/auth/register")
      .send({ handle: "atlasanalyst", password: "secret123" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Handle already taken");
  });

  it("returns 400 when handle is missing", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "atlas@example.com", password: "secret123" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Handle is required");
  });
});

describe("POST /api/auth/login", () => {
  it("returns user and token on success", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(mockUser);
    (bcrypt.compare as jest.Mock).mockResolvedValueOnce(true);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ handle: "atlasanalyst", password: "secret123" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: {
        id: "user-123",
        handle: "atlasanalyst",
        role: "ANALYST",
      },
      token: "mock_token",
    });
    expect(bcrypt.compare).toHaveBeenCalledWith("secret123", "hashed_password");
  });

  it("returns 401 for invalid credentials", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(mockUser);
    (bcrypt.compare as jest.Mock).mockResolvedValueOnce(false);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ handle: "atlasanalyst", password: "wrong-password" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid credentials");
  });
});

describe("GET /api/auth/me", () => {
  it("returns user with voice profile when authenticated", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(mockUser);

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      id: "user-123",
      handle: "atlasanalyst",
      role: "ANALYST",
      voiceProfile: mockVoiceProfile,
    });
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "user-123" },
      include: { voiceProfile: true },
    });
  });

  it("returns 401 without token", async () => {
    const res = await request(app).get("/api/auth/me");

    expect(res.status).toBe(401);
  });
});

describe("GET /api/auth/sessions", () => {
  it("lists active sessions for authenticated user", async () => {
    (mockPrisma.session.findMany as jest.Mock).mockResolvedValueOnce([mockSession]);

    const res = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0].id).toBe("session-1");
    expect(mockPrisma.session.findMany).toHaveBeenCalledWith({
      where: {
        userId: "user-123",
        expiresAt: { gt: expect.any(Date) },
      },
      select: { id: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: "desc" },
    });
  });
});

describe("DELETE /api/auth/sessions/:id", () => {
  it("revokes a session for the authenticated user", async () => {
    (mockPrisma.session.findFirst as jest.Mock).mockResolvedValueOnce(mockSession);
    (mockPrisma.session.delete as jest.Mock).mockResolvedValueOnce(mockSession);

    const res = await request(app)
      .delete("/api/auth/sessions/session-1")
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockPrisma.session.findFirst).toHaveBeenCalledWith({
      where: { id: "session-1", userId: "user-123" },
    });
    expect(mockPrisma.session.delete).toHaveBeenCalledWith({
      where: { id: "session-1" },
    });
  });

  it("returns 404 when session is not found", async () => {
    (mockPrisma.session.findFirst as jest.Mock).mockResolvedValueOnce(null);

    const res = await request(app)
      .delete("/api/auth/sessions/missing-session")
      .set("Authorization", AUTH);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Session not found");
  });
});
