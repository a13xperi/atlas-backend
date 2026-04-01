/**
 * Auth middleware test suite
 * Tests JWT verification and req.userId injection
 * With supabaseAdmin=null, authenticate uses legacy JWT path only
 */

import { Request, Response, NextFunction } from "express";
import { authenticate, AuthRequest } from "../middleware/auth";
import jwt from "jsonwebtoken";

jest.mock("../lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("../lib/prisma", () => ({
  prisma: { user: { findUnique: jest.fn(), update: jest.fn() } },
}));

jest.mock("jsonwebtoken", () => ({
  verify: jest.fn(),
}));

const mockJwt = jwt as jest.Mocked<typeof jwt>;

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
    process.env.JWT_SECRET = "test-secret";
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
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

  it("verifies token against JWT_SECRET env var", async () => {
    process.env.JWT_SECRET = "my-test-secret";
    const req = makeReq("Bearer valid_token");
    const res = makeRes();
    (mockJwt.verify as jest.Mock).mockReturnValueOnce({ userId: "user-xyz" });
    await authenticate(req, res, next as NextFunction);
    expect(mockJwt.verify).toHaveBeenCalledWith("valid_token", "my-test-secret");
  });

  it("returns 401 when JWT_SECRET not set", async () => {
    delete process.env.JWT_SECRET;
    const req = makeReq("Bearer valid_token");
    const res = makeRes();
    await authenticate(req, res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
