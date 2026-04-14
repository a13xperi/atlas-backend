import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { logger } from "../lib/logger";
import { success, error } from "../lib/response";
import { extractInsights } from "../lib/content-extraction";
import { batchGenerateDrafts } from "../lib/batch-generate";

export const campaignsRouter: Router = Router({ mergeParams: true });
campaignsRouter.use(authenticate);

function paramId(req: AuthRequest, name = "id"): string {
  return req.params[name] as string;
}

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  status: z.enum(["DRAFT", "ACTIVE", "COMPLETED", "PAUSED"]).optional(),
});

const generateSchema = z.object({
  contentId: z.string().min(1),
  angles: z.number().int().min(1).max(10).default(5),
  tone: z.string().min(1).max(50).default("professional"),
  userId: z.string().min(1),
});

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function truncate(value: string, max = 120): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 3).trimEnd()}...`;
}

async function resolveCampaignSourceContent(contentId: string, userId: string) {
  const researchResult = await prisma.researchResult.findFirst({
    where: { id: contentId, userId },
  });

  if (researchResult) {
    const keyFacts = readStringArray(researchResult.keyFacts);
    const relatedTopics = readStringArray(researchResult.relatedTopics);
    const sources = readStringArray(researchResult.sources);

    const content = [
      `Research query: ${researchResult.query}`,
      `Summary: ${researchResult.summary}`,
      keyFacts.length ? `Key facts:\n- ${keyFacts.join("\n- ")}` : "",
      relatedTopics.length ? `Related topics: ${relatedTopics.join(", ")}` : "",
      sources.length ? `Sources: ${sources.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    return {
      content,
      sourceType: "REPORT",
      title: truncate(researchResult.query || "Research campaign"),
    };
  }

  const draft = await prisma.tweetDraft.findFirst({
    where: { id: contentId, userId },
  });

  if (draft) {
    const content = draft.sourceContent || draft.content;
    return {
      content,
      sourceType: draft.sourceType || "REPORT",
      title: truncate(content.split("\n")[0] || draft.content || "Generated campaign"),
    };
  }

  return null;
}

// List campaigns
campaignsRouter.get("/", async (req: AuthRequest, res) => {
  try {
    const campaigns = await prisma.campaign.findMany({
      where: { userId: req.userId },
      include: { _count: { select: { drafts: true } } },
      orderBy: { updatedAt: "desc" },
    });
    const result = campaigns.map((c) => ({
      ...c,
      draftCount: c._count.drafts,
      _count: undefined,
    }));
    res.json(success({ campaigns: result }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to list campaigns");
    res.status(500).json(error("Failed to list campaigns"));
  }
});

// Create campaign
campaignsRouter.post("/", async (req: AuthRequest, res) => {
  try {
    const body = createSchema.parse(req.body);
    const campaign = await prisma.campaign.create({
      data: { userId: req.userId!, name: body.name, description: body.description },
    });
    logger.info({ campaignId: campaign.id, userId: req.userId }, "Campaign created");
    res.status(201).json(success({ campaign: { ...campaign, draftCount: 0 } }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    logger.error({ err: err.message }, "Failed to create campaign");
    res.status(500).json(error("Failed to create campaign"));
  }
});

// Generate campaign drafts from existing stored content
campaignsRouter.post("/generate", async (req: AuthRequest, res) => {
  try {
    const body = generateSchema.parse(req.body);

    if (body.userId !== req.userId) {
      return res.status(403).json(error("Forbidden", 403));
    }

    const resolved = await resolveCampaignSourceContent(body.contentId, req.userId!);
    if (!resolved || !resolved.content.trim()) {
      return res.status(404).json(error("Content not found", 404));
    }

    const insights = await extractInsights(resolved.content, { limit: body.angles });
    const result = await batchGenerateDrafts({
      userId: req.userId!,
      insights,
      sourceContent: resolved.content,
      sourceType: resolved.sourceType,
      tone: body.tone,
      createCampaign: true,
      campaignTitle: `${resolved.title} Campaign`,
      campaignDescription: `Generated from content ${body.contentId} using a ${body.tone} tone.`,
    });

    if (!result.campaign) {
      throw new Error("Campaign creation failed");
    }

    res.status(201).json(
      success({
        campaignId: result.campaign.id,
        drafts: result.drafts.map((draft) => ({
          id: draft.id,
          content: draft.content,
          angle: draft.angle,
          score: draft.score,
        })),
      }),
    );
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    if (err.message?.includes("Voice profile not found")) {
      return res.status(400).json(error(err.message, 400));
    }
    logger.error({ err: err.message }, "Failed to generate campaign drafts");
    res.status(502).json(error("Failed to generate campaign drafts", 502));
  }
});

// Get campaign detail with drafts
campaignsRouter.get("/:id", async (req: AuthRequest, res) => {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: paramId(req), userId: req.userId },
      include: { drafts: { orderBy: { sortOrder: "asc" } } },
    });
    if (!campaign) {
      return res.status(404).json(error("Campaign not found", 404));
    }
    res.json(success({ campaign: { ...campaign, draftCount: campaign.drafts.length } }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to get campaign");
    res.status(500).json(error("Failed to get campaign"));
  }
});

// List drafts for a campaign
campaignsRouter.get("/:id/drafts", async (req: AuthRequest, res) => {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: paramId(req), userId: req.userId },
      include: {
        drafts: {
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        },
      },
    });

    if (!campaign) {
      return res.status(404).json(error("Campaign not found", 404));
    }

    res.json(success({ drafts: campaign.drafts }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to list campaign drafts");
    res.status(500).json(error("Failed to list campaign drafts"));
  }
});

