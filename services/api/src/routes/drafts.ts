import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { runGenerationPipeline } from "../lib/pipeline";
import { buildErrorResponse } from "../middleware/requestId";
import { logger } from "../lib/logger";

export const draftsRouter = Router();
draftsRouter.use(authenticate);

// --- AI Generation Endpoints (must be before /:id routes) ---

const generateSchema = z.object({
  sourceContent: z.string().min(1).max(10000),
  sourceType: z.enum(["REPORT", "ARTICLE", "TWEET", "TRENDING_TOPIC", "VOICE_NOTE", "MANUAL"]),
  blendId: z.string().optional(),
});

const regenerateSchema = z.object({
  feedback: z.string().max(1000).optional(),
});

const engagementSchema = z.object({
  likes: z.number().int().min(0),
  retweets: z.number().int().min(0),
  impressions: z.number().int().min(0),
});

const createDraftSchema = z.object({
  content: z.string().min(1),
  sourceType: z.enum(["REPORT", "ARTICLE", "TWEET", "TRENDING_TOPIC", "VOICE_NOTE", "MANUAL"]).optional(),
  sourceContent: z.string().optional(),
  blendId: z.string().optional(),
});

const updateDraftSchema = z.object({
  content: z.string().optional(),
  status: z.enum(["DRAFT", "APPROVED", "POSTED", "ARCHIVED"]).optional(),
  feedback: z.string().optional(),
});

// Generate a tweet from source content using AI
draftsRouter.post("/generate", async (req: AuthRequest, res) => {
  try {
    const body = generateSchema.parse(req.body);

    // Run generation pipeline (voice fetch + blend + research in parallel, then generate)
    const result = await runGenerationPipeline({
      userId: req.userId!,
      sourceContent: body.sourceContent,
      sourceType: body.sourceType,
      blendId: body.blendId,
    });

    // Save as draft
    const draft = await prisma.tweetDraft.create({
      data: {
        userId: req.userId!,
        content: result.ctx.generatedContent!,
        sourceType: body.sourceType,
        sourceContent: body.sourceContent,
        blendId: body.blendId,
        confidence: result.ctx.confidence,
        predictedEngagement: result.ctx.predictedEngagement,
        version: 1,
      },
    });

    // Log analytics
    await prisma.analyticsEvent.create({
      data: { userId: req.userId!, type: "DRAFT_CREATED" },
    });

    res.json({ draft });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    // fetchVoice step throws with this message when profile missing
    if (err.message?.includes("Voice profile not found")) {
      return res
        .status(400)
        .json(buildErrorResponse(req, err.message));
    }
    logger.error({ err: err.message }, "Generate failed");
    res.status(502).json(buildErrorResponse(req, "AI generation failed"));
  }
});

// Regenerate a draft with optional feedback
draftsRouter.post("/:id/regenerate", async (req: AuthRequest, res) => {
  try {
    const body = regenerateSchema.parse(req.body);

    // Fetch the existing draft
    const existing = await prisma.tweetDraft.findFirst({
      where: { id: req.params.id as string, userId: req.userId },
    });
    if (!existing) return res.status(404).json(buildErrorResponse(req, "Draft not found"));
    if (!existing.sourceContent) {
      return res
        .status(400)
        .json(buildErrorResponse(req, "Cannot regenerate a manual draft without source content"));
    }

    // Run generation pipeline with existing draft's context
    const result = await runGenerationPipeline({
      userId: req.userId!,
      sourceContent: existing.sourceContent,
      sourceType: existing.sourceType || "MANUAL",
      blendId: existing.blendId || undefined,
      feedback: body.feedback || existing.feedback || undefined,
    });

    // Create new draft (preserves version history)
    const draft = await prisma.tweetDraft.create({
      data: {
        userId: req.userId!,
        content: result.ctx.generatedContent!,
        sourceType: existing.sourceType,
        sourceContent: existing.sourceContent,
        blendId: existing.blendId,
        confidence: result.ctx.confidence,
        predictedEngagement: result.ctx.predictedEngagement,
        version: existing.version + 1,
        feedback: body.feedback || existing.feedback,
      },
    });

    // Log analytics
    await prisma.analyticsEvent.create({
      data: { userId: req.userId!, type: "DRAFT_CREATED" },
    });
    if (body.feedback) {
      await prisma.analyticsEvent.create({
        data: { userId: req.userId!, type: "FEEDBACK_GIVEN" },
      });
    }

    res.json({ draft });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    if (err.message?.includes("Voice profile not found")) {
      return res
        .status(400)
        .json(buildErrorResponse(req, err.message));
    }
    logger.error({ err: err.message }, "Regenerate failed");
    res.status(502).json(buildErrorResponse(req, "AI generation failed"));
  }
});

// --- Standard CRUD Endpoints ---

// List drafts
draftsRouter.get("/", async (req: AuthRequest, res) => {
  try {
    const { status, limit = "20", offset = "0" } = req.query;

    const drafts = await prisma.tweetDraft.findMany({
      where: {
        userId: req.userId,
        ...(status && { status: status as any }),
      },
      orderBy: { createdAt: "desc" },
      take: parseInt(limit as string),
      skip: parseInt(offset as string),
    });

    res.json({ drafts });
  } catch (err: any) {
    res.status(500).json(buildErrorResponse(req, "Failed to load drafts"));
  }
});

