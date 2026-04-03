/**
 * Voice profile calibration from tweet analysis.
 *
 * Takes a set of tweets, sends them to Claude for style analysis,
 * returns calibrated voice dimension values (0-100).
 */

import { getAnthropicClient } from "./anthropic";

export interface CalibrationResult {
  // All dimensions stored as 0-100 scale
  humor: number;
  formality: number;
  brevity: number;
  contrarianTone: number;
  directness: number;
  warmth: number;
  technicalDepth: number;
  confidence: number;
  evidenceOrientation: number;
  solutionOrientation: number;
  socialPosture: number;
  selfPromotionalIntensity: number;
  // Meta
  calibrationConfidence: number;
  analysis: string;
  tweetsAnalyzed: number;
}

const CALIBRATION_PROMPT = `You are a writing style analyst specializing in social media voice profiling for crypto/finance Twitter.

Analyze the following tweets from a single author and determine their writing style across 12 dimensions.

**Core Voice (0-100 scale):**
1. **humor** (0-100): 0 = completely serious/analytical, 50 = occasional wit, 100 = constantly comedic/meme-heavy
2. **formality** (0-100): 0 = extremely casual/slang-heavy, 50 = conversational, 100 = academic/institutional tone
3. **brevity** (0-100): 0 = long-form threads/elaborate, 50 = medium-length, 100 = ultra-concise one-liners
4. **contrarianTone** (0-100): 0 = mainstream consensus, 50 = balanced, 100 = strongly provocative/hot takes

**Communication Style (0-10 scale):**
5. **directness** (0-10): 0 = indirect/diplomatic, 5 = straightforward, 10 = blunt and unvarnished
6. **warmth** (0-10): 0 = cool/detached, 5 = balanced, 10 = enthusiastic and encouraging
7. **technicalDepth** (0-10): 0 = accessible/no jargon, 5 = moderate, 10 = deeply technical/expert-level
8. **confidence** (0-10): 0 = tentative/exploratory, 5 = steady, 10 = extremely assertive/bold

**Content Approach (0-10 scale):**
9. **evidenceOrientation** (0-10): 0 = instinct-driven, 5 = balanced, 10 = data-heavy/receipts-focused
10. **solutionOrientation** (0-10): 0 = pure observation/diagnosis, 5 = balanced, 10 = action-oriented prescriptions
11. **socialPosture** (0-10): 0 = detached observer, 5 = balanced, 10 = community-facing/conversational
12. **selfPromotionalIntensity** (0-10): 0 = no self-reference, 5 = moderate, 10 = strong personal brand signaling

Respond with ONLY valid JSON:
{
  "humor": <0-100>,
  "formality": <0-100>,
  "brevity": <0-100>,
  "contrarianTone": <0-100>,
  "directness": <0-10>,
  "warmth": <0-10>,
  "technicalDepth": <0-10>,
  "confidence": <0-10>,
  "evidenceOrientation": <0-10>,
  "solutionOrientation": <0-10>,
  "socialPosture": <0-10>,
  "selfPromotionalIntensity": <0-10>,
  "calibrationConfidence": <0.0-1.0>,
  "analysis": "<2-3 sentence summary of the author's complete voice profile>"
}

Be precise. Base your scores on patterns across ALL tweets, not individual outliers.`;

export async function calibrateFromTweets(
  tweets: string[],
): Promise<CalibrationResult> {
  if (tweets.length === 0) {
    throw new Error("No tweets provided for calibration");
  }

  const client = getAnthropicClient();

  const tweetBlock = tweets
    .slice(0, 50) // Cap at 50 tweets for context window
    .map((t, i) => `[${i + 1}] ${t}`)
    .join("\n\n");

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    system: CALIBRATION_PROMPT,
    messages: [
      {
        role: "user",
        content: `Analyze these ${tweets.length} tweets:\n\n${tweetBlock}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const content = textBlock?.text?.trim();
  if (!content) throw new Error("Empty response from Claude during calibration");

  const result = JSON.parse(content);

  const clamp100 = (v: number) => Math.min(Math.max(Math.round(v ?? 50), 0), 100);
  /** AI returns 0-10 for extended dims; multiply by 10 for 0-100 storage */
  const tenToHundred = (v: number) => clamp100(Math.round((v ?? 5) * 10));

  return {
    // Core voice (already 0-100)
    humor: clamp100(result.humor),
    formality: clamp100(result.formality),
    brevity: clamp100(result.brevity),
    contrarianTone: clamp100(result.contrarianTone),
    // Communication style (AI returns 0-10, stored as 0-100)
    directness: tenToHundred(result.directness),
    warmth: tenToHundred(result.warmth),
    technicalDepth: tenToHundred(result.technicalDepth),
    confidence: tenToHundred(result.confidence),
    // Content approach (AI returns 0-10, stored as 0-100)
    evidenceOrientation: tenToHundred(result.evidenceOrientation),
    solutionOrientation: tenToHundred(result.solutionOrientation),
    socialPosture: tenToHundred(result.socialPosture),
    selfPromotionalIntensity: tenToHundred(result.selfPromotionalIntensity),
    // Meta
    calibrationConfidence: Math.min(Math.max(result.calibrationConfidence ?? 0.5, 0), 1),
    analysis: result.analysis || "Voice profile calibrated from tweet analysis.",
    tweetsAnalyzed: tweets.length,
  };
}
