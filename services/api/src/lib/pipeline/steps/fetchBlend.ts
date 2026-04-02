import { prisma } from "../../prisma";
import type { PipelineStep } from "../types";

export const fetchBlendStep: PipelineStep = {
  name: "fetchBlend",
  group: "prepare",
  optional: true,

  async execute(ctx) {
    if (!ctx.blendId) return;

    const blend = await prisma.savedBlend.findFirst({
      where: { id: ctx.blendId, userId: ctx.userId },
      include: { voices: { include: { referenceVoice: true } } },
    });

    if (blend) {
      ctx.blendVoices = blend.voices.map((v) => ({
        label: v.referenceVoice?.name || v.label,
        percentage: v.percentage,
      }));
    }
  },
};
