import { Router } from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { authenticate, AuthRequest } from "../middleware/auth";
import { success, error } from "../lib/response";
import { validationFailResponse } from "../lib/schemas";
import { logger } from "../lib/logger";

// ---------------------------------------------------------------------------
// Supabase client (same project as QA — the capacity/ops Supabase)
// ---------------------------------------------------------------------------

const BUGS_SUPABASE_URL = process.env.QA_SUPABASE_URL || "https://zoirudjyqfqvpxsrxepr.supabase.co";
const BUGS_SUPABASE_KEY = process.env.QA_SUPABASE_KEY ?? "";

if (!BUGS_SUPABASE_KEY) {
  logger.warn("QA_SUPABASE_KEY not set — Bug routes will fail");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bugsSupabase: any = BUGS_SUPABASE_KEY
  ? createClient(BUGS_SUPABASE_URL, BUGS_SUPABASE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const createBugSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low", "cosmetic"]).default("medium"),
  page_route: z.string().optional().nullable(),
  page_url: z.string().optional().nullable(),
  source: z.enum(["manual", "console", "session"]).default("manual"),
  tags: z.array(z.string()).optional(),
});

const updateBugSchema = z.object({
  status: z.enum(["open", "fixed", "in-progress", "closed", "wontfix", "archived"]).optional(),
  notes: z.string().optional().nullable(),
  severity: z.enum(["critical", "high", "medium", "low", "cosmetic"]).optional(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().optional(),
  fixed_by: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const bugsRouter = Router();
bugsRouter.use(authenticate);
bugsRouter.use((_req, res, next) => {
  if (!bugsSupabase) {
    return res
      .status(503)
      .json({ success: false, error: "Bug service unavailable — QA_SUPABASE_KEY not configured" });
  }
  next();
});

const TABLE = "bugs";

// GET /api/bugs — list all bugs, filterable by status
bugsRouter.get("/", async (req: AuthRequest, res) => {
  try {
    const { status: statusParam } = req.query;

    let query = bugsSupabase
      .from(TABLE)
      .select("*")
      .eq("project", "atlas")
      .order("last_seen_at", { ascending: false });

    // Filter by status if provided
    if (statusParam && typeof statusParam === "string") {
      const statuses = statusParam.split(",").map((s: string) => s.trim());
      if (statuses.length === 1) {
        query = query.eq("status", statuses[0]);
      } else {
        query = query.in("status", statuses);
      }
    }

    // Exclude archived by default unless explicitly requested
    const statusStr = typeof statusParam === "string" ? statusParam : "";
    if (!statusStr || !statusStr.includes("archived")) {
      query = query.neq("status", "archived");
    }

    const { data, error: dbErr } = await query;

    if (dbErr) throw dbErr;
    res.json(success({ bugs: data || [] }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to list bugs");
    res.status(500).json(error("Failed to list bugs"));
  }
});

// GET /api/bugs/:id — single bug detail
bugsRouter.get("/:id", async (req: AuthRequest, res) => {
  try {
    const { data, error: dbErr } = await bugsSupabase
      .from(TABLE)
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (dbErr || !data) return res.status(404).json(error("Bug not found"));
    res.json(success({ bug: data }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to get bug");
    res.status(500).json(error("Failed to get bug"));
  }
});

// POST /api/bugs — manual bug creation
bugsRouter.post("/", async (req: AuthRequest, res) => {
  const parsed = createBugSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(validationFailResponse(parsed.error));
  }

  const { title, description, severity, page_route, page_url, source, tags } = parsed.data;

  try {
    const { data, error: dbErr } = await bugsSupabase
      .from(TABLE)
      .insert({
        title,
        description,
        severity,
        status: "open",
        source: source || "manual",
        project: "atlas",
        page_route: page_route || null,
        page_url: page_url || null,
        tags: tags || [],
        found_by: req.userId,
        last_seen_at: new Date().toISOString(),
        occurrence_count: 1,
      })
      .select()
      .single();

    if (dbErr) throw dbErr;
    res.status(201).json(success({ bug: data }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to create bug");
    res.status(500).json(error("Failed to create bug"));
  }
});

// PATCH /api/bugs/:id — update status, notes, etc.
bugsRouter.patch("/:id", async (req: AuthRequest, res) => {
  const parsed = updateBugSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(validationFailResponse(parsed.error));
  }

  try {
    // Verify bug exists
    const { data: existing, error: fetchErr } = await bugsSupabase
      .from(TABLE)
      .select("id")
      .eq("id", req.params.id)
      .single();

    if (fetchErr || !existing) return res.status(404).json(error("Bug not found"));

    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    const { status, notes, severity, title, description, fixed_by, tags } = parsed.data;

    if (status !== undefined) {
      updateData.status = status;
      // Set fixed_at timestamp when marking as fixed/closed
      if (status === "fixed" || status === "closed") {
        updateData.fixed_at = new Date().toISOString();
      }
    }
    if (notes !== undefined) updateData.notes = notes;
    if (severity !== undefined) updateData.severity = severity;
    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (fixed_by !== undefined) updateData.fixed_by = fixed_by;
    if (tags !== undefined) updateData.tags = tags;

    const { data, error: dbErr } = await bugsSupabase
      .from(TABLE)
      .update(updateData)
      .eq("id", req.params.id)
      .select()
      .single();

    if (dbErr) throw dbErr;
    res.json(success({ bug: data }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to update bug");
    res.status(500).json(error("Failed to update bug"));
  }
});

// DELETE /api/bugs/:id — soft delete (set status='archived')
bugsRouter.delete("/:id", async (req: AuthRequest, res) => {
  try {
    const { data: existing, error: fetchErr } = await bugsSupabase
      .from(TABLE)
      .select("id")
      .eq("id", req.params.id)
      .single();

    if (fetchErr || !existing) return res.status(404).json(error("Bug not found"));

    const { data, error: dbErr } = await bugsSupabase
      .from(TABLE)
      .update({
        status: "archived",
        updated_at: new Date().toISOString(),
      })
      .eq("id", req.params.id)
      .select()
      .single();

    if (dbErr) throw dbErr;
    res.json(success({ bug: data }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to archive bug");
    res.status(500).json(error("Failed to archive bug"));
  }
});
