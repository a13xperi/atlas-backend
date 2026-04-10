import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { buildErrorResponse } from "../middleware/requestId";
import { success } from "../lib/response";
import { logger } from "../lib/logger";
import { postTweet, refreshAccessToken } from "../lib/twitter";

export const queueRouter = Router();
queueRouter.use(authenticate);

const queueStatusSchema = z.enum(["queued", "scheduled", "published", "failed"]);

const createQueueItemSchema = z.object({
  content: z.string().min(1),
  scheduledAt: z.string().datetime().optional(),
  platform: z.string().min(1).max(50).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateQueueItemSchema = z
  .object({
    content: z.string().min(1).optional(),
    scheduledAt: z.string().datetime().nullable().optional(),
    platform: z.string().min(1).max(50).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "At least one field must be provided",
  });

function getQueueStatus(scheduledAt: Date | null): "queued" | "scheduled" {
  return scheduledAt ? "scheduled" : "queued";
}

async function getPublishAccessToken(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { xAccessToken: true, xRefreshToken: true, xTokenExpiresAt: true },
  });

  if (!user?.xAccessToken) {
    throw new Error("X account not linked. Connect your X account first.");
  }

  if (!user.xTokenExpiresAt || user.xTokenExpiresAt >= new Date() || !user.xRefreshToken) {
    return user.xAccessToken;
  }

  const refreshed = await refreshAccessToken(user.xRefreshToken);
  await prisma.user.update({
    where: { id: userId },
    data: {
      xAccessToken: refreshed.accessToken,
      xRefreshToken: refreshed.refreshToken,
      xTokenExpiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
    },
  });

  return refreshed.accessToken;
}

