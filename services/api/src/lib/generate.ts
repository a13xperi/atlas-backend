import { complete } from "./providers";
import { buildTweetPrompt } from "./prompt";

interface VoiceDimensions {
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
}

interface BlendVoice {
  label: string;
  percentage: number;
}

interface GenerateParams {
  voiceProfile: VoiceDimensions;
  sourceContent: string;
  sourceType: string;
  blendVoices?: BlendVoice[];
  feedback?: string;
  researchContext?: string;
  replyAngle?: string;
  angleInstruction?: string;
}

interface GenerateResult {
  content: string;
  confidence: number;
  predictedEngagement: number;
}

/**
 * Generate a tweet using Claude, styled to the user's voice profile.
 */
export async function generateTweet(params: GenerateParams): Promise<GenerateResult> {
  const { system, userMessage } = buildTweetPrompt(params);

  const response = await complete({
    taskType: "tweet_generation",
    maxTokens: 300,
    temperature: 0.7,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMessage },
    ],
  });

  const content = response.content;

  // Compute confidence heuristic (0.0 - 1.0)
  const confidence = computeConfidence(content, params);

  // Compute predicted engagement heuristic
  const predictedEngagement = computeEngagement(content, params);

  return { content, confidence, predictedEngagement };
}

function computeConfidence(content: string, params: GenerateParams): number {
  let score = 0.7; // Base confidence

  // Within 280 chars = good
  if (content.length > 0 && content.length <= 280) score += 0.1;
  else if (content.length > 280) score -= 0.2;

  // Profile maturity bonus
  if (params.voiceProfile.maturity === "ADVANCED") score += 0.1;
  else if (params.voiceProfile.maturity === "INTERMEDIATE") score += 0.05;

  // Substantial source content = better context = higher confidence
  if (params.sourceContent.length > 200) score += 0.05;
  if (params.sourceContent.length > 500) score += 0.05;

  // Feedback refinement = higher confidence
  if (params.feedback) score += 0.05;

  return Math.min(Math.max(score, 0.1), 0.99);
}

function computeEngagement(content: string, params: GenerateParams): number {
  let base = 1200; // Base predicted impressions

  // Source type weight
  const typeMultipliers: Record<string, number> = {
    TRENDING_TOPIC: 2.5,
    TWEET: 1.8,
    REPORT: 1.5,
    ARTICLE: 1.3,
    VOICE_NOTE: 1.1,
    MANUAL: 1.0,
  };
  base *= typeMultipliers[params.sourceType] || 1.0;

  // Contrarian boost — more contrarian = more engagement (controversial = viral)
  base *= 1 + (params.voiceProfile.contrarianTone / 200);

  // Brevity bonus — shorter tweets often perform better
  if (content.length <= 140) base *= 1.3;
  else if (content.length <= 200) base *= 1.15;

  // Humor bonus
  if (params.voiceProfile.humor > 60) base *= 1.15;

  return Math.round(base);
}
