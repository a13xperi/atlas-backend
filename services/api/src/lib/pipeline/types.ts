/**
 * Pipeline types — inspired by claw-code's tools crate.
 * Each generation step is a composable unit with typed I/O,
 * optional/required semantics, and parallel grouping.
 */

export interface VoiceDimensions {
  humor: number;
  formality: number;
  brevity: number;
  contrarianTone: number;
  directness?: number;
  warmth?: number;
  technicalDepth?: number;
  confidence?: number;
  evidenceOrientation?: number;
  solutionOrientation?: number;
  socialPosture?: number;
  selfPromotionalIntensity?: number;
  maturity?: string;
  /** Calibration-generated natural language voice summary (2-3 sentences) */
  analysis?: string | null;
}

export interface PipelineContext {
  // --- Input (set before pipeline runs) ---
  userId: string;
  sourceContent: string;
  sourceType: string;
  blendId?: string;
  feedback?: string;
  replyAngle?: string;
  angleInstruction?: string;

  // --- Accumulated by steps ---
  voiceProfile?: VoiceDimensions;
  blendVoices?: { label: string; percentage: number }[];
  /** Weighted-average dimensions computed from reference voice profiles in a blend */
  blendedDimensions?: Partial<VoiceDimensions>;
  /** Set by fetchBlend when the requested blend cannot be resolved (blend missing, no voices mapped, etc.) */
  blendWarning?: string;
  researchContext?: string;
  generatedContent?: string;
  confidence?: number;
  predictedEngagement?: number;
  /** Final voice dimensions used for generation (base profile + blend overlay) */
  finalVoiceDimensions?: VoiceDimensions;
  /** Set by fetchArticleStep when sourceContent is a URL */
  articleUrl?: string;
  /** Set by fetchArticleStep when URL fetch fails */
  fetchArticleError?: string;
  /** Last 3 generated drafts for this user — used to avoid repeating angles */
  recentDraftTexts?: string[];

  // --- Observability ---
  stepResults: StepResult[];
}

export interface StepResult {
  name: string;
  status: "success" | "failed" | "skipped";
  latencyMs: number;
  error?: string;
}

export interface PipelineStep {
  name: string;
  /** Steps with the same group run in parallel */
  group?: string;
  /** If true, step failure doesn't abort the pipeline */
  optional?: boolean;
  execute(ctx: PipelineContext): Promise<void>;
}

export interface PipelineResult {
  ctx: PipelineContext;
  steps: StepResult[];
  totalMs: number;
}
