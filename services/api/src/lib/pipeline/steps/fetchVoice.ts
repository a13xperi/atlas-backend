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

    // Server-side voice gate (min 20 tweets).
    // Bypass if user already has drafts (was calibrated before count reset).
    if (profile.tweetsAnalyzed < 20) {
      const draftCount = await prisma.tweetDraft.count({
        where: { userId: ctx.userId },
      });
      if (draftCount === 0) {
        throw new Error(
          `Voice profile not fully calibrated. You need at least 20 tweets analyzed (${profile.tweetsAnalyzed} analyzed so far).`
        );
      }
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
      analysis: profile.analysis,
    };
  },
};
