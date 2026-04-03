/**
 * Prompt builder for Atlas tweet generation.
 * Translates mixed-scale voice profile dimensions into natural language style instructions.
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

interface PromptParams {
  voiceProfile: VoiceDimensions;
  sourceContent: string;
  sourceType: string;
  blendVoices?: BlendVoice[];
  feedback?: string;
  researchContext?: string;
  replyAngle?: string;
}

/** Prefix extreme dimension values with IMPORTANT for LLM emphasis */
function emphasize(line: string, value: number, scale: 100 | 10): string {
  const isExtreme = scale === 100
    ? (value > 80 || value < 20)
    : (value > 8 || value < 2);
  return isExtreme ? `IMPORTANT: ${line}` : line;
}

function describeHumor(v: number): string {
  if (v <= 20) return "Completely serious and professional tone. No humor.";
  if (v <= 40) return "Mostly serious, occasional dry wit when it lands naturally.";
  if (v <= 60) return "Balanced — sprinkle in clever observations or light humor when natural.";
  if (v <= 80) return "Frequently witty. Use irony, wordplay, or playful takes.";
  return "Heavily comedic. Lead with jokes, memes, or absurdist takes.";
}

function describeFormality(v: number): string {
  if (v <= 20) return "Extremely casual. Internet slang, abbreviations, lowercase okay.";
  if (v <= 40) return "Casual and conversational. Like texting a smart friend.";
  if (v <= 60) return "Professional but approachable. Clear and direct.";
  if (v <= 80) return "Formal and polished. Industry-standard vocabulary.";
  return "Highly formal. Academic or institutional tone.";
}

function describeBrevity(v: number): string {
  if (v <= 20) return "Use the full 280 characters. Elaborate and thorough.";
  if (v <= 40) return "Lean longer. Provide context and explanation.";
  if (v <= 60) return "Moderate length. Say what needs saying, no more.";
  if (v <= 80) return "Keep it tight. Punchy, direct statements.";
  return "Ultra-brief. One-liners. Maximum impact in minimum words.";
}

function describeContrarian(v: number): string {
  if (v <= 20) return "Mainstream, consensus-aligned takes.";
  if (v <= 40) return "Mostly consensus but willing to question assumptions gently.";
  if (v <= 60) return "Independent thinker. Present alternative angles others miss.";
  if (v <= 80) return "Contrarian. Challenge popular narratives, propose counter-arguments.";
  return "Strongly contrarian. Take the opposite position. Provocative and bold.";
}

function describeDirectness(v: number): string {
  if (v <= 2) return "Indirect and careful. Ease into the point with nuance.";
  if (v <= 4) return "Diplomatic. Soften claims and leave room for interpretation.";
  if (v <= 6) return "Clear and straightforward. State the point without over-explaining.";
  if (v <= 8) return "Blunt and decisive. Lead with the conclusion and trim the filler.";
  return "Exceptionally direct. Sharp, unvarnished, and immediately to the point.";
}

function describeWarmth(v: number): string {
  if (v <= 2) return "Cool and detached. Prioritize analysis over emotional connection.";
  if (v <= 4) return "Reserved. Friendly enough, but not especially affectionate.";
  if (v <= 6) return "Balanced warmth. Human and approachable without sounding soft.";
  if (v <= 8) return "Warm and encouraging. Sound generous, empathetic, and constructive.";
  return "Very warm. Radiate enthusiasm, support, and human connection.";
}

function describeTechnicalDepth(v: number): string {
  if (v <= 2) return "Keep it accessible. Avoid jargon and deep implementation detail.";
  if (v <= 4) return "Lightly technical. Use simple concepts and only necessary terminology.";
  if (v <= 6) return "Moderately technical. Include substance without overwhelming the reader.";
  if (v <= 8) return "Deeply technical. Bring in mechanisms, frameworks, and nuanced detail.";
  return "Highly technical. Dense expertise is welcome if it sharpens the insight.";
}

