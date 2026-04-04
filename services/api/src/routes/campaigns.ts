import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { logger } from "../lib/logger";
import { success, error } from "../lib/response";

export const campaignsRouter = Router({ mergeParams: true });
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

    res.json(success({ deleted: true }));
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
    res.json(success({ deleted: true }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to remove draft from campaign");
    res.status(500).json(error("Failed to remove draft from campaign"));
  }
});
