import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { logger } from "../lib/logger";
import { success, error } from "../lib/response";

export const bugsRouter: Router = Router({ mergeParams: true });

function paramId(req: Request, name = "id"): string {
  return req.params[name] as string;
}

// Map Prisma row (camelCase) → BugRecord (snake_case) for the portal.
function serializeBug(bug: {
  id: string;
  bugNumber: number;
  title: string;
  description: string;
  pageRoute: string | null;
  pageUrl: string | null;
  severity: string;
  status: string;
  source: string | null;
  project: string | null;
  foundBy: string | null;
  fixedBy: string | null;
  tags: string[];
  notes: string | null;
  fingerprint: string | null;
  occurrenceCount: number;
  userAgent: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date | null;
  fixedAt: Date | null;
}) {
  return {
    id: bug.id,
    bug_number: bug.bugNumber,
    title: bug.title,
    description: bug.description,
    page_route: bug.pageRoute,
    page_url: bug.pageUrl,
    severity: bug.severity,
    status: bug.status,
    source: bug.source,
    project: bug.project,
    found_by: bug.foundBy,
    fixed_by: bug.fixedBy,
    tags: bug.tags,
    notes: bug.notes,
    fingerprint: bug.fingerprint,
    occurrence_count: bug.occurrenceCount,
    user_agent: bug.userAgent,
    created_at: bug.createdAt.toISOString(),
    updated_at: bug.updatedAt.toISOString(),
    last_seen_at: bug.lastSeenAt ? bug.lastSeenAt.toISOString() : null,
    fixed_at: bug.fixedAt ? bug.fixedAt.toISOString() : null,
  };
}

const createSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(20000).optional(),
  page_route: z.string().max(500).nullable().optional(),
  page_url: z.string().max(2000).nullable().optional(),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  status: z.enum(["open", "fixed", "wont_fix"]).optional(),
  source: z.string().max(100).nullable().optional(),
  project: z.string().max(100).nullable().optional(),
  found_by: z.string().max(200).nullable().optional(),
  fixed_by: z.string().max(200).nullable().optional(),
  tags: z.array(z.string().max(100)).optional(),
  notes: z.string().max(20000).nullable().optional(),
  fingerprint: z.string().max(500).nullable().optional(),
  occurrence_count: z.number().int().min(0).optional(),
  user_agent: z.string().max(1000).nullable().optional(),
  last_seen_at: z.string().datetime().nullable().optional(),
  fixed_at: z.string().datetime().nullable().optional(),
});

const updateSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(20000).optional(),
  page_route: z.string().max(500).nullable().optional(),
  page_url: z.string().max(2000).nullable().optional(),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  status: z.enum(["open", "fixed", "wont_fix"]).optional(),
  source: z.string().max(100).nullable().optional(),
  project: z.string().max(100).nullable().optional(),
  found_by: z.string().max(200).nullable().optional(),
  fixed_by: z.string().max(200).nullable().optional(),
  tags: z.array(z.string().max(100)).optional(),
  notes: z.string().max(20000).nullable().optional(),
  fingerprint: z.string().max(500).nullable().optional(),
  occurrence_count: z.number().int().min(0).optional(),
  user_agent: z.string().max(1000).nullable().optional(),
  last_seen_at: z.string().datetime().nullable().optional(),
  fixed_at: z.string().datetime().nullable().optional(),
});

const listQuerySchema = z.object({
  status: z.enum(["open", "fixed", "wont_fix"]).optional(),
});