function describeConfidence(v: number): string {
  if (v <= 2) return "Tentative and exploratory. Signal uncertainty openly.";
  if (v <= 4) return "Measured confidence. Avoid overclaiming and hedge when appropriate.";
  if (v <= 6) return "Steady confidence. Sound credible and composed.";
  if (v <= 8) return "Assertive. Make crisp claims and sound conviction.";
  return "Extremely confident. Bold, declarative, and highly assured.";
}

function describeEvidenceOrientation(v: number): string {
  if (v <= 2) return "Lean on instinct and framing more than proof points.";
  if (v <= 4) return "Use evidence selectively. A supporting fact is enough.";
  if (v <= 6) return "Balance opinion with evidence. Ground claims when it adds clarity.";
  if (v <= 8) return "Evidence-forward. Prefer concrete facts, data, and observable signals.";
  return "Highly evidence-driven. Anchor the take in proof, mechanisms, and receipts.";
}

function describeSolutionOrientation(v: number): string {
  if (v <= 2) return "Mostly diagnose or observe. Do not force a prescription.";
  if (v <= 4) return "Offer light implications, but keep the focus on the analysis.";
  if (v <= 6) return "Blend diagnosis with next steps when useful.";
  if (v <= 8) return "Solution-oriented. Emphasize what should happen next.";
  return "Strongly solution-first. Turn the insight into a concrete recommendation or action.";
}

function describeSocialPosture(v: number): string {
  if (v <= 2) return "Detached observer. Minimal social signaling or community language.";
  if (v <= 4) return "Independent voice. Engage lightly without sounding communal.";
  if (v <= 6) return "Balanced social posture. Mix personal perspective with audience awareness.";
  if (v <= 8) return "Community-facing. Invite shared understanding and collective framing.";
  return "Highly social. Sound plugged-in, participatory, and conversation-oriented.";
}

function describeSelfPromotionalIntensity(v: number): string {
  if (v <= 2) return "Avoid self-reference. Keep the spotlight on the idea.";
  if (v <= 4) return "Minimal self-promotion. Mention your perspective only when necessary.";
  if (v <= 6) return "Occasional self-positioning is fine if it adds credibility.";
  if (v <= 8) return "Moderately self-promotional. Confidently signal taste, track record, or brand.";
  return "High self-promotion. Lean into personal brand, authority, and status signals.";
}

function normalizeTenPointDimension(value?: number): number {
  return value ?? 5;
}

function getSourceTypeInstruction(sourceType: string): string {
  switch (sourceType) {
    case "REPORT":
      return "Distill the key finding from this report into a tweet-sized insight. Lead with the takeaway.";
    case "ARTICLE":
      return "React to this article's core thesis. Share your perspective, not a summary.";
    case "TWEET":
      return "Quote-tweet or respond to this tweet. Add your unique angle or hot take.";
    case "TRENDING_TOPIC":
      return "Give a hot take on this trending topic. Be timely and opinionated.";
    case "VOICE_NOTE":
      return "Turn this rough idea into a polished tweet. Preserve the core point but tighten the language.";
    case "MANUAL":
    default:
      return "Turn this idea into a compelling tweet. Make it engaging and shareable.";
  }
}

