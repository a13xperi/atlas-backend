import { Router } from "express";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";

export const draftsRouter = Router();
draftsRouter.use(authenticate);

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
