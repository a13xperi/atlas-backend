/**
 * Auth middleware test suite
 * Tests JWT verification and req.userId injection
 * With supabaseAdmin=null, authenticate uses legacy JWT path only
 */

import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

jest.mock("../lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("../lib/prisma", () => ({
  prisma: { user: { findUnique: jest.fn(), update: jest.fn() } },
}));
jest.mock("../lib/config", () => ({
  config: {
    JWT_SECRET: "test-secret",
    NODE_ENV: "test",
  },
}));

jest.mock("jsonwebtoken", () => ({
  verify: jest.fn(),
}));

const isJtiRevokedMock = jest.fn();
jest.mock("../lib/jwt-revocation", () => ({
  isJtiRevoked: (...args: unknown[]) => isJtiRevokedMock(...args),
  revokeJti: jest.fn(),
  remainingTtlSeconds: jest.fn(),
}));

// Import after mocks
import { authenticate, AuthRequest } from "../middleware/auth";
import { config } from "../lib/config";

const mockJwt = jwt as jest.Mocked<typeof jwt>;
const mockConfig = config as { JWT_SECRET: string };

function makeReq(authHeader?: string): AuthRequest {
  return {
    headers: { authorization: authHeader },
  } as unknown as AuthRequest;
}

function makeRes() {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as Response;
}

describe("authenticate middleware", () => {
  let next: jest.Mock;

  beforeEach(() => {
    next = jest.fn();
    mockConfig.JWT_SECRET = "test-secret";
    isJtiRevokedMock.mockReset();
    isJtiRevokedMock.mockResolvedValue(false);
  });

  it("returns 401 when Authorization header is missing", async () => {
    const req = makeReq();
    const res = makeRes();
    await authenticate(req, res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
    expect((res.json as jest.Mock).mock.calls[0][0].error).toBe("Missing authorization token");
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header does not start with Bearer", async () => {
    const req = makeReq("Basic abc123");
    const res = makeRes();
    await authenticate(req, res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when JWT verification fails", async () => {
    const req = makeReq("Bearer invalid_token");
    const res = makeRes();
    (mockJwt.verify as jest.Mock).mockImplementationOnce(() => {
      throw new Error("invalid token");
    });
    await authenticate(req, res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
    expect((res.json as jest.Mock).mock.calls[0][0].error).toBe("Invalid or expired token");
    expect(next).not.toHaveBeenCalled();
  });

  it("sets req.userId and calls next when token is valid", async () => {
    const req = makeReq("Bearer valid_token");
    const res = makeRes();
    (mockJwt.verify as jest.Mock).mockReturnValueOnce({ userId: "user-abc" });
    await authenticate(req, res, next as NextFunction);
    expect(req.userId).toBe("user-abc");
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("verifies token against config.JWT_SECRET", async () => {
    mockConfig.JWT_SECRET = "my-test-secret";
    const req = makeReq("Bearer valid_token");
    const res = makeRes();
    (mockJwt.verify as jest.Mock).mockReturnValueOnce({ userId: "user-xyz" });
    await authenticate(req, res, next as NextFunction);
    expect(mockJwt.verify).toHaveBeenCalledWith("valid_token", "my-test-secret");
  });

  it("returns 401 when JWT_SECRET is empty", async () => {
    mockConfig.JWT_SECRET = "";
    const req = makeReq("Bearer valid_token");
    const res = makeRes();
    await authenticate(req, res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  // ── C-6: jti revocation ──────────────────────────────────────────
  it("calls next when token has a jti that is NOT in the blacklist", async () => {
    const req = makeReq("Bearer valid_token");
    const res = makeRes();
    (mockJwt.verify as jest.Mock).mockReturnValueOnce({
      userId: "user-abc",
      jti: "fresh-jti",
    });
    isJtiRevokedMock.mockResolvedValueOnce(false);
    await authenticate(req, res, next as NextFunction);
    expect(isJtiRevokedMock).toHaveBeenCalledWith("fresh-jti");
    expect(req.userId).toBe("user-abc");
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns 401 when token's jti has been revoked", async () => {
    const req = makeReq("Bearer revoked_token");
    const res = makeRes();
    (mockJwt.verify as jest.Mock).mockReturnValueOnce({
      userId: "user-abc",
      jti: "revoked-jti",
    });
    isJtiRevokedMock.mockResolvedValueOnce(true);
    await authenticate(req, res, next as NextFunction);
    expect(isJtiRevokedMock).toHaveBeenCalledWith("revoked-jti");
    expect(res.status).toHaveBeenCalledWith(401);
    expect((res.json as jest.Mock).mock.calls[0][0].error).toBe(
      "Invalid or expired token",
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("does not consult the blacklist for legacy tokens with no jti", async () => {
    const req = makeReq("Bearer legacy_token");
    const res = makeRes();
    (mockJwt.verify as jest.Mock).mockReturnValueOnce({ userId: "user-abc" });
    await authenticate(req, res, next as NextFunction);
    expect(isJtiRevokedMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
