import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { error, success } from "../lib/response";
import { authenticate, AuthRequest } from "../middleware/auth";
import { logger } from "../lib/logger";

export const voiceTinderRouter: Router = Router();
voiceTinderRouter.use(authenticate);

// GET /api/voice-tinder/session — return active tinder session state
voiceTinderRouter.get("/session", async (req: AuthRequest, res) => {
  try {
    const [exemplars, archetype] = await Promise.all([
      prisma.tweetExemplar.findMany({
        where: { userId: req.userId! },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          source: true,
          referenceHandle: true,
          tweetId: true,
          text: true,
          authorHandle: true,
          metrics: true,
          postedAt: true,
          decision: true,
          swipedAt: true,
          durationMs: true,
        },
      }),
      prisma.voiceArchetype.findUnique({ where: { userId: req.userId! } }),
    ]);

    const ownSwipes = exemplars.filter((e) => e.source === "OWN");
    const refSwipes = exemplars.filter((e) => e.source === "REFERENCE");

    return res.json(
      success({
        hasArchetype: !!archetype,
        archetype: archetype ?? null,
        ownSwipes: {
          total: ownSwipes.length,
          kept: ownSwipes.filter((e) => e.decision === "KEEP").length,
          skipped: ownSwipes.filter((e) => e.decision === "SKIP").length,
        },
        referenceHandles: [
          ...new Set(refSwipes.map((e) => e.referenceHandle).filter(Boolean)),
        ],
        recentExemplars: exemplars.slice(0, 5),
      }),
    );
  } catch (err: any) {
    logger.error({ err: err.message }, "voice-tinder session fetch failed");
    return res.status(500).json(error("Failed to load tinder session", 500));
  }
});

const swipeSchema = z.object({
  swipes: z.array(
    z.object({
      tweetId: z.string().min(1),
      text: z.string().min(1),
      authorHandle: z.string().min(1),
      source: z.enum(["OWN", "REFERENCE"]),
      referenceHandle: z.string().optional(),
      decision: z.enum(["KEEP", "SKIP"]),
      durationMs: z.number().int().min(0).optional(),
      metrics: z.record(z.string(), z.number()).optional(),
      postedAt: z.string().datetime().optional(),
    }),
  ).min(1).max(50),
});

