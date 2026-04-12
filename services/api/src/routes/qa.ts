import { Router } from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { authenticate, AuthRequest } from "../middleware/auth";
import { prisma } from "../lib/prisma";
import { success, error } from "../lib/response";
import { validationFailResponse } from "../lib/schemas";
import { logger } from "../lib/logger";

const createQaRunSchema = z.object({
  tester_name: z.string().min(1),
  tester_initials: z.string().min(1).max(6),
});

// Mirrors the downstream Supabase update — every field is optional so
// partial updates are valid. `results` and `summary` are arbitrary JSON
// blobs (rendered client-side), so we stay permissive on their inner
// shape and only enforce the top-level object.
const updateQaRunSchema = z
  .object({
    results: z.record(z.unknown()).optional(),
    summary: z.record(z.unknown()).optional(),
    status: z.string().min(1).optional(),
  })
  .strict();

// QA data lives in the Sage/capacity Supabase project (separate from auth)
const QA_SUPABASE_URL = process.env.QA_SUPABASE_URL || "https://zoirudjyqfqvpxsrxepr.supabase.co";
const QA_SUPABASE_KEY = process.env.QA_SUPABASE_KEY ?? "";

if (!QA_SUPABASE_KEY) {
  logger.warn("QA_SUPABASE_KEY not set — QA routes will fail");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const qaSupabase: any = QA_SUPABASE_KEY
  ? createClient(QA_SUPABASE_URL, QA_SUPABASE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

export const qaRouter = Router();
qaRouter.use(authenticate);
qaRouter.use((_req, res, next) => {
  if (!qaSupabase) {
    return res.status(503).json({ success: false, error: "QA service unavailable — QA_SUPABASE_KEY not configured" });
  }
  next();
});

const TABLE = "qa_test_runs";

// List all test runs for project 'atlas'
qaRouter.get("/runs", async (req: AuthRequest, res) => {
  try {
    const { data, error: dbErr } = await qaSupabase
      .from(TABLE)
      .select("*")
      .eq("project", "atlas")
      .order("created_at", { ascending: false });

    if (dbErr) throw dbErr;
    res.json(success({ runs: data }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to list QA runs");
    res.status(500).json(error("Failed to list QA runs"));
  }
});

// Get single test run
qaRouter.get("/runs/:id", async (req: AuthRequest, res) => {
  try {
    const { data, error: dbErr } = await qaSupabase
      .from(TABLE)
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (dbErr || !data) return res.status(404).json(error("Test run not found"));
    res.json(success({ run: data }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to get QA run");
    res.status(500).json(error("Failed to get QA run"));
  }
});

// Create test run
qaRouter.post("/runs", async (req: AuthRequest, res) => {
  const parsed = createQaRunSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(validationFailResponse(parsed.error));
  }
  const { tester_name, tester_initials } = parsed.data;

  try {
    const { data, error: dbErr } = await qaSupabase
      .from(TABLE)
      .insert({
        project: "atlas",
        tester_id: req.userId,
        tester_name,
        tester_initials,
        status: "in_progress",
        results: {},
        summary: {},
      })
      .select()
      .single();

    if (dbErr) throw dbErr;
    res.status(201).json(success({ run: data }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to create QA run");
    res.status(500).json(error("Failed to create QA run"));
  }
});

// Update test run (owner or MANAGER)
qaRouter.patch("/runs/:id", async (req: AuthRequest, res) => {
  const parsed = updateQaRunSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(validationFailResponse(parsed.error));
  }

  try {
    const { data: run, error: fetchErr } = await qaSupabase
      .from(TABLE)
      .select("tester_id")
      .eq("id", req.params.id)
      .single();

    if (fetchErr || !run) return res.status(404).json(error("Test run not found"));

    // Check ownership or manager role
    if (run.tester_id !== req.userId) {
      const user = await prisma.user.findUnique({ where: { id: req.userId } });
      if (!user || user.role === "ANALYST") {
        return res.status(403).json(error("Only the tester or a manager can update this run"));
      }
    }

    const { results, summary, status } = parsed.data;
    const { data, error: dbErr } = await qaSupabase
      .from(TABLE)
      .update({
        ...(results !== undefined && { results }),
        ...(summary !== undefined && { summary }),
        ...(status !== undefined && { status }),
        updated_at: new Date().toISOString(),
      })
      .eq("id", req.params.id)
      .select()
      .single();

    if (dbErr) throw dbErr;
    res.json(success({ run: data }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to update QA run");
    res.status(500).json(error("Failed to update QA run"));
  }
});

// Delete test run (MANAGER only)
qaRouter.delete("/runs/:id", async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user || user.role === "ANALYST") {
      return res.status(403).json(error("Manager access required"));
    }

    const { error: dbErr } = await qaSupabase
      .from(TABLE)
      .delete()
      .eq("id", req.params.id);

    if (dbErr) throw dbErr;
    res.json(success({ deleted: true }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to delete QA run");
    res.status(500).json(error("Failed to delete QA run"));
  }
});
