import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { generateTweet } from "../lib/generate";
import { conductResearch } from "../lib/research";

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

// Generate a tweet from source content using AI
draftsRouter.post("/generate", async (req: AuthRequest, res) => {
  try {
    const body = generateSchema.parse(req.body);

    // Fetch user's voice profile
    const voiceProfile = await prisma.voiceProfile.findUnique({
      where: { userId: req.userId! },
    });
    if (!voiceProfile) {
      return res.status(400).json({ error: "Voice profile not found. Complete onboarding first." });
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
      return res.status(400).json({ error: "Invalid request", details: err.errors });
    }
    console.error("Generate failed:", err.message);
    res.status(502).json({ error: "AI generation failed", message: err.message });
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
    if (!existing) return res.status(404).json({ error: "Draft not found" });
    if (!existing.sourceContent) {
      return res.status(400).json({ error: "Cannot regenerate a manual draft without source content" });
    }

    // Fetch voice profile
    const voiceProfile = await prisma.voiceProfile.findUnique({
      where: { userId: req.userId! },
    });
    if (!voiceProfile) {
      return res.status(400).json({ error: "Voice profile not found" });
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
      return res.status(400).json({ error: "Invalid request", details: err.errors });
    }
    console.error("Regenerate failed:", err.message);
    res.status(502).json({ error: "AI generation failed", message: err.message });
  }
});

// --- Standard CRUD Endpoints ---

// List drafts
draftsRouter.get("/", async (req: AuthRequest, res) => {
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
});

// Get single draft
draftsRouter.get("/:id", async (req: AuthRequest, res) => {
  const draft = await prisma.tweetDraft.findFirst({
    where: { id: req.params.id as string, userId: req.userId },
  });
  if (!draft) return res.status(404).json({ error: "Draft not found" });
  res.json({ draft });
});

// Create draft (manual or from content source)
draftsRouter.post("/", async (req: AuthRequest, res) => {
  const { content, sourceType, sourceContent, blendId } = req.body;
  if (!content) return res.status(400).json({ error: "Content is required" });

  const draft = await prisma.tweetDraft.create({
    data: {
      userId: req.userId!,
      content,
      sourceType,
      sourceContent,
      blendId,
    },
  });

  // Log analytics event
  await prisma.analyticsEvent.create({
    data: { userId: req.userId!, type: "DRAFT_CREATED" },
  });

  res.json({ draft });
});

// Update draft (edit content, submit feedback, change status)
draftsRouter.patch("/:id", async (req: AuthRequest, res) => {
  const { content, status, feedback } = req.body;

  const existing = await prisma.tweetDraft.findFirst({
    where: { id: req.params.id as string, userId: req.userId },
  });
  if (!existing) return res.status(404).json({ error: "Draft not found" });

  const draft = await prisma.tweetDraft.update({
    where: { id: req.params.id as string },
    data: {
      ...(content && { content }),
      ...(status && { status }),
      ...(feedback && { feedback }),
    },
  });

  // Log feedback event
  if (feedback) {
    await prisma.analyticsEvent.create({
      data: { userId: req.userId!, type: "FEEDBACK_GIVEN" },
    });
  }

  // Log post event
  if (status === "POSTED") {
    await prisma.analyticsEvent.create({
      data: { userId: req.userId!, type: "DRAFT_POSTED" },
    });
  }

  res.json({ draft });
});

// Delete draft
draftsRouter.delete("/:id", async (req: AuthRequest, res) => {
  const existing = await prisma.tweetDraft.findFirst({
    where: { id: req.params.id as string, userId: req.userId },
  });
  if (!existing) return res.status(404).json({ error: "Draft not found" });

  await prisma.tweetDraft.delete({ where: { id: req.params.id as string } });
  res.json({ success: true });
});
