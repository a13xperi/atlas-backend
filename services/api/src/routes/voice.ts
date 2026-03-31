import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";

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
  const profile = await prisma.voiceProfile.findUnique({
    where: { userId: req.userId },
  });
  if (!profile) return res.status(404).json({ error: "Voice profile not found" });
  res.json({ profile });
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
      return res.status(400).json({ error: "Invalid request", details: err.errors });
    }
    res.status(500).json({ error: "Failed to update voice profile", message: err.message });
  }
});

// List reference voices
voiceRouter.get("/references", async (req: AuthRequest, res) => {
  const voices = await prisma.referenceVoice.findMany({
    where: { userId: req.userId, isActive: true },
  });
  res.json({ voices });
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
        return res.status(400).json({ error: "Name is required" });
      }
      return res.status(400).json({ error: "Invalid request", details: err.errors });
    }
    res.status(500).json({ error: "Failed to create reference voice", message: err.message });
  }
});

// List saved blends
voiceRouter.get("/blends", async (req: AuthRequest, res) => {
  const blends = await prisma.savedBlend.findMany({
    where: { userId: req.userId },
    include: { voices: { include: { referenceVoice: true } } },
  });
  res.json({ blends });
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
        return res.status(400).json({ error: "Name and voices required" });
      }
      return res.status(400).json({ error: "Invalid request", details: err.errors });
    }
    res.status(500).json({ error: "Failed to create blend", message: err.message });
  }
});
