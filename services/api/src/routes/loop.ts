import { Router } from "express";
import { z } from "zod";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { authenticate, AuthRequest } from "../middleware/auth";
import { buildErrorResponse } from "../middleware/requestId";
import { DEFAULT_GITHUB_OWNER, DEFAULT_GITHUB_REPO } from "../lib/config";

export const loopRouter = Router();
loopRouter.use(authenticate);

const RALPH_STATE_PATH = process.env.RALPH_STATE_PATH || ".ralph/state.json";

const defaultLoopState = {
  taskId: "",
  status: "idle" as const,
  currentIteration: 0,
  maxIterations: 0,
  iterations: [],
  bestIteration: null,
  evalType: "",
  startedAt: null,
  completedAt: null,
};

// GET /api/loop/state — read loop state from filesystem
loopRouter.get("/state", async (req: AuthRequest, res) => {
  try {
    const statePath = resolve(RALPH_STATE_PATH);
    let raw: string;
    try {
      raw = await readFile(statePath, "utf-8");
    } catch {
      return res.json({ loop: defaultLoopState });
    }

    const parsed = JSON.parse(raw);
    if (!parsed || Object.keys(parsed).length === 0) {
      return res.json({ loop: defaultLoopState });
    }

    res.json({
      loop: {
        ...defaultLoopState,
        ...parsed,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json(buildErrorResponse(req, "Failed to read loop state", { message }));
  }
});

const createPRSchema = z.object({
  branch: z.string().min(1),
  taskId: z.string().min(1),
});

// POST /api/loop/create-pr — create a GitHub PR from a loop branch
loopRouter.post("/create-pr", async (req: AuthRequest, res) => {
  try {
    const { branch, taskId } = createPRSchema.parse(req.body);

    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return res.status(503).json(buildErrorResponse(req, "GitHub token not configured"));
    }

    // Defaults come from lib/config so they don't drift from .env.example.
    // We still read process.env at request time so the existing jest tests
    // can mutate env-per-test without reloading the module.
    const owner = process.env.GITHUB_OWNER || DEFAULT_GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO || DEFAULT_GITHUB_REPO;

    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: `feat: AutoResearch result for ${taskId}`,
        head: branch,
        base: "staging",
        body: `AutoResearch loop completed for ${taskId}.\n\nBranch: \`${branch}\`\nCreated via Mission Control Loop Panel.`,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return res.status(response.status).json(
        buildErrorResponse(req, "GitHub API error", { message: errorBody })
      );
    }

    const pr = (await response.json()) as { html_url: string };
    res.json({ prUrl: pr.html_url });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(buildErrorResponse(req, "Invalid request body", { details: err.errors }));
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json(buildErrorResponse(req, "Failed to create PR", { message }));
  }
});
