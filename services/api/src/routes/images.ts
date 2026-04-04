import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { config } from "../lib/config";
import { error, success } from "../lib/response";
import { authenticate, AuthRequest } from "../middleware/auth";
import { generateVisualConcept, ImageStyle } from "../lib/gemini";
import { logger } from "../lib/logger";

export const imagesRouter = Router();
imagesRouter.use(authenticate);

const generateSchema = z.object({
  prompt: z.string().min(1).max(5000),
  style: z.enum(["infographic", "quote_card", "avatar", "thumbnail"]).default("quote_card"),
});

const generateForDraftSchema = z.object({
  draftId: z.string().min(1),
  style: z.enum(["infographic", "quote_card", "avatar", "thumbnail"]).default("quote_card"),
});

// Standalone image concept generation
imagesRouter.post("/generate", async (req: AuthRequest, res) => {
  try {
    if (!config.GOOGLE_AI_API_KEY) {
      return res.status(503).json(error("Image generation is not configured — GOOGLE_AI_API_KEY missing", 503));
    }

    const body = generateSchema.parse(req.body);

    const concept = await generateVisualConcept(body.prompt, body.style as ImageStyle);

    // Persist
    const image = await prisma.generatedImage.create({
      data: {
        userId: req.userId!,
        prompt: body.prompt,
        style: body.style,
        imageUrl: JSON.stringify(concept), // Store concept as JSON
        mimeType: "application/json",
      },
    });

    // Log analytics
    await prisma.analyticsEvent.create({
      data: { userId: req.userId!, type: "IMAGE_GENERATED" },
    });

    res.json(success({ image: { ...image, concept } }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    logger.error({ err: err.message, stack: err.stack }, "Image generation failed");
    res.status(502).json(error("Image generation failed"));
  }
});

// Generate companion visual for an existing draft
imagesRouter.post("/generate-for-draft", async (req: AuthRequest, res) => {
  try {
    if (!config.GOOGLE_AI_API_KEY) {
      return res.status(503).json(error("Image generation is not configured — GOOGLE_AI_API_KEY missing", 503));
    }

    const body = generateForDraftSchema.parse(req.body);

    // Fetch the draft
    const draft = await prisma.tweetDraft.findFirst({
      where: { id: body.draftId, userId: req.userId },
    });
    if (!draft) return res.status(404).json(error("Draft not found"));

    const concept = await generateVisualConcept(draft.content, body.style as ImageStyle);

    // Persist linked to draft
    const image = await prisma.generatedImage.create({
      data: {
        userId: req.userId!,
        draftId: draft.id,
        prompt: draft.content,
        style: body.style,
        imageUrl: JSON.stringify(concept),
        mimeType: "application/json",
      },
    });

    // Log analytics
    await prisma.analyticsEvent.create({
      data: { userId: req.userId!, type: "IMAGE_GENERATED" },
    });

    res.json(success({ image: { ...image, concept } }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    logger.error({ err: err.message, stack: err.stack }, "Image generation failed");
    res.status(502).json(error("Image generation failed"));
  }
});

// Get images for a draft
imagesRouter.get("/for-draft/:draftId", async (req: AuthRequest, res) => {
  try {
    const images = await prisma.generatedImage.findMany({
      where: { draftId: req.params.draftId as string, userId: req.userId! },
      orderBy: { createdAt: "desc" },
    });
    res.json(success({ images }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to load images");
    res.status(500).json(error("Failed to load images", 500, { message: err.message }));
  }
});
