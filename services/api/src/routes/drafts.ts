import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { runGenerationPipeline } from "../lib/pipeline";
import { buildErrorResponse } from "../middleware/requestId";
import { logger } from "../lib/logger";
import { withTimeout, TimeoutError } from "../lib/timeout";
import { success } from "../lib/response";
import { generateSchedule, applySchedule } from "../lib/scheduling";
import { extractInsights } from "../lib/content-extraction";
import { batchGenerateDrafts } from "../lib/batch-generate";
import { config } from "../lib/config";
import { rateLimitByUser } from "../middleware/rateLimit";
import { emptyBodySchema, validationFailResponse } from "../lib/schemas";
import {
  buildTokenWrite,
  readAccessToken,
  readRefreshToken,
  TOKEN_READ_SELECT,
} from "../lib/crypto";

export const draftsRouter = Router();
draftsRouter.use(authenticate);
const aiGenerationLimiter = rateLimitByUser(
  config.RATE_LIMIT_AI_GENERATION_MAX_REQUESTS,
  config.RATE_LIMIT_AI_GENERATION_WINDOW_MS,
);

// --- AI Generation Endpoints (must be before /:id routes) ---

const generateSchema = z.object({
  sourceContent: z.string().min(1).max(100000),
  sourceType: z.enum(["REPORT", "ARTICLE", "TWEET", "TRENDING_TOPIC", "VOICE_NOTE", "MANUAL"]),
  blendId: z.string().optional(),
  replyAngle: z.enum(["Direct", "Curious", "Concise"]).optional(),
  angleInstruction: z.string().max(500).optional(),
});

const batchFromContentSchema = z.object({
  content: z.string().min(50, "Content must be at least 50 characters").max(100000),
  sourceType: z.enum(["REPORT", "ARTICLE"]),
  sourceUrl: z.string().optional(),
  createCampaign: z.boolean().optional(),
  campaignTitle: z.string().max(200).optional(),
  angles: z.number().int().min(1).max(10).optional(),
  tone: z.string().min(1).max(50).optional(),
});

const refineSchema = z.object({
  instruction: z.string().min(1).max(1000),
});

const regenerateSchema = z.object({
  feedback: z.string().max(1000).optional(),
});

