/**
 * Prompt builder for Atlas tweet generation.
 * Translates voice profile dimensions (0-100) into natural language style instructions.
 */

interface VoiceDimensions {
  humor: number;
  formality: number;
  brevity: number;
  contrarianTone: number;
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

  // Build the voice description
  const voiceDescription = [
    `- Humor: ${describeHumor(voiceProfile.humor)}`,
    `- Formality: ${describeFormality(voiceProfile.formality)}`,
    `- Brevity: ${describeBrevity(voiceProfile.brevity)}`,
    `- Contrarian edge: ${describeContrarian(voiceProfile.contrarianTone)}`,
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

  // Add feedback if this is a refinement
  if (feedback) {
    system += `\n\n## Refinement Request\nThe user gave this feedback on a previous version: "${feedback}"\nAdjust your output based on this feedback while maintaining the voice profile.`;
  }

  const sourceLabel = sourceType.replace("_", " ").toLowerCase();
  const userMessage = `[${sourceLabel}]\n${sourceContent}`;

  return { system, userMessage };
}
