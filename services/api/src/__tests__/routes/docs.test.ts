import request from "supertest";
import express from "express";
import { docsRouter } from "../../routes/docs";
import { requestIdMiddleware } from "../../middleware/requestId";

jest.setTimeout(20000);

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/docs", docsRouter);

describe("GET /api/docs", () => {
  it("serves the Swagger UI", async () => {
    const res = await request(app).get("/api/docs/");

    expect(res.status).toBe(200);
    expect(res.text).toContain("swagger-ui");
    expect(res.text).toContain("Atlas API Docs");
  });
});

describe("GET /api/docs/openapi.yaml", () => {
  it("serves the raw OpenAPI spec file", async () => {
    const res = await request(app).get("/api/docs/openapi.yaml");

    expect(res.status).toBe(200);
    expect(res.text).toContain("openapi: 3.0.3");
    expect(res.text).toContain("/api/auth/register");
  });
});
