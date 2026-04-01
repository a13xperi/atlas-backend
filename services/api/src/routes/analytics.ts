import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { buildErrorResponse } from "../middleware/requestId";

export const analyticsRouter = Router();
analyticsRouter.use(authenticate);

const emptyQuerySchema = z.object({}).passthrough();

// Get user analytics summary
analyticsRouter.get("/summary", async (req: AuthRequest, res) => {
  try {
    emptyQuerySchema.parse(req.query);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [draftsCreated, draftsPosted, feedbackGiven, refinements, reportsIngested] =
      await Promise.all([
        prisma.analyticsEvent.count({
          where: { userId: req.userId, type: "DRAFT_CREATED", createdAt: { gte: thirtyDaysAgo } },
        }),
        prisma.analyticsEvent.count({
          where: { userId: req.userId, type: "DRAFT_POSTED", createdAt: { gte: thirtyDaysAgo } },
        }),
        prisma.analyticsEvent.count({
          where: { userId: req.userId, type: "FEEDBACK_GIVEN", createdAt: { gte: thirtyDaysAgo } },
        }),
        prisma.analyticsEvent.count({
          where: { userId: req.userId, type: "VOICE_REFINEMENT", createdAt: { gte: thirtyDaysAgo } },
        }),
        prisma.analyticsEvent.count({
          where: { userId: req.userId, type: "REPORT_INGESTED", createdAt: { gte: thirtyDaysAgo } },
        }),
      ]);

    res.json({
      summary: {
        draftsCreated,
        draftsPosted,
        feedbackGiven,
        refinements,
        reportsIngested,
        period: "30d",
      },
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    res.status(500).json(buildErrorResponse(req, "Failed to load summary", { message: err.message }));
  }
});

// Create learning log entry
analyticsRouter.post("/learning-log", async (req: AuthRequest, res) => {
  try {
    const { event, impact, positive } = req.body;
    if (!event) {
      return res.status(400).json(buildErrorResponse(req, "Event description is required"));
    }

    const entry = await prisma.learningLogEntry.create({
      data: {
        userId: req.userId!,
        event,
        impact: impact || null,
        positive: positive !== undefined ? positive : true,
      },
    });

    res.json({ entry });
  } catch (err: any) {
    res
      .status(500)
      .json(buildErrorResponse(req, "Failed to create learning log entry", { message: err.message }));
  }
});

// Get learning log
analyticsRouter.get("/learning-log", async (req: AuthRequest, res) => {
  try {
    emptyQuerySchema.parse(req.query);

    const entries = await prisma.learningLogEntry.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    res.json({ entries });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    res
      .status(500)
      .json(buildErrorResponse(req, "Failed to load learning log", { message: err.message }));
  }
});

// Get engagement history (for charts)
analyticsRouter.get("/engagement", async (req: AuthRequest, res) => {
  try {
    emptyQuerySchema.parse(req.query);

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const events = await prisma.analyticsEvent.findMany({
      where: {
        userId: req.userId,
        type: "ENGAGEMENT_RECORDED",
        createdAt: { gte: sevenDaysAgo },
      },
      orderBy: { createdAt: "asc" },
    });

    res.json({ events });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    res
      .status(500)
      .json(buildErrorResponse(req, "Failed to load engagement history", { message: err.message }));
  }
});

// Team analytics (manager only)
analyticsRouter.get("/team", async (req: AuthRequest, res) => {
  try {
    emptyQuerySchema.parse(req.query);

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user || user.role === "ANALYST") {
      return res.status(403).json(buildErrorResponse(req, "Manager access required"));
    }

    const analysts = await prisma.user.findMany({
      where: { role: "ANALYST" },
      include: {
        voiceProfile: true,
        _count: {
          select: {
            tweetDrafts: true,
            analyticsEvents: true,
            sessions: true,
          },
        },
      },
    });

    res.json({
      analysts: analysts.map(({ passwordHash, ...a }) => a),
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    res
      .status(500)
      .json(buildErrorResponse(req, "Failed to load team analytics", { message: err.message }));
  }
});
