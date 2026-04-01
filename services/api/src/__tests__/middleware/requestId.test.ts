import express from "express";
import request from "supertest";
import { requestIdMiddleware, buildErrorResponse } from "../../middleware/requestId";

describe("requestId middleware", () => {
  const app = express();

  app.use(express.json());
  app.use(requestIdMiddleware);
  app.get("/ping", (_req, res) => {
    res.json({ ok: true });
  });
  app.post("/error-test", (req, res) => {
    res.status(400).json(buildErrorResponse(req, "Test error"));
  });

  it("adds an X-Request-ID header to successful responses", async () => {
    const res = await request(app).get("/ping");

    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toEqual(expect.any(String));
  });

  it("includes requestId in error response bodies", async () => {
    const res = await request(app).post("/error-test").send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Test error");
    expect(res.body.message).toBe("Test error");
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
