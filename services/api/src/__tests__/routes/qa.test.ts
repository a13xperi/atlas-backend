/**
 * QA routes test suite.
 * Tests GET /runs, GET /runs/:id, POST /runs, PATCH /runs/:id, DELETE /runs/:id.
 * Mocks: Supabase client (chainable query builder), Prisma, auth middleware.
 */

import request from "supertest";
import express from "express";
import { requestIdMiddleware } from "../../middleware/requestId";

jest.mock("../../middleware/auth", () => ({
  authenticate: jest.fn((req: any, res: any, next: any) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing authorization token" });
    }
    req.userId = "user-123";
    next();
  }),
  AuthRequest: {},
}));

jest.mock("../../lib/supabase", () => ({ supabaseAdmin: null }));

jest.mock("../../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
    },
  },
}));

jest.mock("../../lib/logger", () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

// Chainable Supabase mock — each method returns `this` (the proxy),
// terminal methods (`.single()`, `.order()`, and bare `.eq()` at chain end)
// resolve with the configured result.
let queryResult: { data: any; error: any } = { data: null, error: null };

function setQueryResult(data: any, error: any = null) {
  queryResult = { data, error };
}

// Track a queue of results for tests that make multiple queries
let resultQueue: Array<{ data: any; error: any }> = [];

function enqueueResult(data: any, error: any = null) {
  resultQueue.push({ data, error });
}

function nextResult() {
  if (resultQueue.length > 0) {
    return resultQueue.shift()!;
  }
  return queryResult;
}

const chainHandler: ProxyHandler<object> = {
  get(_target, prop) {
    if (prop === "then" || prop === "catch" || prop === "finally") {
      // Make the proxy thenable — resolve with current result
      if (prop === "then") {
        return (resolve: (v: any) => any) => resolve(nextResult());
      }
      return undefined;
    }
    // Terminal methods that resolve the chain
    if (prop === "single" || prop === "order") {
      return (..._args: any[]) => Promise.resolve(nextResult());
    }
    // Chainable methods return the proxy
    return (..._args: any[]) => new Proxy({}, chainHandler);
  },
};

function makeChainProxy() {
  return new Proxy({}, chainHandler);
}

const mockSupabase = {
  from: jest.fn(() => makeChainProxy()),
};

// Set env before module loads
process.env.QA_SUPABASE_KEY = "test-key";

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(() => mockSupabase),
}));

import { qaRouter } from "../../routes/qa";
import { prisma } from "../../lib/prisma";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/qa", qaRouter);

const AUTH = { Authorization: "Bearer mock_token" };

describe("GET /api/qa/runs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resultQueue = [];
    queryResult = { data: null, error: null };
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/qa/runs");
    expect(res.status).toBe(401);
  });

  it("returns test runs for atlas project", async () => {
    const runs = [{ id: "run-1", project: "atlas", status: "in_progress" }];
    setQueryResult(runs);

    const res = await request(app).get("/api/qa/runs").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.runs).toEqual(runs);
  });

  it("returns 500 on Supabase error", async () => {
    setQueryResult(null, { message: "db error" });

    const res = await request(app).get("/api/qa/runs").set(AUTH);
    expect(res.status).toBe(500);
  });
});

describe("GET /api/qa/runs/:id", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resultQueue = [];
    queryResult = { data: null, error: null };
  });

  it("returns a single test run", async () => {
    const run = { id: "run-1", project: "atlas", status: "complete" };
    setQueryResult(run);

    const res = await request(app).get("/api/qa/runs/run-1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.run).toEqual(run);
  });

  it("returns 404 when run not found", async () => {
    setQueryResult(null, { code: "PGRST116" });

    const res = await request(app).get("/api/qa/runs/nonexistent").set(AUTH);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/qa/runs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resultQueue = [];
    queryResult = { data: null, error: null };
  });

  it("creates a new test run", async () => {
    const created = {
      id: "run-new",
      project: "atlas",
      tester_id: "user-123",
      tester_name: "Alex",
      tester_initials: "AP",
      status: "in_progress",
    };
    setQueryResult(created);

    const res = await request(app)
      .post("/api/qa/runs")
      .set(AUTH)
      .send({ tester_name: "Alex", tester_initials: "AP" });

    expect(res.status).toBe(201);
    expect(res.body.data.run.tester_name).toBe("Alex");
  });

  it("returns 400 when tester_name is missing", async () => {
    const res = await request(app)
      .post("/api/qa/runs")
      .set(AUTH)
      .send({ tester_initials: "AP" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when tester_initials exceeds max length", async () => {
    const res = await request(app)
      .post("/api/qa/runs")
      .set(AUTH)
      .send({ tester_name: "Alex", tester_initials: "TOOLONG!" });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/qa/runs/:id", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resultQueue = [];
    queryResult = { data: null, error: null };
  });

  it("allows owner to update results", async () => {
    // First query: ownership check
    enqueueResult({ tester_id: "user-123" });
    // Second query: the update
    enqueueResult({ tester_id: "user-123", status: "complete" });

    const res = await request(app)
      .patch("/api/qa/runs/run-1")
      .set(AUTH)
      .send({ status: "complete", results: { route_home: "pass" } });

    expect(res.status).toBe(200);
  });

  it("returns 403 when analyst tries to update another's run", async () => {
    enqueueResult({ tester_id: "other-user" });
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
      id: "user-123",
      role: "ANALYST",
    });

    const res = await request(app)
      .patch("/api/qa/runs/run-1")
      .set(AUTH)
      .send({ status: "complete" });

    expect(res.status).toBe(403);
  });

  it("allows manager to update any run", async () => {
    enqueueResult({ tester_id: "other-user" });
    enqueueResult({ tester_id: "other-user", status: "reviewed" });
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
      id: "user-123",
      role: "MANAGER",
    });

    const res = await request(app)
      .patch("/api/qa/runs/run-1")
      .set(AUTH)
      .send({ status: "reviewed" });

    expect(res.status).toBe(200);
  });

  it("returns 404 when run not found", async () => {
    enqueueResult(null, { code: "PGRST116" });

    const res = await request(app)
      .patch("/api/qa/runs/gone")
      .set(AUTH)
      .send({ status: "complete" });

    expect(res.status).toBe(404);
  });

  it("rejects unexpected fields (strict schema)", async () => {
    const res = await request(app)
      .patch("/api/qa/runs/run-1")
      .set(AUTH)
      .send({ status: "complete", unknown_field: true });

    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/qa/runs/:id", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resultQueue = [];
    queryResult = { data: null, error: null };
  });

  it("allows manager to delete a run", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
      id: "user-123",
      role: "MANAGER",
    });
    setQueryResult(null);

    const res = await request(app).delete("/api/qa/runs/run-1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
  });

  it("returns 403 for analyst", async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
      id: "user-123",
      role: "ANALYST",
    });

    const res = await request(app).delete("/api/qa/runs/run-1").set(AUTH);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/[Mm]anager/);
  });
});
