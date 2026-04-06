import { generateTweet } from "../../generate";
import type { PipelineStep } from "../types";

export const generateStep: PipelineStep = {
  name: "generate",
  // No group — runs after "prepare" group completes

  async execute(ctx) {
    if (!ctx.voiceProfile) {
      throw new Error("Voice profile not available — fetchVoice step must run first");
    }

    // Merge blended dimensions (from fetchBlend) over the user's base profile
    const voiceProfile = ctx.blendedDimensions
      ? { ...ctx.voiceProfile, ...ctx.blendedDimensions }
      : ctx.voiceProfile;

    const result = await generateTweet({
      voiceProfile,
      sourceContent: ctx.sourceContent,
      sourceType: ctx.sourceType,
      blendVoices: ctx.blendVoices,
      feedback: ctx.feedback,
      researchContext: ctx.researchContext,
      replyAngle: ctx.replyAngle,
      angleInstruction: ctx.angleInstruction,
    });

    ctx.generatedContent = result.content;
    ctx.confidence = result.confidence;
    ctx.predictedEngagement = result.predictedEngagement;
  },
};
