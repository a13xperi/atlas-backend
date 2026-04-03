/**
 * Auth routes test suite
 * Tests POST /register, POST /login, GET /me, GET /sessions, DELETE /sessions/:id
 * Mocks: Prisma, Supabase admin client, jsonwebtoken
 */

import request from "supertest";
import express from "express";
import { requestIdMiddleware } from "../../middleware/requestId";
import { expectErrorResponse, expectSuccessResponse } from "../helpers/response";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://localhost:5432/atlas_test";
delete process.env.REDIS_URL;

const mockSupabaseAuth = {
  admin: {
    createUser: jest.fn(),
  },
  signInWithPassword: jest.fn(),
  getUser: jest.fn(),
  refreshSession: jest.fn(),
};

jest.mock("../../lib/supabase", () => ({
  supabaseAdmin: {
    auth: mockSupabaseAuth,
  },
}));

jest.mock("../../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    session: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      delete: jest.fn(),
    },
  },
}));

jest.mock("jsonwebtoken", () => ({
  sign: jest.fn().mockReturnValue("mock_token"),
  verify: jest.fn().mockReturnValue({ userId: "user-123" }),
}));

jest.mock("bcryptjs", () => ({
  __esModule: true,
  default: {
    hash: jest.fn().mockResolvedValue("hashed-password"),
    compare: jest.fn().mockResolvedValue(true),
  },
}));

// Must import AFTER mocks
import { authRouter } from "../../routes/auth";
import { prisma } from "../../lib/prisma";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
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
  role: "ANALYST",
  supabaseId: "sb-uuid-123",
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
  // Default: getUser fails so authenticate falls through to JWT path
  mockSupabaseAuth.getUser.mockResolvedValue({ data: { user: null }, error: { message: "invalid" } });
});

describe("POST /api/auth/register", () => {
  it("returns user and token on success", async () => {
    (mockPrisma.user.findUnique as jest.Mock)
      .mockResolvedValueOnce(null)   // handle check
      .mockResolvedValueOnce(null);  // email check
    mockSupabaseAuth.admin.createUser.mockResolvedValueOnce({
      data: { user: { id: "sb-uuid-123" } },
      error: null,
    });
    (mockPrisma.user.create as jest.Mock).mockResolvedValueOnce(mockUser);
    mockSupabaseAuth.signInWithPassword.mockResolvedValueOnce({
      data: {
        session: { access_token: "sb-token", refresh_token: "sb-refresh" },
        user: { id: "sb-uuid-123" },
      },
      error: null,
    });

    const res = await request(app)
      .post("/api/auth/register")
      .send({ handle: "atlasanalyst", email: "atlas@example.com", password: "secret123" });

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);
    expect(data.user.handle).toBe("atlasanalyst");
    expect(data.token).toBe("sb-token");
    expect(data.refresh_token).toBe("sb-refresh");
  }, 15000);

  it("returns 409 when handle already exists", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(mockUser);

    const res = await request(app)
      .post("/api/auth/register")
      .send({ handle: "atlasanalyst", email: "atlas@example.com", password: "secret123" });

    expect(res.status).toBe(409);
    expectErrorResponse(res.body, "Handle already taken");
  });

  it("returns 400 when handle is missing", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "atlas@example.com", password: "secret123" });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/login", () => {
  it("returns user and token on success", async () => {
    mockSupabaseAuth.signInWithPassword.mockResolvedValueOnce({
      data: {
        session: { access_token: "sb-token", refresh_token: "sb-refresh" },
        user: { id: "sb-uuid-123" },
      },
      error: null,
    });
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValueOnce(mockUser);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "atlas@example.com", password: "secret123" });

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);
    expect(data.user.handle).toBe("atlasanalyst");
    expect(data.token).toBe("sb-token");
  });

  it("returns 401 for invalid credentials", async () => {
    mockSupabaseAuth.signInWithPassword.mockResolvedValueOnce({
      data: { session: null },
      error: { message: "Invalid login credentials" },
    });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "atlas@example.com", password: "wrong-password" });

    expect(res.status).toBe(401);
    expectErrorResponse(res.body, "Invalid credentials");
  });
});

describe("POST /api/auth/refresh", () => {
  it("returns 400 for an invalid refresh payload", async () => {
    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refresh_token: 123 });

    expect(res.status).toBe(400);
    const body = expectErrorResponse(res.body, "Invalid request");
    expect(Array.isArray(body.details)).toBe(true);
  });
});

describe("GET /api/auth/me", () => {
  it("returns user with voice profile when authenticated", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(mockUser);

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<any>(res.body);
    expect(data.user.handle).toBe("atlasanalyst");
    expect(data.user.voiceProfile).toBeDefined();
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
    const data = expectSuccessResponse<any>(res.body);
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].id).toBe("session-1");
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
    expect(expectSuccessResponse<any>(res.body)).toEqual({ success: true });
  });

  it("returns 404 when session is not found", async () => {
    (mockPrisma.session.findFirst as jest.Mock).mockResolvedValueOnce(null);

    const res = await request(app)
      .delete("/api/auth/sessions/missing-session")
      .set("Authorization", AUTH);

    expect(res.status).toBe(404);
  });
});
