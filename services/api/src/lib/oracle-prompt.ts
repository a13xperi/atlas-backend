/**
 * Oracle prompt builder — personality + per-step prompt templates.
 * The Oracle is Atlas's AI guide: mysterious, DeFi-native, brief, opinionated.
 * Same brain as the Telegram bot — one personality, two surfaces.
 */

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
}

interface BlendVoice {
  label: string;
  percentage: number;
}

// ── System Prompt ────────────────────────────────────────────────

export function buildOracleSystemPrompt(): string {
  return `You are The Oracle — the AI guide inside Atlas by Delphi Digital.
You help crypto analysts discover and refine their writing voice.

Personality:
- Mysterious but approachable. Ancient wisdom meets bleeding-edge tech.
- DeFi-native — you understand CT culture, memes, alpha, the grind.
- Encouraging but not sycophantic — you have opinions and share them.
- Brief. Max 2-3 sentences per message unless explaining voice dimensions.
- Use "I" not "we" — you are one entity across portal and Telegram.
- Occasionally reference the Oracle archetype ("I've seen thousands of voices...")

You are NOT a generic assistant. You are Atlas.
You know the user's handle, their tweet history (if Track A), their calibration results.
Use that context to give specific, personalized guidance.

Examples of good Oracle messages:
- "You're way more contrarian than most analysts — I like that. Want to lean into it or soften it?"
- "Interesting combo — Cobie's brevity + Hasu's depth. Here's what a tweet might sound like in this blend..."
- "Most people start at 50/50. But based on your tweets, you've got a strong enough voice to go 70/30."

Never use bullet points or numbered lists. Speak in natural sentences. Keep it under 50 words.`;
}

// ── Calibration Commentary ───────────────────────────────────────

export function buildCalibrationCommentary(
  dimensions: VoiceDimensions,
  tweetsAnalyzed: number,
  handle?: string,
): { system: string; userMessage: string } {
  const dimSummary = summarizeDimensions(dimensions);

  return {
    system: buildOracleSystemPrompt(),
    userMessage: `I just analyzed ${tweetsAnalyzed} tweets${handle ? ` from @${handle}` : ""}. Here are the voice dimensions I found:

${dimSummary}

Write a 1-2 sentence personalized commentary on this voice profile. Be specific about what stands out — mention particular dimensions by name. Have an opinion. Keep it under 40 words.`,
  };
}

// ── Blend Preview Tweet ──────────────────────────────────────────

export function buildBlendPreview(
  dimensions: VoiceDimensions,
  blendVoices: BlendVoice[],
  topic?: string,
): { system: string; userMessage: string } {
  const dimSummary = summarizeDimensions(dimensions);
  const blendDesc = blendVoices
    .map((v) => `${v.label}: ${v.percentage}%`)
    .join(", ");
  const topicLine = topic || "a recent DeFi development or crypto market move";

  return {
    system: buildOracleSystemPrompt() + `\n\nYou are generating a sample tweet to preview the user's blended voice. Write exactly one tweet (under 280 characters). No quotation marks, no meta-commentary — just the tweet itself.`,
    userMessage: `Voice dimensions: ${dimSummary}
Blend: ${blendDesc}

Write a sample tweet about ${topicLine} in this voice. Just the tweet, nothing else.`,
  };
}

// ── Dimension Reaction (unusual combos) ──────────────────────────

export function buildDimensionReaction(
  dimensions: VoiceDimensions,
): { system: string; userMessage: string } | null {
  const unusual = detectUnusualCombos(dimensions);
  if (!unusual) return null;

  return {
    system: buildOracleSystemPrompt(),
    userMessage: `A user just set their voice dimensions with this unusual combination: ${unusual}

Write a brief, opinionated Oracle reaction (1 sentence, under 30 words). Be playful but respectful. Reference the specific dimensions.`,
  };
}

// ── Free-Text Response ───────────────────────────────────────────

export function buildFreeTextResponse(
  userMessage: string,
  context: {
    track?: string;
    step?: string;
    dimensions?: VoiceDimensions;
  },
): { system: string; userMessage: string } {
  const contextLine = context.dimensions
    ? `\nThe user is in onboarding (${context.track === "a" ? "Track A — X scan" : "Track B — manual"}, step: ${context.step}). Their current voice dimensions: ${summarizeDimensions(context.dimensions)}`
    : `\nThe user is in onboarding (${context.track === "a" ? "Track A" : "Track B"}, step: ${context.step}).`;

  return {
    system: buildOracleSystemPrompt() + `\n\nThe user sent a free-text message during onboarding. Respond briefly (1-2 sentences) and guide them back to the current step if needed.${contextLine}`,
    userMessage,
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function summarizeDimensions(d: VoiceDimensions): string {
  const lines: string[] = [];
  const add = (label: string, val: number | undefined) => {
    if (val !== undefined) lines.push(`${label}: ${val}/100`);
  };

  add("Humor", d.humor);
  add("Formality", d.formality);
  add("Brevity", d.brevity);
  add("Contrarian", d.contrarianTone);
  add("Directness", d.directness);
  add("Warmth", d.warmth);
  add("Technical depth", d.technicalDepth);
  add("Confidence", d.confidence);
  add("Evidence orientation", d.evidenceOrientation);
  add("Solution orientation", d.solutionOrientation);
  add("Social posture", d.socialPosture);
  add("Self-promotion", d.selfPromotionalIntensity);

  return lines.join(", ");
}

function detectUnusualCombos(d: VoiceDimensions): string | null {
  // High humor + high formality = unusual
  if (d.humor > 75 && d.formality > 75) {
    return `Very high humor (${d.humor}) combined with very high formality (${d.formality}) — formally funny`;
  }
  // Max contrarian + high warmth = unusual
  if (d.contrarianTone > 80 && (d.warmth ?? 50) > 75) {
    return `Very contrarian (${d.contrarianTone}) but also very warm (${d.warmth}) — the friendly provocateur`;
  }
  // Min everything = unusual
  if (d.humor < 15 && d.formality < 15 && d.brevity < 15) {
    return `Very low across humor (${d.humor}), formality (${d.formality}), and brevity (${d.brevity}) — the verbose casual nihilist`;
  }
  // Max brevity + max technical depth = unusual
  if (d.brevity > 85 && (d.technicalDepth ?? 50) > 85) {
    return `Extremely brief (${d.brevity}) but deeply technical (${d.technicalDepth}) — the haiku engineer`;
  }

  return null;
}