export function buildTweetPrompt(params: PromptParams): { system: string; userMessage: string } {
  const { voiceProfile, sourceContent, sourceType, blendVoices, feedback } = params;
  const directness = normalizeTenPointDimension(voiceProfile.directness);
  const warmth = normalizeTenPointDimension(voiceProfile.warmth);
  const technicalDepth = normalizeTenPointDimension(voiceProfile.technicalDepth);
  const confidence = normalizeTenPointDimension(voiceProfile.confidence);
  const evidenceOrientation = normalizeTenPointDimension(voiceProfile.evidenceOrientation);
  const solutionOrientation = normalizeTenPointDimension(voiceProfile.solutionOrientation);
  const socialPosture = normalizeTenPointDimension(voiceProfile.socialPosture);
  const selfPromotionalIntensity = normalizeTenPointDimension(voiceProfile.selfPromotionalIntensity);

  // Build the voice description with emphasis on extreme values
  const voiceDescription = [
    emphasize(`- Humor (${voiceProfile.humor}/100): ${describeHumor(voiceProfile.humor)}`, voiceProfile.humor, 100),
    emphasize(`- Formality (${voiceProfile.formality}/100): ${describeFormality(voiceProfile.formality)}`, voiceProfile.formality, 100),
    emphasize(`- Brevity (${voiceProfile.brevity}/100): ${describeBrevity(voiceProfile.brevity)}`, voiceProfile.brevity, 100),
    emphasize(`- Contrarian tone (${voiceProfile.contrarianTone}/100): ${describeContrarian(voiceProfile.contrarianTone)}`, voiceProfile.contrarianTone, 100),
    emphasize(`- Directness (${directness}/10): ${describeDirectness(directness)}`, directness, 10),
    emphasize(`- Warmth (${warmth}/10): ${describeWarmth(warmth)}`, warmth, 10),
    emphasize(`- Technical depth (${technicalDepth}/10): ${describeTechnicalDepth(technicalDepth)}`, technicalDepth, 10),
    emphasize(`- Confidence (${confidence}/10): ${describeConfidence(confidence)}`, confidence, 10),
    emphasize(`- Evidence orientation (${evidenceOrientation}/10): ${describeEvidenceOrientation(evidenceOrientation)}`, evidenceOrientation, 10),
    emphasize(`- Solution orientation (${solutionOrientation}/10): ${describeSolutionOrientation(solutionOrientation)}`, solutionOrientation, 10),
    emphasize(`- Social posture (${socialPosture}/10): ${describeSocialPosture(socialPosture)}`, socialPosture, 10),
    emphasize(`- Self-promotional intensity (${selfPromotionalIntensity}/10): ${describeSelfPromotionalIntensity(selfPromotionalIntensity)}`, selfPromotionalIntensity, 10),
  ].join("\n");

  let system = `You are Atlas, a crypto analyst's tweet-crafting AI. You generate tweets styled to the user's voice profile.

## Voice Profile
${voiceDescription}

## Rules
- Output ONLY the tweet text. No quotes, no explanations, no preamble.
- Stay within 280 characters. This is a hard limit.
- No hashtags unless the voice style explicitly demands them (very casual + high humor).
- Sound like a real person, not a bot. No corporate speak.
- ${getSourceTypeInstruction(sourceType)}`;

  // Add blend instructions if applicable
  if (blendVoices && blendVoices.length > 0) {
    const blendDesc = blendVoices
      .map((v) => `${v.percentage}% ${v.label}`)
      .join(" + ");
    system += `\n\n## Voice Blend\nYour writing style is a blend of: ${blendDesc}. Channel the tonal qualities of each reference proportionally.`;
  }

  // Add research context if available (from OpenAI deep research)
  if (params.researchContext) {
    system += `\n\n## Research Context\n${params.researchContext}\nUse these facts to make your tweet more insightful and data-driven. Don't cite sources — just weave the knowledge in naturally.`;
  }

  // Add reply angle if specified
  if (params.replyAngle) {
    const angleInstructions: Record<string, string> = {
      Direct: "State your position clearly and firmly. No hedging.",
      Curious: "Ask a thoughtful question that adds to the discussion. Show genuine interest.",
      Concise: "Keep it short — one punchy line that lands. Maximum impact, minimum words.",
    };
    system += `\n\n## Reply Angle\nApproach this as a "${params.replyAngle}" reply. ${angleInstructions[params.replyAngle] || ""}`;
  }

  // Add feedback if this is a refinement
  if (feedback) {
    system += `\n\n## Refinement Request\nThe user gave this feedback on a previous version: "${feedback}"\nAdjust your output based on this feedback while maintaining the voice profile.`;
  }

  const sourceLabel = sourceType.replace("_", " ").toLowerCase();
  const userMessage = `[${sourceLabel}]\n${sourceContent}`;

  return { system, userMessage };
}
