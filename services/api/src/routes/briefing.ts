import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { error, success } from "../lib/response";
import { validationFailResponse } from "../lib/schemas";
import { authenticate, AuthRequest } from "../middleware/auth";
import { routeCompletion } from "../lib/providers/router";
import { logger } from "../lib/logger";
import { withTimeout } from "../lib/timeout";

const briefingRouter: Router = Router();
briefingRouter.use(authenticate);

const briefingPreferencesSchema = z.object({
  deliveryTime: z.string(),
  briefType: z.enum(["morning", "sector", "alpha", "competitor"]).optional(),
  topics: z.array(z.string()),
  sources: z.array(z.string()),
  channel: z.string(),
});

// ── Preferences ─────────────────────────────────────────────────

briefingRouter.get("/preferences", async (req: AuthRequest, res) => {
  try {
    const result = await prisma.briefingPreference.findUnique({
      where: { userId: req.userId! },
    });
    res.json(success({ preference: result || null }));
  } catch (err: any) {
    res.status(500).json(error("Failed to fetch briefing preferences"));
  }
});

briefingRouter.put("/preferences", async (req: AuthRequest, res) => {
  try {
    const body = briefingPreferencesSchema.parse(req.body);
    const result = await prisma.briefingPreference.upsert({
      where: { userId: req.userId! },
      create: {
        userId: req.userId!,
        deliveryTime: body.deliveryTime,
        ...(body.briefType !== undefined ? { briefType: body.briefType } : {}),
        topics: body.topics,
        sources: body.sources,
        channel: body.channel,
      },
      update: {
        deliveryTime: body.deliveryTime,
        ...(body.briefType !== undefined ? { briefType: body.briefType } : {}),
        topics: body.topics,
        sources: body.sources,
        channel: body.channel,
      },
    });
    res.json(success({ preference: result }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to save briefing preferences"));
  }
});

// ── Briefing History ────────────────────────────────────────────

briefingRouter.get("/history", async (req: AuthRequest, res) => {
  try {
    const briefings = await prisma.briefing.findMany({
      where: { userId: req.userId! },
      orderBy: { createdAt: "desc" },
      take: 14,
    });
    res.json(success({ briefings }));
  } catch (err: any) {
    res.status(500).json(error("Failed to load briefing history"));
  }
});

// ── Generate Briefing ───────────────────────────────────────────

const BRIEF_TYPE_PROMPTS: Record<string, { titlePrefix: string; focus: string }> = {
  morning: {
    titlePrefix: "Morning Brief",
    focus: "Generate a concise daily intelligence digest covering the latest developments.",
  },
  sector: {
    titlePrefix: "Sector Deep Dive",
    focus: "Generate a focused deep dive on one specific sector. Pick the most active sector from the topics list and go deep — on-chain metrics, protocol updates, governance votes, key figures.",
  },
  alpha: {
    titlePrefix: "Alpha Scan",
    focus: "Generate an alpha-focused scan. Find opportunities others are missing. Contrarian takes, undervalued narratives, emerging trends before they hit CT. Every bullet should be actionable.",
  },
  competitor: {
    titlePrefix: "Competitor Watch",
    focus: "Generate a competitor intelligence brief. What are the top CT accounts posting about? What narratives are gaining traction? What angles are underserved? Help the analyst find their unique take.",
  },
};

const generateBriefingSchema = z
  .object({
    briefType: z.enum(["morning", "sector", "alpha", "competitor"]).optional(),
  })
  .strict();

briefingRouter.post("/generate", async (req: AuthRequest, res) => {
  const parsed = generateBriefingSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(validationFailResponse(parsed.error));
  }
  try {
    const briefType = parsed.data.briefType ?? "morning";
    const typeConfig = BRIEF_TYPE_PROMPTS[briefType];

    const preferences = await prisma.briefingPreference.findUnique({
      where: { userId: req.userId! },
    });

    const topics = preferences?.topics ?? ["DeFi", "Macro"];
    const sources = preferences?.sources ?? ["X/Twitter", "News"];

    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const systemPrompt = `You are Atlas's briefing engine for crypto analysts.
${typeConfig.focus}

Output JSON with this exact structure:
{
  "title": "${typeConfig.titlePrefix} — [Day, Month Date]",
  "summary": "2-3 sentence executive summary of what matters today",
  "sections": [
    {
      "heading": "Section name",
      "emoji": "single emoji",
      "bullets": ["bullet 1", "bullet 2", "bullet 3"]
    }
  ]
}

Rules:
- 3-5 sections max
- 2-4 bullets per section
- Each bullet under 30 words
- Be specific — name projects, protocols, people
- Include actionable intel ("watch for...", "key level at...")
- Contrarian takes welcome
- No fluff, no disclaimers`;

    const userMessage = `Generate a ${typeConfig.titlePrefix.toLowerCase()} for ${today}.
Topics: ${topics.join(", ")}
Sources: ${sources.join(", ")}

Make it specific and actionable. Include at least one contrarian take.`;

    // Briefing generation can route through Anthropic, so Railway deploys need
    // RAILWAY_SERVICE_TIMEOUT=90000 even though this handler keeps a shorter app timeout.
    const response = await withTimeout(
      routeCompletion({
        taskType: "research",
        maxTokens: 800,
        temperature: 0.7,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      }),
      15_000,
      "briefing-generate",
    );

    let briefingData: { title: string; summary: string; sections: any[] };
    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      briefingData = JSON.parse(jsonMatch?.[0] ?? response.content);
    } catch {
      briefingData = {
        title: `Morning Brief — ${today}`,
        summary: response.content.slice(0, 200),
        sections: [{ heading: "Today's Intel", emoji: "📊", bullets: [response.content.slice(0, 100)] }],
      };
    }

    const briefing = await prisma.briefing.create({
      data: {
        userId: req.userId!,
        title: briefingData.title,
        summary: briefingData.summary,
        sections: briefingData.sections,
        topics,
        sources,
      },
    });

    logger.info(
      { userId: req.userId, provider: response.provider, latencyMs: response.latencyMs },
      "Briefing generated",
    );

    res.json(success({ briefing }));
  } catch (err: any) {
    logger.error({ error: err?.message }, "Briefing generation failed");
    res.status(500).json(error("Failed to generate briefing"));
  }
});

export default briefingRouter;
