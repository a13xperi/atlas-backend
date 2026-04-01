import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { buildErrorResponse } from "../middleware/requestId";

export const voiceRouter = Router();
voiceRouter.use(authenticate);

const profileSchema = z.object({
  humor: z.number().min(0).max(100).optional(),
  formality: z.number().min(0).max(100).optional(),
  brevity: z.number().min(0).max(100).optional(),
  contrarianTone: z.number().min(0).max(100).optional(),
});

const referenceSchema = z.object({
  name: z.string().min(1),
  handle: z.string().optional(),
});

const blendVoiceSchema = z.union([
  z.object({
    referenceId: z.string().min(1),
    weight: z.number().min(0).max(100),
  }),
  z.object({
    label: z.string().min(1),
    percentage: z.number().min(0).max(100),
    referenceVoiceId: z.string().min(1).optional(),
  }),
]).transform((voice) => {
  if ("label" in voice) {
    const legacyVoice = voice as {
      label: string;
      percentage: number;
      referenceVoiceId?: string;
    };

    return {
      label: legacyVoice.label,
      percentage: legacyVoice.percentage,
      referenceVoiceId: legacyVoice.referenceVoiceId,
    };
  }

  const weightedVoice = voice as {
    referenceId: string;
    weight: number;
  };

  return {
    label: weightedVoice.referenceId,
    percentage: weightedVoice.weight,
    referenceVoiceId: weightedVoice.referenceId,
  };
});

const blendSchema = z.object({
  name: z.string().min(1),
  voices: z.array(blendVoiceSchema).min(1),
});

// Get voice profile
voiceRouter.get("/profile", async (req: AuthRequest, res) => {
  try {
    const profile = await prisma.voiceProfile.findUnique({
      where: { userId: req.userId },
    });
    if (!profile) return res.status(404).json(buildErrorResponse(req, "Voice profile not found"));
    res.json({ profile });
  } catch (err: any) {
    res
      .status(500)
      .json(buildErrorResponse(req, "Failed to load voice profile", { message: err.message }));
  }
});

// Update voice dimensions
voiceRouter.patch("/profile", async (req: AuthRequest, res) => {
  try {
    const body = profileSchema.parse(req.body);

    const profile = await prisma.voiceProfile.update({
      where: { userId: req.userId },
      data: {
        ...(body.humor !== undefined && { humor: body.humor }),
        ...(body.formality !== undefined && { formality: body.formality }),
        ...(body.brevity !== undefined && { brevity: body.brevity }),
        ...(body.contrarianTone !== undefined && { contrarianTone: body.contrarianTone }),
      },
    });

    res.json({ profile });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    res
      .status(500)
      .json(buildErrorResponse(req, "Failed to update voice profile", { message: err.message }));
  }
});

// List reference voices
voiceRouter.get("/references", async (req: AuthRequest, res) => {
  try {
    const voices = await prisma.referenceVoice.findMany({
      where: { userId: req.userId, isActive: true },
    });
    res.json({ voices });
  } catch (err: any) {
    res
      .status(500)
      .json(buildErrorResponse(req, "Failed to load reference voices", { message: err.message }));
  }
});

// Add reference voice
voiceRouter.post("/references", async (req: AuthRequest, res) => {
  try {
    const body = referenceSchema.parse(req.body);

    const voice = await prisma.referenceVoice.create({
      data: { userId: req.userId!, name: body.name, handle: body.handle },
    });
    res.json({ voice });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      if (req.body?.name === undefined) {
        return res.status(400).json(buildErrorResponse(req, "Name is required"));
      }
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    res
      .status(500)
      .json(buildErrorResponse(req, "Failed to create reference voice", { message: err.message }));
  }
});

// List saved blends
voiceRouter.get("/blends", async (req: AuthRequest, res) => {
  try {
    const blends = await prisma.savedBlend.findMany({
      where: { userId: req.userId },
      include: { voices: { include: { referenceVoice: true } } },
    });
    res.json({ blends });
  } catch (err: any) {
    res.status(500).json(buildErrorResponse(req, "Failed to load blends", { message: err.message }));
  }
});

// Create blend
voiceRouter.post("/blends", async (req: AuthRequest, res) => {
  try {
    const body = blendSchema.parse(req.body);

    const blend = await prisma.savedBlend.create({
      data: {
        userId: req.userId!,
        name: body.name,
        voices: {
          create: body.voices.map((voice) => ({
            label: voice.label,
            percentage: voice.percentage,
            referenceVoiceId: voice.referenceVoiceId,
          })),
        },
      },
      include: { voices: true },
    });

    res.json({ blend });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      if (req.body?.name === undefined || !Array.isArray(req.body?.voices) || req.body.voices.length === 0) {
        return res.status(400).json(buildErrorResponse(req, "Name and voices required"));
      }
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    res.status(500).json(buildErrorResponse(req, "Failed to create blend", { message: err.message }));
  }
});

// Update a voice in a blend
voiceRouter.patch("/blends/:blendId/voices/:voiceId", async (req: AuthRequest, res) => {
  try {
    const blendId = req.params.blendId as string;
    const voiceId = req.params.voiceId as string;
    const { label, percentage, referenceVoiceId } = req.body;

    const blend = await prisma.savedBlend.findFirst({
      where: { id: blendId, userId: req.userId },
    });
    if (!blend) return res.status(404).json(buildErrorResponse(req, "Blend not found"));

    const voice = await prisma.blendVoice.findFirst({
      where: { id: voiceId, blendId },
    });
    if (!voice) return res.status(404).json(buildErrorResponse(req, "Voice not found in blend"));

    const updated = await prisma.blendVoice.update({
      where: { id: voiceId },
      data: {
        ...(label !== undefined && { label }),
        ...(percentage !== undefined && { percentage }),
        ...(referenceVoiceId !== undefined && { referenceVoiceId }),
      },
      include: { referenceVoice: true },
    });

    res.json({ voice: updated });
  } catch (err: any) {
    res
      .status(500)
      .json(buildErrorResponse(req, "Failed to update blend voice", { message: err.message }));
  }
});

// Remove a voice from a blend
voiceRouter.delete("/blends/:blendId/voices/:voiceId", async (req: AuthRequest, res) => {
  try {
    const blendId = req.params.blendId as string;
    const voiceId = req.params.voiceId as string;

    const blend = await prisma.savedBlend.findFirst({
      where: { id: blendId, userId: req.userId },
    });
    if (!blend) return res.status(404).json(buildErrorResponse(req, "Blend not found"));

    const voice = await prisma.blendVoice.findFirst({
      where: { id: voiceId, blendId },
    });
    if (!voice) return res.status(404).json(buildErrorResponse(req, "Voice not found in blend"));

    await prisma.blendVoice.delete({ where: { id: voiceId } });
    res.json({ success: true });
  } catch (err: any) {
    res
      .status(500)
      .json(buildErrorResponse(req, "Failed to delete blend voice", { message: err.message }));
  }
});