// List team drafts (APPROVED + POSTED) — MANAGER/ADMIN only
draftsRouter.get("/team", async (req: AuthRequest, res) => {
  const { limit = "50", offset = "0" } = req.query;

  const requestingUser = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { role: true },
  });
  if (!requestingUser || requestingUser.role === "ANALYST") {
    return res.status(403).json({ error: "Manager or Admin role required" });
  }

  const drafts = await prisma.tweetDraft.findMany({
    where: { status: { in: ["APPROVED", "POSTED"] } },
    orderBy: { updatedAt: "desc" },
    take: parseInt(limit as string),
    skip: parseInt(offset as string),
    include: {
      user: { select: { handle: true, displayName: true, avatarUrl: true } },
    },
  });

  // Resolve blend names in one query
  const blendIds = [...new Set(drafts.map((d) => d.blendId).filter(Boolean))] as string[];
  const blends = blendIds.length
    ? await prisma.savedBlend.findMany({
        where: { id: { in: blendIds } },
        select: { id: true, name: true },
      })
    : [];
  const blendMap = Object.fromEntries(blends.map((b) => [b.id, b.name]));

  const result = drafts.map((d) => ({
    ...d,
    blendName: d.blendId ? (blendMap[d.blendId] ?? null) : null,
  }));

  res.json({ drafts: result, total: result.length });
});

// Get single draft
draftsRouter.get("/:id", async (req: AuthRequest, res) => {
  try {
    const draft = await prisma.tweetDraft.findFirst({
      where: { id: req.params.id as string, userId: req.userId },
    });
    if (!draft) return res.status(404).json(buildErrorResponse(req, "Draft not found"));
    res.json({ draft });
  } catch (err: any) {
    res.status(500).json(buildErrorResponse(req, "Failed to get draft"));
  }
});

// Create draft (manual or from content source)
draftsRouter.post("/", async (req: AuthRequest, res) => {
  try {
    const body = createDraftSchema.parse(req.body);
    const { content, sourceType, sourceContent, blendId } = body;

    const draft = await prisma.tweetDraft.create({
      data: {
        userId: req.userId!,
        content,
        sourceType,
        sourceContent,
        blendId,
      },
    });

    await prisma.analyticsEvent.create({
      data: { userId: req.userId!, type: "DRAFT_CREATED" },
    });

    res.json({ draft });
  } catch (err: any) {
    res.status(500).json(buildErrorResponse(req, "Failed to create draft"));
  }
});

// Update draft (edit content, submit feedback, change status)
draftsRouter.patch("/:id", async (req: AuthRequest, res) => {
  try {
    const { content, status, feedback } = updateDraftSchema.parse(req.body);

    const existing = await prisma.tweetDraft.findFirst({
      where: { id: req.params.id as string, userId: req.userId },
    });
    if (!existing) return res.status(404).json(buildErrorResponse(req, "Draft not found"));

    const draft = await prisma.tweetDraft.update({
      where: { id: req.params.id as string },
      data: {
        ...(content && { content }),
        ...(status && { status }),
        ...(feedback && { feedback }),
      },
    });

    if (feedback) {
      await prisma.analyticsEvent.create({
        data: { userId: req.userId!, type: "FEEDBACK_GIVEN" },
      });
    }

    if (status === "POSTED") {
      await prisma.analyticsEvent.create({
        data: { userId: req.userId!, type: "DRAFT_POSTED" },
      });
    }

    res.json({ draft });
  } catch (err: any) {
    res.status(500).json(buildErrorResponse(req, "Failed to update draft"));
  }
});

// Delete draft
draftsRouter.delete("/:id", async (req: AuthRequest, res) => {
  try {
    const existing = await prisma.tweetDraft.findFirst({
      where: { id: req.params.id as string, userId: req.userId },
    });
    if (!existing) return res.status(404).json(buildErrorResponse(req, "Draft not found"));

    await prisma.tweetDraft.delete({ where: { id: req.params.id as string } });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json(buildErrorResponse(req, "Failed to delete draft"));
  }
});

// Record actual engagement metrics (post-publish feedback loop)
draftsRouter.post("/:id/engagement", async (req: AuthRequest, res) => {
  try {
    const body = engagementSchema.parse(req.body);

    const draft = await prisma.tweetDraft.findFirst({
      where: { id: req.params.id as string, userId: req.userId },
    });
    if (!draft) return res.status(404).json(buildErrorResponse(req, "Draft not found"));

    if (draft.status !== "POSTED") {
      return res
        .status(400)
        .json(buildErrorResponse(req, "Can only record engagement on posted drafts"));
    }

    const updated = await prisma.tweetDraft.update({
      where: { id: draft.id },
      data: {
        actualEngagement: body.impressions,
        engagementMetrics: {
          likes: body.likes,
          retweets: body.retweets,
          impressions: body.impressions,
        },
      },
    });

    await prisma.analyticsEvent.create({
      data: {
        userId: req.userId!,
        type: "ENGAGEMENT_RECORDED",
        value: body.impressions,
        metadata: {
          draftId: draft.id,
          likes: body.likes,
          retweets: body.retweets,
          impressions: body.impressions,
        },
      },
    });

    res.json({ draft: updated });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    res
      .status(500)
      .json(buildErrorResponse(req, "Failed to record engagement"));
  }
});
