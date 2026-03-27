/**
 * Auth routes test suite
 * Tests POST /register, POST /login, GET /me
 * Mocks: Prisma, bcryptjs, jsonwebtoken
 */

import request from "supertest";
import express from "express";
import { authRouter } from "../routes/auth";

// Mock Prisma
jest.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
  },
}));

// Mock bcryptjs
jest.mock("bcryptjs", () => ({
  hash: jest.fn().mockResolvedValue("hashed_password"),
  compare: jest.fn().mockResolvedValue(true),
}));

// Mock jsonwebtoken
jest.mock("jsonwebtoken", () => ({
  sign: jest.fn().mockReturnValue("mock_token"),
  verify: jest.fn().mockReturnValue({ userId: "user-123" }),
}));

import { prisma } from "../lib/prisma";
import bcrypt from "bcryptjs";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockBcrypt = bcrypt as jest.Mocked<typeof bcrypt>;

const app = express();
app.use(express.json());
app.use("/api/auth", authRouter);

const mockUser = {
  id: "user-123",
  handle: "testuser",
  email: "test@example.com",
  passwordHash: "hashed_password",
  role: "ANALYST",
  voiceProfile: null,
};

describe("POST /api/auth/register", () => {
  it("returns 400 when handle is missing", async () => {
    const res = await request(app).post("/api/auth/register").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Handle is required");
  });

  it("returns 409 when handle is already taken", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(mockUser);
    const res = await request(app).post("/api/auth/register").send({ handle: "testuser" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Handle already taken");
  });

  it("creates user and returns token when handle is available", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(null);
    (mockPrisma.user.create as jest.Mock).mockResolvedValueOnce(mockUser);

    const res = await request(app)
      .post("/api/auth/register")
      .send({ handle: "newuser", password: "secret" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBe("mock_token");
    expect(res.body.user.handle).toBe("testuser");
  });

  it("hashes password when provided", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(null);
    (mockPrisma.user.create as jest.Mock).mockResolvedValueOnce(mockUser);

    await request(app)
      .post("/api/auth/register")
      .send({ handle: "newuser", password: "secret" });

    expect(mockBcrypt.hash).toHaveBeenCalledWith("secret", 10);
  });

  it("skips password hash when no password provided", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(null);
    (mockPrisma.user.create as jest.Mock).mockResolvedValueOnce(mockUser);

    await request(app)
      .post("/api/auth/register")
      .send({ handle: "newuser" });

    // bcrypt.hash should NOT have been called (no password)
    expect(mockBcrypt.hash).not.toHaveBeenCalled();
  });

  it("returns 500 on Prisma error", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockRejectedValueOnce(new Error("DB error"));

    const res = await request(app).post("/api/auth/register").send({ handle: "newuser" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Registration failed");
  });
});

describe("POST /api/auth/login", () => {
  it("returns 401 when user not found", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(null);
    const res = await request(app).post("/api/auth/login").send({ handle: "nobody" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid credentials");
  });

  it("returns 401 when password is wrong", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(mockUser);
    (mockBcrypt.compare as jest.Mock).mockResolvedValueOnce(false);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ handle: "testuser", password: "wrongpassword" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid credentials");
  });

  it("returns token when credentials are valid", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(mockUser);
    (mockBcrypt.compare as jest.Mock).mockResolvedValueOnce(true);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ handle: "testuser", password: "secret" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBe("mock_token");
    expect(res.body.user.id).toBe("user-123");
  });

  it("skips password check when user has no passwordHash", async () => {
    const noPasswordUser = { ...mockUser, passwordHash: null };
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(noPasswordUser);

    const res = await request(app).post("/api/auth/login").send({ handle: "testuser" });
    expect(res.status).toBe(200);
    expect(res.body.token).toBe("mock_token");
  });

  it("returns 500 on Prisma error", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockRejectedValueOnce(new Error("DB error"));

    const res = await request(app).post("/api/auth/login").send({ handle: "testuser" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Login failed");
  });
});

describe("GET /api/auth/me", () => {
  const validToken = "Bearer mock_token";

  it("returns 401 when no token provided", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("returns 404 when user not found", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(null);

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", validToken);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("User not found");
  });

  it("returns user with voiceProfile when authenticated", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
      ...mockUser,
      voiceProfile: { humor: 5, formality: 5 },
    });

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", validToken);

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe("user-123");
    expect(res.body.user.voiceProfile).toBeDefined();
  });

  it("returns 500 on Prisma error", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockRejectedValueOnce(new Error("DB error"));

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", validToken);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to get user");
  });
});
