import { prisma } from "../../prisma";
import type { PipelineStep } from "../types";

export const fetchRecentDraftsStep: PipelineStep = {
  name: "fetchRecentDrafts",
  group: "prepare",   // runs in parallel with fetchVoice and fetchBlend
  optional: true,     // never block generation if this fails

  async execute(ctx) {
    const recent = await prisma.tweetDraft.findMany({
      where: { userId: ctx.userId },
      orderBy: { createdAt: "desc" },
      take: 3,
      select: { content: true },
    });

    if (recent.length > 0) {
      ctx.recentDraftTexts = recent.map((d) => d.content);
    }
  },
};
