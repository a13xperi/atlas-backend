import express from "express";
import request from "supertest";
import { authRouter } from "../../routes/auth";
import { requestIdMiddleware } from "../../middleware/requestId";

jest.mock("../../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
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

describe("requestId middleware", () => {
  const app = express();

  app.use(express.json());
  app.use(requestIdMiddleware);
  app.get("/ping", (_req, res) => {
    res.json({ ok: true });
  });
  app.use("/api/auth", authRouter);

  it("adds an X-Request-ID header to successful responses", async () => {
    const res = await request(app).get("/ping");

    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toEqual(expect.any(String));
  });

  it("includes requestId in error response bodies", async () => {
    const res = await request(app).post("/api/auth/register").send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Handle is required");
    expect(res.body.message).toBe("Handle is required");
    expect(res.body.requestId).toBe(res.headers["x-request-id"]);
  });

  it("generates a unique request ID for each request", async () => {
    const first = await request(app).get("/ping");
    const second = await request(app).get("/ping");

    expect(first.headers["x-request-id"]).toEqual(expect.any(String));
    expect(second.headers["x-request-id"]).toEqual(expect.any(String));
    expect(first.headers["x-request-id"]).not.toBe(second.headers["x-request-id"]);
  });
});
