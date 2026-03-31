import { Router } from "express";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";

export const voiceRouter = Router();
voiceRouter.use(authenticate);

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
  const { humor, formality, brevity, contrarianTone } = req.body;

  const profile = await prisma.voiceProfile.update({
    where: { userId: req.userId },
    data: {
      ...(humor !== undefined && { humor }),
      ...(formality !== undefined && { formality }),
      ...(brevity !== undefined && { brevity }),
      ...(contrarianTone !== undefined && { contrarianTone }),
    },
  });

  res.json({ profile });
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
  const { name, handle } = req.body;
  if (!name) return res.status(400).json({ error: "Name is required" });

  const voice = await prisma.referenceVoice.create({
    data: { userId: req.userId!, name, handle },
  });
  res.json({ voice });
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
  const { name, voices } = req.body;
  if (!name || !voices?.length) return res.status(400).json({ error: "Name and voices required" });

  const blend = await prisma.savedBlend.create({
    data: {
      userId: req.userId!,
      name,
      voices: {
        create: voices.map((v: { label: string; percentage: number; referenceVoiceId?: string }) => ({
          label: v.label,
          percentage: v.percentage,
          referenceVoiceId: v.referenceVoiceId,
        })),
      },
    },
    include: { voices: true },
  });

  res.json({ blend });
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
    if (!blend) return res.status(404).json({ error: "Blend not found" });

    const voice = await prisma.blendVoice.findFirst({
      where: { id: voiceId, blendId },
    });
    if (!voice) return res.status(404).json({ error: "Voice not found in blend" });

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
    res.status(500).json({ error: "Failed to update blend voice", message: err.message });
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
    if (!blend) return res.status(404).json({ error: "Blend not found" });

    const voice = await prisma.blendVoice.findFirst({
      where: { id: voiceId, blendId },
    });
    if (!voice) return res.status(404).json({ error: "Voice not found in blend" });

    await prisma.blendVoice.delete({ where: { id: voiceId } });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to delete blend voice", message: err.message });
  }
});
