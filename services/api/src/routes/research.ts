import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { conductResearch } from "../lib/research";

export const researchRouter = Router();
researchRouter.use(authenticate);

const researchSchema = z.object({
  query: z.string().min(1).max(10000),
});

// Standalone research endpoint
researchRouter.post("/", async (req: AuthRequest, res) => {
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

    res.json({ result: { ...result, id: saved.id } });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request", details: err.errors });
    }
    console.error("Research failed:", err.message);
    res.status(502).json({ error: "Research failed", message: err.message });
  }
});

// Get recent research results
researchRouter.get("/history", async (req: AuthRequest, res) => {
  const results = await prisma.researchResult.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  res.json({ results });
});
