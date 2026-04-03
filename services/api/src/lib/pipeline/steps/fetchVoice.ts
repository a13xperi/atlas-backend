import { prisma } from "../../prisma";
import type { PipelineStep } from "../types";

export const fetchVoiceStep: PipelineStep = {
  name: "fetchVoice",
  group: "prepare",

  async execute(ctx) {
    const profile = await prisma.voiceProfile.findUnique({
      where: { userId: ctx.userId },
    });

    if (!profile) {
      throw new Error("Voice profile not found. Complete onboarding first.");
    }

    ctx.voiceProfile = {
      humor: profile.humor,
      formality: profile.formality,
      brevity: profile.brevity,
      contrarianTone: profile.contrarianTone,
      directness: profile.directness,
      warmth: profile.warmth,
      technicalDepth: profile.technicalDepth,
      confidence: profile.confidence,
      evidenceOrientation: profile.evidenceOrientation,
      solutionOrientation: profile.solutionOrientation,
      socialPosture: profile.socialPosture,
      selfPromotionalIntensity: profile.selfPromotionalIntensity,
      maturity: profile.maturity,
    };
  },
};