const engagementSchema = z.object({
  likes: z.number().int().min(0),
  retweets: z.number().int().min(0),
  replies: z.number().int().min(0),
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
draftsRouter.post("/generate", aiGenerationLimiter, async (req: AuthRequest, res) => {
  try {
    const body = generateSchema.parse(req.body);

    // Anthropic-backed draft generation needs Railway RAILWAY_SERVICE_TIMEOUT=90000 in deploys.
    // Keep this route timeout aligned so the request can use the full 90s budget.
    const result = await withTimeout(
      runGenerationPipeline({
        userId: req.userId!,
        sourceContent: body.sourceContent,
        sourceType: body.sourceType,
        blendId: body.blendId,
        replyAngle: body.replyAngle,
        angleInstruction: body.angleInstruction,
      }),
      90_000,
      "generate-pipeline",
    );

    // Save as draft (include voice dimension snapshot for feedback loop)
    const draft = await prisma.tweetDraft.create({
      data: {
        userId: req.userId!,
        content: result.ctx.generatedContent!,
        sourceType: body.sourceType,
        sourceContent: body.sourceContent,
        blendId: body.blendId,
        confidence: result.ctx.confidence,
        predictedEngagement: result.ctx.predictedEngagement,
        voiceDimensionsSnapshot: result.ctx.finalVoiceDimensions
          ? (result.ctx.finalVoiceDimensions as any)
          : undefined,
        version: 1,
      },
    });

    // Log analytics
    await prisma.analyticsEvent.create({
      data: { userId: req.userId!, type: "DRAFT_CREATED" },
    });

    const blendWarning = result.ctx.blendWarning === "blend_not_found" ? "blend_not_found" : undefined;
    res.json(success({ draft, ...(blendWarning ? { blendWarning } : {}) }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    if (err instanceof TimeoutError) {
      logger.warn({ err: err.message }, "Generate timed out");
      return res
        .status(504)
        .json(buildErrorResponse(req, "Generation timed out — please try again"));
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

    // Anthropic-backed regeneration needs Railway RAILWAY_SERVICE_TIMEOUT=90000 in deploys.
    // Keep this route timeout aligned so the request can use the full 90s budget.
    const result = await withTimeout(
      runGenerationPipeline({
        userId: req.userId!,
        sourceContent: existing.sourceContent,
        sourceType: existing.sourceType || "MANUAL",
        blendId: existing.blendId || undefined,
        feedback: body.feedback || existing.feedback || undefined,
      }),
      90_000,
      "regenerate-pipeline",
    );

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
        voiceDimensionsSnapshot: result.ctx.finalVoiceDimensions
          ? (result.ctx.finalVoiceDimensions as any)
          : undefined,
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

    const blendWarning = result.ctx.blendWarning === "blend_not_found" ? "blend_not_found" : undefined;
    res.json(success({ draft, ...(blendWarning ? { blendWarning } : {}) }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    if (err instanceof TimeoutError) {
      logger.warn({ err: err.message }, "Regenerate timed out");
      return res
        .status(504)
        .json(buildErrorResponse(req, "Generation timed out — please try again"));
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

// Batch generate drafts from long-form content (PDF/article)
draftsRouter.post("/batch-from-content", async (req: AuthRequest, res) => {
  try {
    const body = batchFromContentSchema.parse(req.body);

    const insights = await extractInsights(body.content, { limit: body.angles });
    const result = await batchGenerateDrafts({
      userId: req.userId!,
      insights,
      sourceContent: body.content,
      sourceType: body.sourceType,
      sourceUrl: body.sourceUrl,
      tone: body.tone,
      createCampaign: body.createCampaign,
      campaignTitle: body.campaignTitle,
    });

    res.json(success({ insights, drafts: result.drafts, campaign: result.campaign }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    if (err.message?.includes("too short") || err.message?.includes("minimum 50")) {
      return res.status(400).json(buildErrorResponse(req, err.message));
    }
    if (err.message?.includes("Voice profile not found")) {
      return res.status(400).json(buildErrorResponse(req, err.message));
    }
    logger.error({ err: err.message }, "Batch generation failed");
    res.status(502).json(buildErrorResponse(req, "Batch generation failed"));
  }
});

// Refine a draft with a custom instruction
draftsRouter.post("/:id/refine", async (req: AuthRequest, res) => {
  try {
    const body = refineSchema.parse(req.body);

    const existing = await prisma.tweetDraft.findFirst({
      where: { id: req.params.id as string, userId: req.userId },
    });
    if (!existing) return res.status(404).json(buildErrorResponse(req, "Draft not found"));

    // Build refined content: use the existing draft as source, instruction as feedback
    const refinedSource = `Original draft: "${existing.content}"\n\nRefinement instruction: ${body.instruction}`;

    // Anthropic-backed refinement needs Railway RAILWAY_SERVICE_TIMEOUT=90000 in deploys.
    const result = await withTimeout(
      runGenerationPipeline({
        userId: req.userId!,
        sourceContent: refinedSource,
        sourceType: "MANUAL",
        blendId: existing.blendId || undefined,
        feedback: body.instruction,
      }),
      90_000,
      "refine-pipeline",
    );

    const draft = await prisma.tweetDraft.create({
      data: {
        userId: req.userId!,
        content: result.ctx.generatedContent!,
        sourceType: existing.sourceType,
        sourceContent: existing.sourceContent,
        blendId: existing.blendId,
        confidence: result.ctx.confidence,
        predictedEngagement: result.ctx.predictedEngagement,
        voiceDimensionsSnapshot: result.ctx.finalVoiceDimensions
          ? (result.ctx.finalVoiceDimensions as any)
          : undefined,
        version: existing.version + 1,
        feedback: body.instruction,
      },
    });

    await prisma.analyticsEvent.create({
      data: { userId: req.userId!, type: "DRAFT_CREATED" },
    });
    await prisma.analyticsEvent.create({
      data: { userId: req.userId!, type: "FEEDBACK_GIVEN" },
    });

    const blendWarning = result.ctx.blendWarning === "blend_not_found" ? "blend_not_found" : undefined;
    res.json(success({ draft, ...(blendWarning ? { blendWarning } : {}) }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    if (err instanceof TimeoutError) {
      return res.status(504).json(buildErrorResponse(req, "Refinement timed out — please try again"));
    }
    if (err.message?.includes("Voice profile not found")) {
      return res.status(400).json(buildErrorResponse(req, err.message));
    }
    logger.error({ err: err.message }, "Refine failed");
    res.status(502).json(buildErrorResponse(req, "AI refinement failed"));
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

    res.json(success({ drafts }));
  } catch (err: any) {
    res.status(500).json(buildErrorResponse(req, "Failed to load drafts"));
  }
});

// Smart queue — drafts ranked by posting priority with suggested times
draftsRouter.get("/queue", async (req: AuthRequest, res) => {
  try {
    const drafts = await prisma.tweetDraft.findMany({
      where: {
        userId: req.userId,
        status: { in: ["DRAFT", "APPROVED", "SCHEDULED"] },
      },
      orderBy: { createdAt: "desc" },
    });

    const now = Date.now();
    const scored = drafts.map((draft) => {
      let score = 0;

      // Status priority
      if (draft.status === "SCHEDULED") score += 40;
      else if (draft.status === "APPROVED") score += 25;
      else score += 10;

      // Engagement prediction (0-20)
      if (draft.predictedEngagement) {
        score += Math.min(20, draft.predictedEngagement / 500);
      }

      // Confidence (0-15)
      if (draft.confidence) {
        score += draft.confidence * 15;
      }

      // Topic freshness — trending decays fast, reports slower
      const ageHours = (now - draft.createdAt.getTime()) / (1000 * 60 * 60);
      if (draft.sourceType === "TRENDING_TOPIC") {
        score += Math.max(0, 20 - ageHours * 3);
      } else if (draft.sourceType === "REPORT" || draft.sourceType === "ARTICLE") {
        score += Math.max(0, 10 - ageHours * 0.2);
      } else {
        score += Math.max(0, 10 - ageHours * 0.5);
      }

      return { ...draft, _score: Math.round(score * 10) / 10 };
    });

    // Manual sortOrder takes priority over algorithm score
    scored.sort((a, b) => {
      if (a.sortOrder != null && b.sortOrder != null) return a.sortOrder - b.sortOrder;
      if (a.sortOrder != null) return -1;
      if (b.sortOrder != null) return 1;
      return b._score - a._score;
    });

    // Suggest posting slots at crypto twitter peak hours (ET)
    const peakSlots = [9, 10, 13, 14, 19, 20];
    const etOffset = -4;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const queue = scored.map((draft, index) => {
      if (draft.scheduledAt) {
        return { ...draft, suggestedAt: draft.scheduledAt.toISOString() };
      }

      const dayOffset = Math.floor(index / peakSlots.length);
      const slotIndex = index % peakSlots.length;
      const slotHourUTC = peakSlots[slotIndex] - etOffset;

      const suggestedDate = new Date(today);
      suggestedDate.setUTCDate(suggestedDate.getUTCDate() + dayOffset);
      suggestedDate.setUTCHours(slotHourUTC, 0, 0, 0);

      if (suggestedDate.getTime() < now) {
        suggestedDate.setUTCDate(suggestedDate.getUTCDate() + 1);
      }

      return { ...draft, suggestedAt: suggestedDate.toISOString() };
    });

    res.json(success({ queue, total: queue.length, nextUp: queue[0] || null }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to load queue");
    res.status(500).json(buildErrorResponse(req, "Failed to load queue"));
  }
});

// Enqueue a draft — mark as APPROVED and ready for the queue
draftsRouter.post("/:id/enqueue", async (req: AuthRequest, res) => {
  const parsed = emptyBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(validationFailResponse(parsed.error));
  }
  try {
    const draft = await prisma.tweetDraft.findFirst({
      where: { id: req.params.id as string, userId: req.userId },
    });
    if (!draft) return res.status(404).json(buildErrorResponse(req, "Draft not found"));

    const updated = await prisma.tweetDraft.update({
      where: { id: draft.id },
      data: { status: "APPROVED" },
    });

    res.json(success({ draft: updated }));
  } catch (err: any) {
    res.status(500).json(buildErrorResponse(req, "Failed to enqueue draft"));
  }
});

// List team drafts (APPROVED + POSTED) — visible to all authenticated users
draftsRouter.get("/team", async (req: AuthRequest, res) => {
  try {
    const { limit = "50", offset = "0" } = req.query;

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

    res.json(success({ drafts: result, total: result.length }));
  } catch (err: any) {
    res.status(500).json(buildErrorResponse(req, "Failed to load team drafts"));
  }
});

// Get single draft
draftsRouter.get("/:id", async (req: AuthRequest, res) => {
  try {
    const draft = await prisma.tweetDraft.findFirst({
      where: { id: req.params.id as string, userId: req.userId },
    });
    if (!draft) return res.status(404).json(buildErrorResponse(req, "Draft not found"));
    res.json(success({ draft }));
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

    res.json(success({ draft }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
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

    res.json(success({ draft }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
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
    res.json(success({ success: true }));
  } catch (err: any) {
    res.status(500).json(buildErrorResponse(req, "Failed to delete draft"));
  }
});

// Auto-fetch metrics from X for a posted draft
draftsRouter.post("/:id/fetch-metrics", authenticate, async (req: AuthRequest, res) => {
  const parsed = emptyBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(validationFailResponse(parsed.error));
  }
  try {
    const draftId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const draft = await prisma.tweetDraft.findUnique({ where: { id: draftId } });
    if (!draft || draft.userId !== req.userId!) {
      return res.status(404).json(buildErrorResponse(req, "Draft not found"));
    }
    if (!draft.xTweetId) {
      return res.status(400).json(buildErrorResponse(req, "No X tweet ID — draft was not posted via Atlas"));
    }

    const { getTweetsWithMetrics } = await import("../lib/twitter");
    const metrics = await getTweetsWithMetrics([draft.xTweetId]);
    const m = metrics[0]?.public_metrics;
    if (!m) {
      return res.status(502).json(buildErrorResponse(req, "Could not fetch metrics from X"));
    }

    const updated = await prisma.tweetDraft.update({
      where: { id: draftId },
      data: {
        actualEngagement: m.impression_count,
        engagementMetrics: {
          likes: m.like_count,
          retweets: m.retweet_count,
          replies: m.reply_count,
          impressions: m.impression_count,
          bookmarks: m.bookmark_count,
        },
        metricsLastFetchedAt: new Date(),
      },
    });

    res.json(success({ draft: updated }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to fetch metrics from X");
    res.status(502).json(buildErrorResponse(req, `Failed to fetch metrics: ${err.message}`));
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
          replies: body.replies,
          impressions: body.impressions,
        },
        metricsLastFetchedAt: new Date(),
      },
    });

    await prisma.analyticsEvent.create({
      data: {
        userId: req.userId!,
        type: "ENGAGEMENT_UPDATED",
        value: body.impressions,
        metadata: {
          draftId: draft.id,
          likes: body.likes,
          retweets: body.retweets,
          replies: body.replies,
          impressions: body.impressions,
        },
      },
    });

    res.json(success({ draft: updated }));
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

// Performance breakdown for a posted draft (predicted vs actual + percentile)
draftsRouter.get("/:id/performance", authenticate, async (req: AuthRequest, res) => {
  try {
    const draftId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const draft = await prisma.tweetDraft.findFirst({
      where: { id: draftId, userId: req.userId! },
    });
    if (!draft) {
      return res.status(404).json(buildErrorResponse(req, "Draft not found"));
    }

    const predicted = draft.predictedEngagement ?? 0;
    const actual = draft.actualEngagement ?? 0;
    const deltaPct = predicted > 0 ? ((actual - predicted) / predicted) * 100 : 0;

    // Percentile: what % of this user's posted drafts does this one beat?
    const allPosted = await prisma.tweetDraft.findMany({
      where: { userId: req.userId!, status: "POSTED", actualEngagement: { not: null } },
      select: { id: true, actualEngagement: true },
    });

    let percentile = 0;
    if (allPosted.length > 1 && actual > 0) {
      const below = allPosted.filter(
        (d) => (d.actualEngagement ?? 0) < actual
      ).length;
      percentile = Math.round((below / (allPosted.length - 1)) * 100);
    } else if (allPosted.length === 1) {
      percentile = 50;
    }

    const em = (draft.engagementMetrics ?? {}) as Record<string, number>;

    res.json(success({
      performance: {
        predicted,
        actual,
        deltaPct: Math.round(deltaPct * 10) / 10,
        percentile,
        metrics: {
          impressions: em.impressions ?? actual,
          likes: em.likes ?? 0,
          retweets: em.retweets ?? 0,
          replies: em.replies ?? 0,
          bookmarks: em.bookmarks ?? 0,
        },
      },
    }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to compute draft performance");
    res.status(500).json(buildErrorResponse(req, "Failed to compute performance"));
  }
});

// Split a draft into a numbered thread
draftsRouter.post("/:id/thread", authenticate, async (req: AuthRequest, res) => {
  const parsed = emptyBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(validationFailResponse(parsed.error));
  }
  try {
    const draftId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const draft = await prisma.tweetDraft.findUnique({
      where: { id: draftId },
    });
    if (!draft || draft.userId !== req.userId!) {
      return res.status(404).json(buildErrorResponse(req, "Draft not found"));
    }

    const sentences = draft.content.split(/(?<=[.!?])\s+/).filter(Boolean);
    const tweets: string[] = [];
    let current = "";

    for (const sentence of sentences) {
      if ((current + " " + sentence).trim().length > 270) {
        if (current) tweets.push(current.trim());
        current = sentence;
      } else {
        current = current ? current + " " + sentence : sentence;
      }
    }
    if (current) tweets.push(current.trim());

    const total = tweets.length;
    const thread = tweets.map((text, i) => `${i + 1}/${total} ${text}`);

    res.json(success({ thread, count: total }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to create thread");
    res.status(500).json(buildErrorResponse(req, "Failed to create thread"));
  }
});

// Post a draft to X (accepts both /post and /post-to-x for backwards compat)
draftsRouter.post("/:id/post", authenticate, async (req: AuthRequest, res) => {
  const parsed = emptyBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(validationFailResponse(parsed.error));
  }
  try {
    const { postTweet, refreshAccessToken } = await import("../lib/twitter");

    const draftId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const draft = await prisma.tweetDraft.findUnique({ where: { id: draftId } });
    if (!draft || draft.userId !== req.userId!) {
      return res.status(404).json(buildErrorResponse(req, "Draft not found"));
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { ...TOKEN_READ_SELECT, xTokenExpiresAt: true },
    });

    let accessToken = readAccessToken(user);
    if (!accessToken) {
      return res.status(400).json(buildErrorResponse(req, "X account not linked. Connect your X account first."));
    }

    // Refresh token if expired
    const currentRefreshToken = readRefreshToken(user);
    if (user?.xTokenExpiresAt && user.xTokenExpiresAt < new Date() && currentRefreshToken) {
      const refreshed = await refreshAccessToken(currentRefreshToken);
      accessToken = refreshed.accessToken;
      await prisma.user.update({
        where: { id: req.userId! },
        data: buildTokenWrite({
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
        }),
      });
    }

    // Post to X
    const tweet = await postTweet(accessToken, draft.content);

    // Update draft status + store tweet ID for metric auto-pull
    const updated = await prisma.tweetDraft.update({
      where: { id: draftId },
      data: { status: "POSTED", xTweetId: tweet.id },
    });

    // Log analytics
    await prisma.analyticsEvent.create({
      data: { userId: req.userId!, type: "DRAFT_POSTED", metadata: { tweetId: tweet.id, draftId } },
    });

    logger.info({ userId: req.userId, tweetId: tweet.id, draftId }, "Draft posted to X");
    res.json(success({ draft: updated, tweet: { id: tweet.id, text: tweet.text } }));
  } catch (err: any) {
    logger.error({ err: err.message, stack: err.stack }, "Failed to post to X");
    res.status(502).json(buildErrorResponse(req, `Failed to post to X: ${err.message}`));
  }
});

// Schedule a draft for future posting
const scheduleSchema = z.object({
  scheduledAt: z.string().datetime(),
});

draftsRouter.post("/:id/schedule", authenticate, async (req: AuthRequest, res) => {
  try {
    const body = scheduleSchema.parse(req.body);
    const scheduledDate = new Date(body.scheduledAt);

    if (scheduledDate <= new Date()) {
      return res.status(400).json(buildErrorResponse(req, "Scheduled time must be in the future"));
    }

    const draft = await prisma.tweetDraft.findFirst({
      where: { id: req.params.id as string, userId: req.userId },
    });
    if (!draft) return res.status(404).json(buildErrorResponse(req, "Draft not found"));

    // Check for scheduling conflicts (within 90 minutes)
    const CONFLICT_WINDOW_MS = 90 * 60 * 1000;
    const scheduleTime = new Date(body.scheduledAt).getTime();
    const nearbyDrafts = await prisma.tweetDraft.findMany({
      where: {
        userId: req.userId!,
        status: "SCHEDULED",
        id: { not: draft.id },
        scheduledAt: {
          gte: new Date(scheduleTime - CONFLICT_WINDOW_MS),
          lte: new Date(scheduleTime + CONFLICT_WINDOW_MS),
        },
      },
      select: { id: true, content: true, scheduledAt: true },
    });

    const updated = await prisma.tweetDraft.update({
      where: { id: draft.id },
      data: { status: "SCHEDULED", scheduledAt: scheduledDate },
    });

    await prisma.analyticsEvent.create({
      data: { userId: req.userId!, type: "DRAFT_CREATED", metadata: { scheduled: true } },
    });

    logger.info({ userId: req.userId, draftId: draft.id, scheduledAt: body.scheduledAt }, "Draft scheduled");
    res.json(success({
      draft: updated,
      conflicts: nearbyDrafts.map(d => ({
        id: d.id,
        content: d.content?.slice(0, 80),
        scheduledAt: d.scheduledAt,
      })),
    }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    logger.error({ err: err.message }, "Failed to schedule draft");
    res.status(500).json(buildErrorResponse(req, "Failed to schedule draft"));
  }
});

// Process scheduled drafts (called by cron or manually)
draftsRouter.post("/process-scheduled", authenticate, async (req: AuthRequest, res) => {
  const parsed = emptyBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(validationFailResponse(parsed.error));
  }
  try {
    const now = new Date();
    const dueDrafts = await prisma.tweetDraft.findMany({
      where: { status: "SCHEDULED", scheduledAt: { lte: now } },
      include: { user: { select: { id: true, xTokenExpiresAt: true, ...TOKEN_READ_SELECT } } },
    });

    if (dueDrafts.length === 0) {
      return res.json(success({ processed: 0, message: "No drafts due for posting" }));
    }

    const { postTweet, refreshAccessToken } = await import("../lib/twitter");
    let posted = 0;
    let failed = 0;

    for (const draft of dueDrafts) {
      try {
        let accessToken = readAccessToken(draft.user);
        if (!accessToken) {
          logger.warn({ draftId: draft.id, userId: draft.userId }, "Scheduled draft skipped — no X token");
          failed++;
          continue;
        }

        const draftRefreshToken = readRefreshToken(draft.user);
        if (draft.user.xTokenExpiresAt && draft.user.xTokenExpiresAt < now && draftRefreshToken) {
          const refreshed = await refreshAccessToken(draftRefreshToken);
          accessToken = refreshed.accessToken;
          await prisma.user.update({
            where: { id: draft.userId },
            data: buildTokenWrite({
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken,
              expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
            }),
          });
        }

        const tweet = await postTweet(accessToken, draft.content);
        await prisma.tweetDraft.update({
          where: { id: draft.id },
          data: { status: "POSTED" },
        });
        await prisma.analyticsEvent.create({
          data: { userId: draft.userId, type: "DRAFT_POSTED", metadata: { tweetId: tweet.id, scheduled: true } },
        });
        posted++;
      } catch (err: any) {
        logger.error({ err: err.message, draftId: draft.id }, "Failed to post scheduled draft");
        failed++;
      }
    }

    res.json(success({ processed: dueDrafts.length, posted, failed }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to process scheduled drafts");
    res.status(500).json(buildErrorResponse(req, "Failed to process scheduled drafts"));
  }
});

// Reorder queue — persist manual positions
const reorderSchema = z.object({
  orderedIds: z.array(z.string()).min(1),
});

draftsRouter.patch("/queue/reorder", authenticate, async (req: AuthRequest, res) => {
  try {
    const { orderedIds } = reorderSchema.parse(req.body);

    // Verify all drafts belong to this user
    const drafts = await prisma.tweetDraft.findMany({
      where: { id: { in: orderedIds }, userId: req.userId! },
      select: { id: true },
    });

    const ownedIds = new Set(drafts.map((d) => d.id));
    const validIds = orderedIds.filter((id) => ownedIds.has(id));

    // Update sortOrder for each draft in a transaction
    await prisma.$transaction(
      validIds.map((id, index) =>
        prisma.tweetDraft.update({
          where: { id },
          data: { sortOrder: index + 1 },
        })
      )
    );

    logger.info({ userId: req.userId, count: validIds.length }, "Queue reordered");
    res.json(success({ reordered: validIds.length }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    logger.error({ err: err.message }, "Failed to reorder queue");
    res.status(500).json(buildErrorResponse(req, "Failed to reorder queue"));
  }
});

// Reset queue to algorithm order
draftsRouter.post("/queue/reset-order", authenticate, async (req: AuthRequest, res) => {
  const parsed = emptyBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(validationFailResponse(parsed.error));
  }
  try {
    await prisma.tweetDraft.updateMany({
      where: { userId: req.userId!, sortOrder: { not: null } },
      data: { sortOrder: null },
    });

    logger.info({ userId: req.userId }, "Queue order reset to auto");
    res.json(success({ reset: true }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to reset queue order");
    res.status(500).json(buildErrorResponse(req, "Failed to reset queue order"));
  }
});

// --- Intelligent Schedule Endpoints ---

// Get recommended schedule for user's queued drafts
draftsRouter.get("/schedule", authenticate, async (req: AuthRequest, res) => {
  try {
    const { timezone = "America/New_York" } = req.query;

    const schedule = await generateSchedule(
      req.userId!,
      undefined,
      timezone as string,
    );

    res.json(success({
      schedule: schedule.slots,
      total: schedule.slots.length,
      generatedAt: schedule.generatedAt,
      timezone: schedule.timezone,
    }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to generate schedule");
    res.status(500).json(buildErrorResponse(req, "Failed to generate schedule"));
  }
});

// Apply recommended schedule — sets scheduledAt on each draft
const applyScheduleSchema = z.object({
  slots: z.array(z.object({
    draftId: z.string(),
    recommendedTime: z.string().datetime(),
  })).min(1),
});

draftsRouter.post("/schedule/apply", authenticate, async (req: AuthRequest, res) => {
  try {
    const body = applyScheduleSchema.parse(req.body);

    const result = await applySchedule(req.userId!, body.slots as Array<{draftId: string; recommendedTime: string}>);

    logger.info(
      { userId: req.userId, applied: result.applied, skipped: result.skipped },
      "Schedule applied",
    );

    res.json(success({
      applied: result.applied,
      skipped: result.skipped,
    }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    logger.error({ err: err.message }, "Failed to apply schedule");
    res.status(500).json(buildErrorResponse(req, "Failed to apply schedule"));
  }
});