queueRouter.get("/", async (req: AuthRequest, res) => {
  try {
    const status = req.query.status ? queueStatusSchema.parse(req.query.status) : undefined;

    const items = await prisma.draftQueueItem.findMany({
      where: {
        userId: req.userId,
        ...(status ? { status } : {}),
      },
      orderBy: [{ scheduledAt: "asc" }, { createdAt: "desc" }],
    });

    res.json(success({ items }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }

    logger.error({ err: err.message, userId: req.userId }, "Failed to list queue items");
    res.status(500).json(buildErrorResponse(req, "Failed to load queue items"));
  }
});

queueRouter.get("/scheduled", async (req: AuthRequest, res) => {
  try {
    const items = await prisma.draftQueueItem.findMany({
      where: {
        userId: req.userId,
        status: "scheduled",
        scheduledAt: { gt: new Date() },
      },
      orderBy: { scheduledAt: "asc" },
    });

    res.json(success({ items }));
  } catch (err: any) {
    logger.error({ err: err.message, userId: req.userId }, "Failed to list scheduled queue items");
    res.status(500).json(buildErrorResponse(req, "Failed to load scheduled queue items"));
  }
});

queueRouter.post("/", async (req: AuthRequest, res) => {
  try {
    const body = createQueueItemSchema.parse(req.body);
    const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : null;
    const metadata = body.metadata as Prisma.InputJsonValue | undefined;

    if (scheduledAt && scheduledAt <= new Date()) {
      return res.status(400).json(buildErrorResponse(req, "Scheduled time must be in the future"));
    }

    const item = await prisma.draftQueueItem.create({
      data: {
        userId: req.userId!,
        content: body.content,
        scheduledAt: scheduledAt ?? undefined,
        status: getQueueStatus(scheduledAt),
        platform: body.platform ?? "twitter",
        ...(metadata !== undefined ? { metadata } : {}),
      },
    });

    await prisma.analyticsEvent.create({
      data: {
        userId: req.userId!,
        type: "DRAFT_CREATED",
        metadata: {
          source: "draft_queue",
          queueItemId: item.id,
          scheduled: item.status === "scheduled",
        },
      },
    });

    logger.info({ userId: req.userId, queueItemId: item.id }, "Draft queue item created");
    res.status(201).json(success({ item }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }

    logger.error({ err: err.message, userId: req.userId }, "Failed to create draft queue item");
    res.status(500).json(buildErrorResponse(req, "Failed to create queue item"));
  }
});

queueRouter.patch("/:id", async (req: AuthRequest, res) => {
  try {
    const body = updateQueueItemSchema.parse(req.body);
    const metadata = body.metadata as Prisma.InputJsonValue | undefined;

    const existing = await prisma.draftQueueItem.findFirst({
      where: { id: req.params.id as string, userId: req.userId },
    });

    if (!existing) {
      return res.status(404).json(buildErrorResponse(req, "Queue item not found"));
    }

    if (existing.status === "published") {
      return res.status(400).json(buildErrorResponse(req, "Published queue items cannot be updated"));
    }

    let scheduledAt = existing.scheduledAt;
    if (body.scheduledAt !== undefined) {
      scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : null;
      if (scheduledAt && scheduledAt <= new Date()) {
        return res.status(400).json(buildErrorResponse(req, "Scheduled time must be in the future"));
      }
    }

    const shouldResetStatus = body.scheduledAt !== undefined || existing.status === "failed";
    const item = await prisma.draftQueueItem.update({
      where: { id: existing.id },
      data: {
        ...(body.content !== undefined ? { content: body.content } : {}),
        ...(body.platform !== undefined ? { platform: body.platform } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
        ...(body.scheduledAt !== undefined ? { scheduledAt: scheduledAt ?? null } : {}),
        ...(shouldResetStatus ? { status: getQueueStatus(scheduledAt) } : {}),
      },
    });

    logger.info({ userId: req.userId, queueItemId: item.id }, "Draft queue item updated");
    res.json(success({ item }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }

    logger.error({ err: err.message, userId: req.userId }, "Failed to update draft queue item");
    res.status(500).json(buildErrorResponse(req, "Failed to update queue item"));
  }
});

queueRouter.delete("/:id", async (req: AuthRequest, res) => {
  try {
    const existing = await prisma.draftQueueItem.findFirst({
      where: { id: req.params.id as string, userId: req.userId },
    });

    if (!existing) {
      return res.status(404).json(buildErrorResponse(req, "Queue item not found"));
    }

    await prisma.draftQueueItem.delete({ where: { id: existing.id } });

    logger.info({ userId: req.userId, queueItemId: existing.id }, "Draft queue item deleted");
    res.json(success({ deleted: true }));
  } catch (err: any) {
    logger.error({ err: err.message, userId: req.userId }, "Failed to delete draft queue item");
    res.status(500).json(buildErrorResponse(req, "Failed to delete queue item"));
  }
});

queueRouter.post("/:id/publish", async (req: AuthRequest, res) => {
  try {
    const item = await prisma.draftQueueItem.findFirst({
      where: { id: req.params.id as string, userId: req.userId },
    });

    if (!item) {
      return res.status(404).json(buildErrorResponse(req, "Queue item not found"));
    }

    if (item.status === "published") {
      return res.status(400).json(buildErrorResponse(req, "Queue item has already been published"));
    }

    if (item.platform !== "twitter") {
      return res.status(400).json(buildErrorResponse(req, `Unsupported platform: ${item.platform}`));
    }

    const accessToken = await getPublishAccessToken(req.userId!);

    try {
      const tweet = await postTweet(accessToken, item.content);

      const updated = await prisma.draftQueueItem.update({
        where: { id: item.id },
        data: {
          status: "published",
          tweetId: tweet.id,
          scheduledAt: null,
        },
      });

      await prisma.analyticsEvent.create({
        data: {
          userId: req.userId!,
          type: "DRAFT_POSTED",
          metadata: {
            source: "draft_queue",
            queueItemId: item.id,
            tweetId: tweet.id,
          },
        },
      });

      logger.info({ userId: req.userId, queueItemId: item.id, tweetId: tweet.id }, "Draft queue item published");
      return res.json(success({ item: updated, tweet }));
    } catch (err: any) {
      await prisma.draftQueueItem.update({
        where: { id: item.id },
        data: { status: "failed" },
      });

      logger.error({ err: err.message, userId: req.userId, queueItemId: item.id }, "Failed to publish draft queue item");
      return res
        .status(502)
        .json(buildErrorResponse(req, `Failed to publish queue item: ${err.message}`));
    }
  } catch (err: any) {
    if (err.message === "X account not linked. Connect your X account first.") {
      return res.status(400).json(buildErrorResponse(req, err.message));
    }

    logger.error({ err: err.message, userId: req.userId }, "Failed to publish draft queue item");
    res.status(500).json(buildErrorResponse(req, "Failed to publish queue item"));
  }
});
