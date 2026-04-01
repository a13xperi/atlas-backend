import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { generateTweet } from "../lib/generate";
import { conductResearch } from "../lib/research";
import { buildErrorResponse } from "../middleware/requestId";

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

// Generate a tweet from source content using AI
draftsRouter.post("/generate", async (req: AuthRequest, res) => {
  try {
    const body = generateSchema.parse(req.body);

    // Fetch user's voice profile
    const voiceProfile = await prisma.voiceProfile.findUnique({
      where: { userId: req.userId! },
    });
    if (!voiceProfile) {
      return res
        .status(400)
        .json(buildErrorResponse(req, "Voice profile not found. Complete onboarding first."));
    }

    // Fetch blend if provided
    let blendVoices: { label: string; percentage: number }[] | undefined;
    if (body.blendId) {
      const blend = await prisma.savedBlend.findFirst({
        where: { id: body.blendId, userId: req.userId! },
        include: { voices: { include: { referenceVoice: true } } },
      });
      if (blend) {
        blendVoices = blend.voices.map((v) => ({
          label: v.referenceVoice?.name || v.label,
          percentage: v.percentage,
        }));
      }
    }

    // Pre-tweet research enrichment (non-blocking — tweet still generates if research fails)
    let researchContext: string | undefined;
    try {
      const research = await conductResearch({
        query: body.sourceContent,
        context: body.sourceType,
      });
      researchContext = `Summary: ${research.summary}\nKey facts: ${research.keyFacts.join("; ")}\nSentiment: ${research.sentiment}`;
    } catch (e) {
      console.warn("Research enrichment skipped:", (e as Error).message);
    }

    // Generate the tweet
    const result = await generateTweet({
      voiceProfile: {
        humor: voiceProfile.humor,
        formality: voiceProfile.formality,
        brevity: voiceProfile.brevity,
        contrarianTone: voiceProfile.contrarianTone,
        maturity: voiceProfile.maturity,
      },
      sourceContent: body.sourceContent,
      sourceType: body.sourceType,
      blendVoices,
      researchContext,
    });

    // Save as draft
    const draft = await prisma.tweetDraft.create({
      data: {
        userId: req.userId!,
        content: result.content,
        sourceType: body.sourceType,
        sourceContent: body.sourceContent,
        blendId: body.blendId,
        confidence: result.confidence,
        predictedEngagement: result.predictedEngagement,
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
    console.error("Generate failed:", err.message);
    res.status(502).json(buildErrorResponse(req, "AI generation failed", { message: err.message }));
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

    // Fetch voice profile
    const voiceProfile = await prisma.voiceProfile.findUnique({
      where: { userId: req.userId! },
    });
    if (!voiceProfile) {
      return res.status(400).json(buildErrorResponse(req, "Voice profile not found"));
    }

    // Fetch blend if the original used one
    let blendVoices: { label: string; percentage: number }[] | undefined;
    if (existing.blendId) {
      const blend = await prisma.savedBlend.findFirst({
        where: { id: existing.blendId, userId: req.userId! },
        include: { voices: { include: { referenceVoice: true } } },
      });
      if (blend) {
        blendVoices = blend.voices.map((v) => ({
          label: v.referenceVoice?.name || v.label,
          percentage: v.percentage,
        }));
      }
    }

    // Generate new version
    const result = await generateTweet({
      voiceProfile: {
        humor: voiceProfile.humor,
        formality: voiceProfile.formality,
        brevity: voiceProfile.brevity,
        contrarianTone: voiceProfile.contrarianTone,
        maturity: voiceProfile.maturity,
      },
      sourceContent: existing.sourceContent,
      sourceType: existing.sourceType || "MANUAL",
      blendVoices,
      feedback: body.feedback || existing.feedback || undefined,
    });

    // Create new draft (preserves version history)
    const draft = await prisma.tweetDraft.create({
      data: {
        userId: req.userId!,
        content: result.content,
        sourceType: existing.sourceType,
        sourceContent: existing.sourceContent,
        blendId: existing.blendId,
        confidence: result.confidence,
        predictedEngagement: result.predictedEngagement,
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
    console.error("Regenerate failed:", err.message);
    res.status(502).json(buildErrorResponse(req, "AI generation failed", { message: err.message }));
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
    res.status(500).json(buildErrorResponse(req, "Failed to load drafts", { message: err.message }));
  }
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
    res.status(500).json(buildErrorResponse(req, "Failed to get draft", { message: err.message }));
  }
});

// Create draft (manual or from content source)
draftsRouter.post("/", async (req: AuthRequest, res) => {
  try {
    const { content, sourceType, sourceContent, blendId } = req.body;
    if (!content) return res.status(400).json(buildErrorResponse(req, "Content is required"));

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
    res.status(500).json(buildErrorResponse(req, "Failed to create draft", { message: err.message }));
  }
});

// Update draft (edit content, submit feedback, change status)
draftsRouter.patch("/:id", async (req: AuthRequest, res) => {
  try {
    const { content, status, feedback } = req.body;

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
    res.status(500).json(buildErrorResponse(req, "Failed to update draft", { message: err.message }));
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
    res.status(500).json(buildErrorResponse(req, "Failed to delete draft", { message: err.message }));
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
      .json(buildErrorResponse(req, "Failed to record engagement", { message: err.message }));
  }
});
