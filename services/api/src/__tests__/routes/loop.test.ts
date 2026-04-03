import request from "supertest";
import express from "express";
import { readFile } from "fs/promises";
import { authenticate } from "../../middleware/auth";
import { loopRouter } from "../../routes/loop";
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

jest.mock("fs/promises", () => ({
  readFile: jest.fn(),
}));

const mockReadFile = readFile as jest.Mock;
const mockAuthenticate = authenticate as jest.Mock;
const mockFetch = jest.fn();

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/loop", loopRouter);

const AUTH = "Bearer mock_token";

const defaultLoopState = {
  taskId: "",
  status: "idle",
  currentIteration: 0,
  maxIterations: 0,
  iterations: [],
  bestIteration: null,
  evalType: "",
  startedAt: null,
  completedAt: null,
};

const originalFetch = global.fetch;

beforeAll(() => {
  process.env.JWT_SECRET = "test-secret";
  global.fetch = mockFetch as typeof fetch;
});

afterAll(() => {
  delete process.env.JWT_SECRET;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_OWNER;
  delete process.env.GITHUB_REPO;

  if (originalFetch) {
    global.fetch = originalFetch;
  } else {
    (global as any).fetch = undefined;
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  mockReadFile.mockReset();
  mockFetch.mockReset();
  mockAuthenticate.mockClear();
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_OWNER;
  delete process.env.GITHUB_REPO;
});

describe("GET /api/loop/state", () => {
  it("returns default state when file doesn't exist", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT"));

    const res = await request(app)
      .get("/api/loop/state")
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(res.body.loop).toEqual(defaultLoopState);
  });

  it("returns parsed JSON when file exists", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        taskId: "task-123",
        status: "running",
        currentIteration: 2,
        maxIterations: 5,
        iterations: [{ iteration: 1, score: 0.84 }],
      })
    );

    const res = await request(app)
      .get("/api/loop/state")
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(res.body.loop).toEqual({
      ...defaultLoopState,
      taskId: "task-123",
      status: "running",
      currentIteration: 2,
      maxIterations: 5,
      iterations: [{ iteration: 1, score: 0.84 }],
    });
  });

  it("handles JSON parse errors gracefully", async () => {
    mockReadFile.mockResolvedValueOnce("{invalid-json");

    const res = await request(app)
      .get("/api/loop/state")
      .set("Authorization", AUTH);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to read loop state");
    expect(res.body.requestId).toBeDefined();
    expect(typeof res.body.message).toBe("string");
  });
});

describe("POST /api/loop/create-pr", () => {
  it.each([
    [{ taskId: "task-123" }, "branch"],
    [{ branch: "codex/loop-pr" }, "taskId"],
  ])("returns 400 when %s is missing", async (body, _missingField) => {
    const res = await request(app)
      .post("/api/loop/create-pr")
      .set("Authorization", AUTH)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body");
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it("returns 500 when GITHUB_TOKEN not set", async () => {
    const res = await request(app)
      .post("/api/loop/create-pr")
      .set("Authorization", AUTH)
      .send({ branch: "codex/loop-pr", taskId: "task-123" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("GitHub token not configured");
    expect(res.body.requestId).toBeDefined();
  });

  it("returns success with PR URL on valid request", async () => {
    process.env.GITHUB_TOKEN = "github-token";
    process.env.GITHUB_OWNER = "delphi-digital";
    process.env.GITHUB_REPO = "atlas-backend";

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValueOnce({
        html_url: "https://github.com/delphi-digital/atlas-backend/pull/42",
      }),
    });

    const res = await request(app)
      .post("/api/loop/create-pr")
      .set("Authorization", AUTH)
      .send({ branch: "codex/loop-pr", taskId: "task-123" });

    expect(res.status).toBe(200);
    expect(res.body.prUrl).toBe("https://github.com/delphi-digital/atlas-backend/pull/42");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/delphi-digital/atlas-backend/pulls",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer github-token",
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        }),
      })
    );

    const [, options] = mockFetch.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      title: "feat: AutoResearch result for task-123",
      head: "codex/loop-pr",
      base: "staging",
      body:
        "AutoResearch loop completed for task-123.\n\nBranch: `codex/loop-pr`\nCreated via Mission Control Loop Panel.",
    });
  });

  it("returns error when GitHub API returns non-ok response", async () => {
    process.env.GITHUB_TOKEN = "github-token";

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: jest.fn().mockResolvedValueOnce("Validation failed"),
    });

    const res = await request(app)
      .post("/api/loop/create-pr")
      .set("Authorization", AUTH)
      .send({ branch: "codex/loop-pr", taskId: "task-123" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("GitHub API error");
    expect(res.body.message).toBe("Validation failed");
    expect(res.body.requestId).toBeDefined();
  });
});
