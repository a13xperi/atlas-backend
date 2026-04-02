import { generateTweet } from "../../generate";
import type { PipelineStep } from "../types";

export const generateStep: PipelineStep = {
  name: "generate",
  // No group — runs after "prepare" group completes

  async execute(ctx) {
    if (!ctx.voiceProfile) {
      throw new Error("Voice profile not available — fetchVoice step must run first");
    }

    const result = await generateTweet({
      voiceProfile: ctx.voiceProfile,
      sourceContent: ctx.sourceContent,
      sourceType: ctx.sourceType,
      blendVoices: ctx.blendVoices,
      feedback: ctx.feedback,
      researchContext: ctx.researchContext,
    });

    ctx.generatedContent = result.content;
    ctx.confidence = result.confidence;
    ctx.predictedEngagement = result.predictedEngagement;
  },
};