// Update campaign
campaignsRouter.patch("/:id", async (req: AuthRequest, res) => {
  try {
    const body = updateSchema.parse(req.body);
    const updated = await prisma.campaign.updateMany({
      where: { id: paramId(req), userId: req.userId },
      data: body,
    });
    if (updated.count === 0) {
      return res.status(404).json(error("Campaign not found", 404));
    }
    const campaign = await prisma.campaign.findUnique({
      where: { id: paramId(req) },
      include: { drafts: true },
    });
    res.json(success({ campaign: { ...campaign, draftCount: campaign?.drafts.length ?? 0, drafts: undefined } }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    logger.error({ err: err.message }, "Failed to update campaign");
    res.status(500).json(error("Failed to update campaign"));
  }
});

// Delete campaign (drafts are unlinked, not deleted)
campaignsRouter.delete("/:id", async (req: AuthRequest, res) => {
  try {
    await prisma.tweetDraft.updateMany({
      where: { campaignId: paramId(req), userId: req.userId },
      data: { campaignId: null, sortOrder: null },
    });
    const deleted = await prisma.campaign.deleteMany({
      where: { id: paramId(req), userId: req.userId },
    });
    if (deleted.count === 0) {
      return res.status(404).json(error("Campaign not found", 404));
    }
    res.json(success({ deleted: true }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to delete campaign");
    res.status(500).json(error("Failed to delete campaign"));
  }
});

// Add draft to campaign
campaignsRouter.post("/:id/drafts", async (req: AuthRequest, res) => {
  try {
    const { draftId, sortOrder } = z.object({
      draftId: z.string(),
      sortOrder: z.number().int().optional(),
    }).parse(req.body);

    const campaign = await prisma.campaign.findFirst({
      where: { id: paramId(req), userId: req.userId },
    });
    if (!campaign) return res.status(404).json(error("Campaign not found", 404));

    const draft = await prisma.tweetDraft.updateMany({
      where: { id: draftId, userId: req.userId },
      data: { campaignId: paramId(req), sortOrder: sortOrder ?? 0 },
    });
    if (draft.count === 0) return res.status(404).json(error("Draft not found", 404));

    res.json(success({ added: true }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    logger.error({ err: err.message }, "Failed to add draft to campaign");
    res.status(500).json(error("Failed to add draft to campaign"));
  }
});

// Remove draft from campaign
campaignsRouter.delete("/:id/drafts/:draftId", async (req: AuthRequest, res) => {
  try {
    const updated = await prisma.tweetDraft.updateMany({
      where: { id: paramId(req, "draftId"), campaignId: paramId(req), userId: req.userId },
      data: { campaignId: null, sortOrder: null },
    });
    if (updated.count === 0) return res.status(404).json(error("Draft not found in campaign", 404));
    res.json(success({ removed: true }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to remove draft from campaign");
    res.status(500).json(error("Failed to remove draft from campaign"));
  }
});