// POST /api/voice-tinder/swipe — record swipe decisions (batched)
voiceTinderRouter.post("/swipe", async (req: AuthRequest, res) => {
  try {
    const body = swipeSchema.parse(req.body);
    const now = new Date();

    const upserts = body.swipes.map((s) =>
      prisma.tweetExemplar.upsert({
        where: {
          userId_tweetId_source: {
            userId: req.userId!,
            tweetId: s.tweetId,
            source: s.source,
          },
        },
        update: {
          decision: s.decision,
          swipedAt: now,
          durationMs: s.durationMs,
        },
        create: {
          userId: req.userId!,
          tweetId: s.tweetId,
          text: s.text,
          authorHandle: s.authorHandle,
          source: s.source,
          referenceHandle: s.referenceHandle ?? null,
          decision: s.decision,
          swipedAt: now,
          durationMs: s.durationMs ?? null,
          metrics: s.metrics ?? undefined,
          postedAt: s.postedAt ? new Date(s.postedAt) : null,
        },
        select: { id: true, decision: true },
      }),
    );

    const results = await prisma.$transaction(upserts);

    return res.json(success({ saved: results.length }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid swipe data", 400, err.errors));
    }
    logger.error({ err: err.message }, "swipe save failed");
    return res.status(500).json(error("Failed to save swipes", 500));
  }
});

// POST /api/voice-tinder/calibrate — compute archetype from kept exemplars
voiceTinderRouter.post("/calibrate", async (req: AuthRequest, res) => {
  try {
    const keptExemplars = await prisma.tweetExemplar.findMany({
      where: {
        userId: req.userId!,
        source: "OWN",
        decision: "KEEP",
      },
      orderBy: { swipedAt: "desc" },
      take: 25,
    });

    if (keptExemplars.length < 5) {
      return res
        .status(422)
        .json(
          error(
            `Need at least 5 kept exemplars to calibrate (have ${keptExemplars.length})`,
            422,
          ),
        );
    }

    // Stub archetype derivation — real AI call goes here once prompts are wired.
    // For now return a placeholder so frontend can unblock.
    const archetype = await prisma.voiceArchetype.upsert({
      where: { userId: req.userId! },
      update: {
        derivedFrom: keptExemplars.length,
        derivedAt: new Date(),
        updatedAt: new Date(),
      },
      create: {
        userId: req.userId!,
        label: "Analyst",
        oneLiner: "Data-driven, direct, and independent.",
        description:
          "You write with conviction backed by analysis. Your tweets cut through noise with precision.",
        themes: ["markets", "data", "research"],
        signatures: [],
        avoids: [],
        derivedFrom: keptExemplars.length,
      },
    });

    // Mark voice profile as calibrated
    await prisma.voiceProfile.updateMany({
      where: { userId: req.userId! },
      data: {
        derivedFromExemplars: true,
        lastCalibratedAt: new Date(),
      },
    });

    return res.json(success({ archetype }));
  } catch (err: any) {
    logger.error({ err: err.message }, "calibrate failed");
    return res.status(500).json(error("Failed to calibrate voice", 500));
  }
});

// POST /api/voice-tinder/recalibrate — reset exemplar decisions + re-run calibration
voiceTinderRouter.post("/recalibrate", async (req: AuthRequest, res) => {
  try {
    await prisma.tweetExemplar.deleteMany({
      where: { userId: req.userId!, source: "OWN" },
    });

    await prisma.voiceArchetype.deleteMany({
      where: { userId: req.userId! },
    });

    await prisma.voiceProfile.updateMany({
      where: { userId: req.userId! },
      data: { derivedFromExemplars: false, lastCalibratedAt: null },
    });

    return res.json(success({ message: "Recalibration ready. Start swiping." }));
  } catch (err: any) {
    logger.error({ err: err.message }, "recalibrate failed");
    return res.status(500).json(error("Failed to reset calibration", 500));
  }
});

// GET /api/voice-tinder/reference/:handle — get reference voice status
voiceTinderRouter.get("/reference/:handle", async (req: AuthRequest, res) => {
  try {
    const rawHandle = req.params.handle;
    const handle = (Array.isArray(rawHandle) ? rawHandle[0] : rawHandle).replace(/^@/, "");

    const exemplars = await prisma.tweetExemplar.findMany({
      where: {
        userId: req.userId!,
        source: "REFERENCE",
        referenceHandle: handle,
      },
    });

    const kept = exemplars.filter((e) => e.decision === "KEEP");
    const skipped = exemplars.filter((e) => e.decision === "SKIP");

    const referenceVoice = await prisma.referenceVoice.findFirst({
      where: { userId: req.userId!, handle },
    });

    return res.json(
      success({
        handle,
        status: referenceVoice?.status ?? "SCANNING",
        exemplarCount: exemplars.length,
        kept: kept.length,
        skipped: skipped.length,
        validatedAt: referenceVoice?.validatedAt ?? null,
        archetype: referenceVoice?.archetype ?? null,
      }),
    );
  } catch (err: any) {
    logger.error({ err: err.message }, "reference fetch failed");
    return res.status(500).json(error("Failed to load reference voice", 500));
  }
});

// POST /api/voice-tinder/reference/:handle/validate — finalize reference voice from swipes
voiceTinderRouter.post("/reference/:handle/validate", async (req: AuthRequest, res) => {
  try {
    const rawHandle = req.params.handle;
    const handle = (Array.isArray(rawHandle) ? rawHandle[0] : rawHandle).replace(/^@/, "");

    const keptExemplars = await prisma.tweetExemplar.findMany({
      where: {
        userId: req.userId!,
        source: "REFERENCE",
        referenceHandle: handle,
        decision: "KEEP",
      },
    });

    if (keptExemplars.length < 3) {
      return res
        .status(422)
        .json(
          error(
            `Need at least 3 kept exemplars to validate @${handle} (have ${keptExemplars.length})`,
            422,
          ),
        );
    }

    // Stub essence — real AI call goes here.
    const essence = {
      draws: ["directness", "market insight", "dry wit"],
      skips: ["inside jokes", "trade calls"],
      strength: "balanced",
    };

    // Upsert the ReferenceVoice record
    const existing = await prisma.referenceVoice.findFirst({
      where: { userId: req.userId!, handle },
    });

    if (existing) {
      await prisma.referenceVoice.update({
        where: { id: existing.id },
        data: {
          status: "VALIDATED",
          validatedAt: new Date(),
          exemplarCount: keptExemplars.length,
          archetype: essence,
        },
      });
    } else {
      await prisma.referenceVoice.create({
        data: {
          userId: req.userId!,
          name: handle,
          handle,
          status: "VALIDATED",
          validatedAt: new Date(),
          exemplarCount: keptExemplars.length,
          archetype: essence,
          isActive: true,
        },
      });
    }

    return res.json(success({ handle, essence, validatedAt: new Date() }));
  } catch (err: any) {
    logger.error({ err: err.message }, "reference validate failed");
    return res.status(500).json(error("Failed to validate reference voice", 500));
  }
});
