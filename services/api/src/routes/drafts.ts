import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { runGenerationPipeline } from "../lib/pipeline";
import { buildErrorResponse } from "../middleware/requestId";
import { logger } from "../lib/logger";
import { withTimeout, TimeoutError } from "../lib/timeout";
import { success } from "../lib/response";

export const draftsRouter = Router();
draftsRouter.use(authenticate);

// --- AI Generation Endpoints (must be before /:id routes) ---

const generateSchema = z.object({
  sourceContent: z.string().min(1).max(10000),
  sourceType: z.enum(["REPORT", "ARTICLE", "TWEET", "TRENDING_TOPIC", "VOICE_NOTE", "MANUAL"]),
  blendId: z.string().optional(),
  replyAngle: z.enum(["Direct", "Curious", "Concise"]).optional(),
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

    // Run generation pipeline with 90s route-level timeout (Railway limit is 120s)
    const result = await withTimeout(
      runGenerationPipeline({
        userId: req.userId!,
        sourceContent: body.sourceContent,
        sourceType: body.sourceType,
        blendId: body.blendId,
        replyAngle: body.replyAngle,
      }),
      90_000,
      "generate-pipeline",
    );

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

    res.json(success({ draft }));
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

    // Run generation pipeline with 90s route-level timeout
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

    res.json(success({ draft }));
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

    res.json(success({ draft }));
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

// List team drafts (APPROVED + POSTED) — MANAGER/ADMIN only
draftsRouter.get("/team", async (req: AuthRequest, res) => {
  try {
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

// Split a draft into a numbered thread
draftsRouter.post("/:id/thread", authenticate, async (req: AuthRequest, res) => {
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
  try {
    const { postTweet, refreshAccessToken } = await import("../lib/twitter");

    const draftId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const draft = await prisma.tweetDraft.findUnique({ where: { id: draftId } });
    if (!draft || draft.userId !== req.userId!) {
      return res.status(404).json(buildErrorResponse(req, "Draft not found"));
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { xAccessToken: true, xRefreshToken: true, xTokenExpiresAt: true },
    });

    if (!user?.xAccessToken) {
      return res.status(400).json(buildErrorResponse(req, "X account not linked. Connect your X account first."));
    }

    // Refresh token if expired
    let accessToken = user.xAccessToken;
    if (user.xTokenExpiresAt && user.xTokenExpiresAt < new Date() && user.xRefreshToken) {
      const refreshed = await refreshAccessToken(user.xRefreshToken);
      accessToken = refreshed.accessToken;
      await prisma.user.update({
        where: { id: req.userId! },
        data: {
          xAccessToken: refreshed.accessToken,
          xRefreshToken: refreshed.refreshToken,
          xTokenExpiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
        },
      });
    }

    // Post to X
    const tweet = await postTweet(accessToken, draft.content);

    // Update draft status
    const updated = await prisma.tweetDraft.update({
      where: { id: draftId },
      data: { status: "POSTED" },
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

    const updated = await prisma.tweetDraft.update({
      where: { id: draft.id },
      data: { status: "SCHEDULED", scheduledAt: scheduledDate },
    });

    await prisma.analyticsEvent.create({
      data: { userId: req.userId!, type: "DRAFT_CREATED", metadata: { scheduled: true } },
    });

    logger.info({ userId: req.userId, draftId: draft.id, scheduledAt: body.scheduledAt }, "Draft scheduled");
    res.json(success({ draft: updated }));
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
  try {
    const now = new Date();
    const dueDrafts = await prisma.tweetDraft.findMany({
      where: { status: "SCHEDULED", scheduledAt: { lte: now } },
      include: { user: { select: { id: true, xAccessToken: true, xRefreshToken: true, xTokenExpiresAt: true } } },
    });

    if (dueDrafts.length === 0) {
      return res.json(success({ processed: 0, message: "No drafts due for posting" }));
    }

    const { postTweet, refreshAccessToken } = await import("../lib/twitter");
    let posted = 0;
    let failed = 0;

    for (const draft of dueDrafts) {
      try {
        if (!draft.user.xAccessToken) {
          logger.warn({ draftId: draft.id, userId: draft.userId }, "Scheduled draft skipped — no X token");
          failed++;
          continue;
        }

        let accessToken = draft.user.xAccessToken;
        if (draft.user.xTokenExpiresAt && draft.user.xTokenExpiresAt < now && draft.user.xRefreshToken) {
          const refreshed = await refreshAccessToken(draft.user.xRefreshToken);
          accessToken = refreshed.accessToken;
          await prisma.user.update({
            where: { id: draft.userId },
            data: {
              xAccessToken: refreshed.accessToken,
              xRefreshToken: refreshed.refreshToken,
              xTokenExpiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
            },
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
