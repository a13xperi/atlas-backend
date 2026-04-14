import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { config } from "../lib/config";
import { error, success } from "../lib/response";
import { authenticate, AuthRequest } from "../middleware/auth";
import { rateLimitByUser } from "../middleware/rateLimit";
import { generateImage, generateVisualConcept, ImageStyle } from "../lib/gemini";
import { logger } from "../lib/logger";

export const imagesRouter: Router = Router();
imagesRouter.use(authenticate);

// Image generation (Gemini) is metered per-image. The general API limiter
// is too loose for this — apply the dedicated AI cost knob so demo users
// can't accidentally run a 1000-image render loop.
const aiGenerationLimiter = rateLimitByUser(
  config.RATE_LIMIT_AI_GENERATION_MAX_REQUESTS,
  config.RATE_LIMIT_AI_GENERATION_WINDOW_MS,
);

const generateSchema = z.object({
  prompt: z.string().min(1).max(5000),
  style: z.enum(["infographic", "quote_card", "avatar", "thumbnail"]).default("quote_card"),
});

const generateForDraftSchema = z.object({
  draftId: z.string().min(1),
  style: z.enum(["infographic", "quote_card", "avatar", "thumbnail"]).default("quote_card"),
});

const DEFAULT_COLOR_SCHEME = ["#4ecdc4", "#1a1a2e", "#2d3748"];
const LAYOUT_BY_STYLE: Record<ImageStyle, string> = {
  infographic: "chart-overlay",
  quote_card: "centered-quote",
  avatar: "minimal-gradient",
  thumbnail: "split-stat",
};

const ASPECT_RATIO_BY_STYLE: Record<ImageStyle, "1:1" | "16:9" | "4:5"> = {
  infographic: "16:9",
  quote_card: "4:5",
  avatar: "1:1",
  thumbnail: "16:9",
};

function buildFallbackConcept(prompt: string, style: ImageStyle) {
  const truncatedPrompt = prompt.trim().slice(0, 180);

  return {
    concept: truncatedPrompt
      ? `AI-generated ${style.replace("_", " ")} inspired by: ${truncatedPrompt}`
      : `AI-generated ${style.replace("_", " ")}`,
    colorScheme: DEFAULT_COLOR_SCHEME,
    layout: LAYOUT_BY_STYLE[style],
    elements: ["gradient background", "bold focal visual", "high-contrast composition"],
  };
}

function normalizeStoredImage<T extends { imageUrl: string; mimeType: string }>(image: T) {
  if (image.mimeType !== "application/json") {
    return image;
  }

  try {
    return {
      ...image,
      concept: JSON.parse(image.imageUrl),
    };
  } catch {
    return image;
  }
}

async function createImageRecord(userId: string, prompt: string, style: ImageStyle, draftId?: string) {
  const imageResult = await generateImage({
    content: prompt,
    style,
    aspectRatio: ASPECT_RATIO_BY_STYLE[style],
  });

  const conceptResult = await generateVisualConcept(prompt, style).catch((err: unknown) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), style },
      "Falling back to deterministic visual concept",
    );
    return buildFallbackConcept(prompt, style);
  });

  const imageUrl = `data:${imageResult.mimeType};base64,${imageResult.imageData}`;

  const image = await prisma.generatedImage.create({
    data: {
      userId,
      ...(draftId ? { draftId } : {}),
      prompt,
      style,
      imageUrl,
      mimeType: imageResult.mimeType,
    },
  });

  await prisma.analyticsEvent.create({
    data: { userId, type: "IMAGE_GENERATED" },
  });

  return {
    image: {
      ...image,
      concept: conceptResult,
    },
  };
}

// Standalone image concept generation
imagesRouter.post("/generate", aiGenerationLimiter, async (req: AuthRequest, res) => {
  try {
    if (!config.GOOGLE_AI_API_KEY) {
      return res.status(503).json(error("Image generation is not configured — GOOGLE_AI_API_KEY missing", 503));
    }

    const body = generateSchema.parse(req.body);
    const result = await createImageRecord(req.userId!, body.prompt, body.style as ImageStyle);

    res.json(success(result));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    logger.error({ err: err.message, stack: err.stack }, "Image generation failed");
    res.status(502).json(error("Image generation failed"));
  }
});

// Generate companion visual for an existing draft
imagesRouter.post("/generate-for-draft", aiGenerationLimiter, async (req: AuthRequest, res) => {
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

    const result = await createImageRecord(req.userId!, draft.content, body.style as ImageStyle, draft.id);

    res.json(success(result));
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
    res.json(success({ images: images.map(normalizeStoredImage) }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to load images");
    res.status(500).json(error("Failed to load images", 500, { message: err.message }));
  }
});
