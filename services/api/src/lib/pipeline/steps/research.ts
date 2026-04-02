import { conductResearch } from "../../research";
import type { PipelineStep } from "../types";

export const researchStep: PipelineStep = {
  name: "research",
  group: "prepare",
  optional: true,

  async execute(ctx) {
    const result = await conductResearch({
      query: ctx.sourceContent,
      context: ctx.sourceType,
    });

    ctx.researchContext = `Summary: ${result.summary}\nKey facts: ${result.keyFacts.join("; ")}\nSentiment: ${result.sentiment}`;
  },
};
