import { Router } from "express";
import { z } from "zod";
import { parsePagination } from "../lib/pagination";
import { prisma } from "../lib/prisma";
import { error, success } from "../lib/response";
import { authenticate, AuthRequest } from "../middleware/auth";
import { rateLimitByUser } from "../middleware/rateLimit";
import { config } from "../lib/config";
import { conductResearch } from "../lib/research";
import { logger } from "../lib/logger";

export const researchRouter = Router();
researchRouter.use(authenticate);

// Per-user rate limit for the Anthropic-backed research endpoint. Each
// call burns through tokens — without a per-user cap a single account
// can blow through the project's monthly LLM budget in minutes during
// a customer demo. Mirrors drafts.ts/aiGenerationLimiter so we get one
// knob in config (RATE_LIMIT_AI_GENERATION_*) for every AI cost path.
const aiGenerationLimiter = rateLimitByUser(
  config.RATE_LIMIT_AI_GENERATION_MAX_REQUESTS,
  config.RATE_LIMIT_AI_GENERATION_WINDOW_MS,
);

const researchSchema = z.object({
  query: z.string().min(1).max(100000),
});

// Standalone research endpoint
researchRouter.post("/", aiGenerationLimiter, async (req: AuthRequest, res) => {
  try {
    const body = researchSchema.parse(req.body);

    const result = await conductResearch({ query: body.query });

    // Persist research result
    const saved = await prisma.researchResult.create({
      data: {
        userId: req.userId!,
        query: body.query,
        summary: result.summary,
        keyFacts: result.keyFacts,
        sentiment: result.sentiment,
        relatedTopics: result.relatedTopics,
        sources: result.sources,
        confidence: result.confidence,
      },
    });

    // Log analytics
    await prisma.analyticsEvent.create({
      data: { userId: req.userId!, type: "RESEARCH_CONDUCTED" },
    });

    res.json(success({ result: { ...result, id: saved.id } }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    logger.error({ err: err.message }, "Research failed");
    res.status(502).json(error("Research failed"));
  }
});

// Get recent research results
researchRouter.get("/history", async (req: AuthRequest, res) => {
  try {
    const { take, skip } = parsePagination(req.query, { limit: 20, offset: 0 });

    const results = await prisma.researchResult.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: "desc" },
      take,
      skip,
    });
    res.json(success({ results }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to load research history");
    res.status(500).json(error("Failed to load research history", 500, { message: err.message }));
  }
});
