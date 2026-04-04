import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import { authenticate, AuthRequest } from "../middleware/auth";
import { prisma } from "../lib/prisma";
import { success, error } from "../lib/response";
import { logger } from "../lib/logger";

// QA data lives in the Sage/capacity Supabase project (separate from auth)
const QA_SUPABASE_URL = process.env.QA_SUPABASE_URL || "https://zoirudjyqfqvpxsrxepr.supabase.co";
const QA_SUPABASE_KEY = process.env.QA_SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpvaXJ1ZGp5cWZxdnB4c3J4ZXByIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgwMzE4MjgsImV4cCI6MjA4MzYwNzgyOH0.6W6OzRfJ-nmKN_23z1OBCS4Cr-ODRq9DJmF_yMwOCfo";

const qaSupabase = createClient(QA_SUPABASE_URL, QA_SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export const qaRouter = Router();
qaRouter.use(authenticate);

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
  try {
    const { tester_name, tester_initials } = req.body;
    if (!tester_name || !tester_initials) {
      return res.status(400).json(error("tester_name and tester_initials required"));
    }

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

    const { results, summary, status } = req.body;
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