// POST /api/bugs — create bug.
// NOT gated on auth: the portal's auto-reporter posts bugs without a user
// token. Register this route before the authenticate middleware below.
bugsRouter.post("/", async (req: Request, res) => {
  try {
    const body = createSchema.parse(req.body);
    const bug = await prisma.bug.create({
      data: {
        title: body.title,
        description: body.description ?? "",
        pageRoute: body.page_route ?? null,
        pageUrl: body.page_url ?? null,
        severity: body.severity ?? "medium",
        status: body.status ?? "open",
        source: body.source ?? null,
        project: body.project ?? null,
        foundBy: body.found_by ?? null,
        fixedBy: body.fixed_by ?? null,
        tags: body.tags ?? [],
        notes: body.notes ?? null,
        fingerprint: body.fingerprint ?? null,
        occurrenceCount: body.occurrence_count ?? 1,
        userAgent: body.user_agent ?? null,
        lastSeenAt: body.last_seen_at ? new Date(body.last_seen_at) : null,
        fixedAt: body.fixed_at ? new Date(body.fixed_at) : null,
      },
    });
    logger.info({ bugId: bug.id, bugNumber: bug.bugNumber }, "Bug created");
    res.status(201).json(success({ bug: serializeBug(bug) }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    logger.error({ err: err.message }, "Failed to create bug");
    res.status(500).json(error("Failed to create bug"));
  }
});

// All remaining routes require authentication.
bugsRouter.use(authenticate);

// GET /api/bugs — list all bugs, optional ?status=open filter, newest first.
bugsRouter.get("/", async (req: AuthRequest, res) => {
  try {
    const query = listQuerySchema.parse(req.query);
    const bugs = await prisma.bug.findMany({
      where: query.status ? { status: query.status } : undefined,
      orderBy: { createdAt: "desc" },
    });
    res.json(success({ bugs: bugs.map(serializeBug) }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    logger.error({ err: err.message }, "Failed to list bugs");
    res.status(500).json(error("Failed to list bugs"));
  }
});

// GET /api/bugs/:id — single bug.
bugsRouter.get("/:id", async (req: AuthRequest, res) => {
  try {
    const bug = await prisma.bug.findUnique({ where: { id: paramId(req) } });
    if (!bug) {
      return res.status(404).json(error("Bug not found", 404));
    }
    res.json(success({ bug: serializeBug(bug) }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to get bug");
    res.status(500).json(error("Failed to get bug"));
  }
});

// PATCH /api/bugs/:id — update bug fields.
bugsRouter.patch("/:id", async (req: AuthRequest, res) => {
  try {
    const body = updateSchema.parse(req.body);

    const data: Record<string, unknown> = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.description !== undefined) data.description = body.description;
    if (body.page_route !== undefined) data.pageRoute = body.page_route;
    if (body.page_url !== undefined) data.pageUrl = body.page_url;
    if (body.severity !== undefined) data.severity = body.severity;
    if (body.status !== undefined) data.status = body.status;
    if (body.source !== undefined) data.source = body.source;
    if (body.project !== undefined) data.project = body.project;
    if (body.found_by !== undefined) data.foundBy = body.found_by;
    if (body.fixed_by !== undefined) data.fixedBy = body.fixed_by;
    if (body.tags !== undefined) data.tags = body.tags;
    if (body.notes !== undefined) data.notes = body.notes;
    if (body.fingerprint !== undefined) data.fingerprint = body.fingerprint;
    if (body.occurrence_count !== undefined) data.occurrenceCount = body.occurrence_count;
    if (body.user_agent !== undefined) data.userAgent = body.user_agent;
    if (body.last_seen_at !== undefined) {
      data.lastSeenAt = body.last_seen_at ? new Date(body.last_seen_at) : null;
    }
    if (body.fixed_at !== undefined) {
      data.fixedAt = body.fixed_at ? new Date(body.fixed_at) : null;
    }

    const existing = await prisma.bug.findUnique({ where: { id: paramId(req) } });
    if (!existing) {
      return res.status(404).json(error("Bug not found", 404));
    }

    const bug = await prisma.bug.update({
      where: { id: paramId(req) },
      data,
    });
    res.json(success({ bug: serializeBug(bug) }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    logger.error({ err: err.message }, "Failed to update bug");
    res.status(500).json(error("Failed to update bug"));
  }
});

// DELETE /api/bugs/:id — remove bug.
bugsRouter.delete("/:id", async (req: AuthRequest, res) => {
  try {
    const deleted = await prisma.bug.deleteMany({ where: { id: paramId(req) } });
    if (deleted.count === 0) {
      return res.status(404).json(error("Bug not found", 404));
    }
    res.json(success({ deleted: true }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to delete bug");
    res.status(500).json(error("Failed to delete bug"));
  }
});
