/**
 * Zod validation suite for routes/admin-flags.ts — atlas-backend #3937.
 *
 * The PATCH /:key handler used to type-check `enabled` + `rolloutRole`
 * by hand, which accepted an empty body (quietly upserting defaults)
 * and rejected malformed payloads with bare messages instead of
 * structured details. This suite locks in the new `flagPatchSchema`
 * contract:
 *
 *   - strict object: unknown keys rejected
 *   - at least one of enabled/rolloutRole required
 *   - rolloutRole must be one of everyone|managers|admins
 *   - enabled must be a real boolean (no "true" strings)
 *   - happy path still upserts and returns the flag
 *
 * The authenticate middleware is stubbed so we can drive `req.userId`
 * via a header and flip between admin / non-admin users by returning
 * different prisma.user.findUnique fixtures.
 */

import request from "supertest";
import express from "express";
import adminFlagsRouter from "../../routes/admin-flags";
import { requestIdMiddleware } from "../../middleware/requestId";
import { expectSuccessResponse } from "../helpers/response";

jest.mock("../../middleware/auth", () => ({
  authenticate: jest.fn((req: any, res: any, next: any) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing authorization token" });
    }
    req.userId = "admin-user";
    next();
  }),
  AuthRequest: {},
}));

jest.mock("../../lib/supabase", () => ({ supabaseAdmin: null }));

jest.mock("../../lib/prisma", () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    featureFlag: { upsert: jest.fn(), findMany: jest.fn(), createMany: jest.fn() },
  },
}));

jest.mock("../../lib/logger", () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { prisma } from "../../lib/prisma";
const mockPrisma = prisma as jest.Mocked<typeof prisma>;

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/admin/feature-flags", adminFlagsRouter);

const AUTH = { Authorization: "Bearer mock_admin_token" };

function mockAsAdmin() {
  (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
    id: "admin-user",
    role: "ADMIN",
  });
}

function mockAsAnalyst() {
  (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
    id: "admin-user",
    role: "ANALYST",
  });
}

const fakeFlag = {
  key: "crafting_station",
  enabled: true,
  rolloutRole: "managers",
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("PATCH /api/admin/feature-flags/:key — admin gate", () => {
  it("returns 401 without auth header", async () => {
    const res = await request(app)
      .patch("/api/admin/feature-flags/crafting_station")
      .send({ enabled: false });
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin callers", async () => {
    mockAsAnalyst();
    const res = await request(app)
      .patch("/api/admin/feature-flags/crafting_station")
      .set(AUTH)
      .send({ enabled: false });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Admin access required/i);
    expect(mockPrisma.featureFlag.upsert).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/admin/feature-flags/:key — zod validation (#3937)", () => {
  beforeEach(() => {
    mockAsAdmin();
  });

  it("returns 400 when the body is empty (no enabled or rolloutRole)", async () => {
    const res = await request(app)
      .patch("/api/admin/feature-flags/crafting_station")
      .set(AUTH)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
    expect(res.body.details).toBeDefined();
    expect(mockPrisma.featureFlag.upsert).not.toHaveBeenCalled();
  });

  it("returns 400 when rolloutRole is not one of the allowed values", async () => {
    const res = await request(app)
      .patch("/api/admin/feature-flags/crafting_station")
      .set(AUTH)
      .send({ rolloutRole: "nobody" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
    expect(mockPrisma.featureFlag.upsert).not.toHaveBeenCalled();
  });

  it("returns 400 when enabled is a string, not a boolean", async () => {
    const res = await request(app)
      .patch("/api/admin/feature-flags/crafting_station")
      .set(AUTH)
      .send({ enabled: "true" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
    expect(mockPrisma.featureFlag.upsert).not.toHaveBeenCalled();
  });

  it("returns 400 when the body has an unknown key (strict schema)", async () => {
    const res = await request(app)
      .patch("/api/admin/feature-flags/crafting_station")
      .set(AUTH)
      .send({ enabled: false, description: "should be rejected" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
    expect(mockPrisma.featureFlag.upsert).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/admin/feature-flags/:key — happy path", () => {
  beforeEach(() => {
    mockAsAdmin();
  });

  it("upserts the flag when only enabled is provided", async () => {
    (mockPrisma.featureFlag.upsert as jest.Mock).mockResolvedValueOnce({
      ...fakeFlag,
      enabled: false,
    });

    const res = await request(app)
      .patch("/api/admin/feature-flags/crafting_station")
      .set(AUTH)
      .send({ enabled: false });

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<{ flag: typeof fakeFlag }>(res.body);
    expect(data.flag.enabled).toBe(false);
    expect(mockPrisma.featureFlag.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "crafting_station" },
        update: { enabled: false },
      }),
    );
  });

  it("upserts the flag when only rolloutRole is provided", async () => {
    (mockPrisma.featureFlag.upsert as jest.Mock).mockResolvedValueOnce({
      ...fakeFlag,
      rolloutRole: "admins",
    });

    const res = await request(app)
      .patch("/api/admin/feature-flags/crafting_station")
      .set(AUTH)
      .send({ rolloutRole: "admins" });

    expect(res.status).toBe(200);
    const data = expectSuccessResponse<{ flag: typeof fakeFlag }>(res.body);
    expect(data.flag.rolloutRole).toBe("admins");
    expect(mockPrisma.featureFlag.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "crafting_station" },
        update: { rolloutRole: "admins" },
      }),
    );
  });

  it("accepts both fields in a single call", async () => {
    (mockPrisma.featureFlag.upsert as jest.Mock).mockResolvedValueOnce({
      key: "arena",
      enabled: false,
      rolloutRole: "everyone",
    });

    const res = await request(app)
      .patch("/api/admin/feature-flags/arena")
      .set(AUTH)
      .send({ enabled: false, rolloutRole: "everyone" });

    expect(res.status).toBe(200);
    expect(mockPrisma.featureFlag.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "arena" },
        update: { enabled: false, rolloutRole: "everyone" },
      }),
    );
  });

  it("passes defaults to the create branch of upsert", async () => {
    (mockPrisma.featureFlag.upsert as jest.Mock).mockResolvedValueOnce({
      key: "new_flag",
      enabled: true,
      rolloutRole: "everyone",
    });

    await request(app)
      .patch("/api/admin/feature-flags/new_flag")
      .set(AUTH)
      .send({ enabled: true });

    expect(mockPrisma.featureFlag.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { key: "new_flag", enabled: true, rolloutRole: "everyone" },
      }),
    );
  });

  it("returns 500 when the upsert throws", async () => {
    (mockPrisma.featureFlag.upsert as jest.Mock).mockRejectedValueOnce(new Error("db down"));

    const res = await request(app)
      .patch("/api/admin/feature-flags/crafting_station")
      .set(AUTH)
      .send({ enabled: false });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to update feature flag");
  });
});
