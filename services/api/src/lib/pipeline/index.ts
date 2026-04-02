/**
 * Generation Pipeline — composable step-based content generation.
 *
 * Usage:
 *   import { runGenerationPipeline } from "../lib/pipeline";
 *
 *   const result = await runGenerationPipeline({
 *     userId: "user-123",
 *     sourceContent: "BTC hits ATH",
 *     sourceType: "TRENDING_TOPIC",
 *   });
 *
 *   result.ctx.generatedContent  // the tweet
 *   result.ctx.confidence        // 0-1
 *   result.steps                 // per-step metrics
 */

import { runPipeline } from "./runner";
import { fetchVoiceStep } from "./steps/fetchVoice";
import { fetchBlendStep } from "./steps/fetchBlend";
import { researchStep } from "./steps/research";
import { generateStep } from "./steps/generate";
import type { PipelineContext, PipelineResult } from "./types";

export type { PipelineContext, PipelineResult, StepResult } from "./types";

interface GenerationInput {
  userId: string;
  sourceContent: string;
  sourceType: string;
  blendId?: string;
  feedback?: string;
}

export async function runGenerationPipeline(input: GenerationInput): Promise<PipelineResult> {
  const ctx: PipelineContext = {
    ...input,
    stepResults: [],
  };

  return runPipeline(
    [fetchVoiceStep, fetchBlendStep, researchStep, generateStep],
    ctx,
  );
}
