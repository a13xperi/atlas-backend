/**
 * Voice profile calibration from tweet analysis.
 *
 * Takes a set of tweets, sends them to Claude for style analysis,
 * returns calibrated voice dimension values (0-100).
 */

import { getAnthropicClient } from "./anthropic";

export interface CalibrationResult {
  humor: number;
  formality: number;
  brevity: number;
  contrarianTone: number;
  confidence: number;
  analysis: string;
  tweetsAnalyzed: number;
}

const CALIBRATION_PROMPT = `You are a writing style analyst specializing in social media voice profiling for crypto/finance Twitter.

Analyze the following tweets from a single author and determine their writing style across 4 dimensions. Each dimension is a 0-100 scale.

**Dimensions:**
1. **Humor** (0-100): 0 = completely serious/analytical, 50 = occasional wit, 100 = constantly comedic/meme-heavy
2. **Formality** (0-100): 0 = extremely casual/slang-heavy, 50 = conversational, 100 = academic/institutional tone
3. **Brevity** (0-100): 0 = long-form threads/elaborate explanations, 50 = medium-length, 100 = ultra-concise one-liners
4. **Contrarian Tone** (0-100): 0 = mainstream consensus/agreeable, 50 = balanced, 100 = strongly provocative/hot takes

Respond with ONLY valid JSON:
{
  "humor": <number 0-100>,
  "formality": <number 0-100>,
  "brevity": <number 0-100>,
  "contrarianTone": <number 0-100>,
  "confidence": <number 0.0-1.0>,
  "analysis": "<2-3 sentence summary of the author's writing style>"
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

  // Clamp all values to valid ranges
  const clamp = (v: number, min: number, max: number) =>
    Math.min(Math.max(Math.round(v || 50), min), max);

  return {
    humor: clamp(result.humor, 0, 100),
    formality: clamp(result.formality, 0, 100),
    brevity: clamp(result.brevity, 0, 100),
    contrarianTone: clamp(result.contrarianTone, 0, 100),
    confidence: Math.min(Math.max(result.confidence || 0.5, 0), 1),
    analysis: result.analysis || "Voice profile calibrated from tweet analysis.",
    tweetsAnalyzed: tweets.length,
  };
}
