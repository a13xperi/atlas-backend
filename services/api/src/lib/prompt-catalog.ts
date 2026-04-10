/**
 * Prompt Catalog — developer-facing registry of every AI prompt in Atlas.
 *
 * Powers the /admin/prompts page (Prompt Inspector). Each entry mirrors the
 * real prompt template used in the codebase, with {{variable}} slots so Alex
 * can inspect and test them live without running the full generation pipeline.
 */

export type PromptCategory = "generation" | "calibration" | "oracle" | "analysis";

export interface PromptVariable {
  name: string;
  description: string;
  example: string;
}

export interface PromptConfig {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  userPromptTemplate: string;
  variables: PromptVariable[];
  model: string;
  category: PromptCategory;
}

// ── draft-generation ──────────────────────────────────────────────────
// Mirrors services/api/src/lib/prompt.ts :: buildTweetPrompt()
// Kept as a representative template (simplified so variables are exposed
// as clean slots for Alex to inspect and override).
const DRAFT_GENERATION_SYSTEM = `You are Atlas, a crypto analyst's tweet-crafting AI. You generate tweets styled to the user's voice profile.

## Voice Profile
- Humor ({{humor}}/100)
- Formality ({{formality}}/100)
- Brevity ({{brevity}}/100)
- Contrarian tone ({{contrarianTone}}/100)

## Voice Summary
{{voiceAnalysis}}

## Rules
- Output ONLY the tweet text. No quotes, no explanations, no preamble.
- Stay within 280 characters. This is a hard limit.
- No hashtags unless the voice style explicitly demands them.
- Sound like a real person, not a bot. No corporate speak.
- Never use em dashes. Use a short hyphen instead.
- {{sourceTypeInstruction}}`;

const DRAFT_GENERATION_USER = `[{{sourceType}}]
{{sourceContent}}`;

// ── oracle-chat ───────────────────────────────────────────────────────
// Mirrors services/api/src/lib/oracle-prompt.ts :: buildOracleSystemPrompt()
const ORACLE_CHAT_SYSTEM = `You are The Oracle — the AI guide inside Atlas by Delphi Digital.
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

Never use bullet points or numbered lists. Speak in natural sentences. Keep it under 50 words.
Never use em dashes. Use a regular hyphen instead.`;

const ORACLE_CHAT_USER = `User handle: @{{handle}}
Current onboarding step: {{step}}

User says: {{userMessage}}`;

// ── voice-calibration ─────────────────────────────────────────────────
// Mirrors services/api/src/lib/calibrate.ts :: CALIBRATION_PROMPT
const VOICE_CALIBRATION_SYSTEM = `You are a writing style analyst specializing in social media voice profiling for crypto/finance Twitter.

Analyze the following tweets from a single author and determine their writing style across 12 dimensions.

**Core Voice (0-100 scale):**
1. humor (0-100): 0 = completely serious, 50 = occasional wit, 100 = constantly comedic
2. formality (0-100): 0 = extremely casual, 50 = conversational, 100 = academic
3. brevity (0-100): 0 = long-form, 50 = medium, 100 = ultra-concise one-liners
4. contrarianTone (0-100): 0 = mainstream consensus, 50 = balanced, 100 = provocative hot takes

**Communication Style (0-10 scale):**
5. directness, 6. warmth, 7. technicalDepth, 8. confidence

**Content Approach (0-10 scale):**
9. evidenceOrientation, 10. solutionOrientation, 11. socialPosture, 12. selfPromotionalIntensity

Respond with ONLY valid JSON containing all 12 dimensions, calibrationConfidence (0.0-1.0), and a 2-3 sentence analysis.

Be precise. Base your scores on patterns across ALL tweets, not individual outliers.`;

const VOICE_CALIBRATION_USER = `Analyze these {{tweetCount}} tweets from @{{handle}}:

{{tweetBlock}}`;

// ── blend-preview ─────────────────────────────────────────────────────
// Mirrors services/api/src/lib/oracle-prompt.ts :: buildBlendPreview()
const BLEND_PREVIEW_SYSTEM = `${ORACLE_CHAT_SYSTEM}

You are generating a sample tweet to preview the user's blended voice. Write exactly one tweet (under 280 characters). No quotation marks, no meta-commentary — just the tweet itself.`;

const BLEND_PREVIEW_USER = `Voice dimensions: Humor {{humor}}/100, Formality {{formality}}/100, Brevity {{brevity}}/100, Contrarian {{contrarianTone}}/100
Blend: {{blendDescription}}

Write a sample tweet about {{topic}} in this voice. Just the tweet, nothing else.`;

export const PROMPT_CATALOG: PromptConfig[] = [
  {
    id: "draft-generation",
    name: "Draft Generation",
    description:
      "The core tweet-crafting prompt. Translates a source (report, article, tweet, idea) into a tweet shaped by the user's 12-dimension voice profile.",
    systemPrompt: DRAFT_GENERATION_SYSTEM,
    userPromptTemplate: DRAFT_GENERATION_USER,
    variables: [
      {
        name: "humor",
        description: "Humor dimension (0-100). Higher = more comedic.",
        example: "55",
      },
      {
        name: "formality",
        description: "Formality dimension (0-100). Higher = more academic.",
        example: "40",
      },
      {
        name: "brevity",
        description: "Brevity dimension (0-100). Higher = tighter, punchier.",
        example: "75",
      },
      {
        name: "contrarianTone",
        description: "Contrarian dimension (0-100). Higher = more provocative.",
        example: "65",
      },
      {
        name: "voiceAnalysis",
        description: "Natural language voice summary from calibration.",
        example: "Sharp, opinionated, evidence-first crypto analyst.",
      },
      {
        name: "sourceTypeInstruction",
        description: "How to treat the source (REPORT/ARTICLE/TWEET/etc).",
        example: "React to this article's core thesis. Share your perspective, not a summary.",
      },
      {
        name: "sourceType",
        description: "Source type label shown in the user message.",
        example: "report",
      },
      {
        name: "sourceContent",
        description: "The raw content to tweet about.",
        example: "Solana TVL hit $8B this week, overtaking BNB Chain for the first time since 2022.",
      },
    ],
    model: "claude-opus-4-1-20250805",
    category: "generation",
  },
  {
    id: "oracle-chat",
    name: "Oracle Chat",
    description:
      "The Oracle's personality and system prompt — used for onboarding guidance, dimension explanations, and the persistent copilot widget. Same brain across portal and Telegram.",
    systemPrompt: ORACLE_CHAT_SYSTEM,
    userPromptTemplate: ORACLE_CHAT_USER,
    variables: [
      {
        name: "handle",
        description: "User's X/Twitter handle.",
        example: "hasufl",
      },
      {
        name: "step",
        description: "Current onboarding step.",
        example: "calibration-review",
      },
      {
        name: "userMessage",
        description: "The user's free-text message to the Oracle.",
        example: "Should I lean into my contrarian side or soften it?",
      },
    ],
    model: "claude-haiku-4-5-20251001",
    category: "oracle",
  },
  {
    id: "voice-calibration",
    name: "Voice Calibration",
    description:
      "Analyzes a batch of tweets and returns calibrated values for all 12 voice dimensions plus a natural-language voice summary. Called from POST /api/voice/calibrate.",
    systemPrompt: VOICE_CALIBRATION_SYSTEM,
    userPromptTemplate: VOICE_CALIBRATION_USER,
    variables: [
      {
        name: "handle",
        description: "X/Twitter handle being calibrated.",
        example: "cobie",
      },
      {
        name: "tweetCount",
        description: "Number of tweets in the batch.",
        example: "30",
      },
      {
        name: "tweetBlock",
        description: "Numbered, newline-separated list of tweet texts.",
        example: "[1] gm\n\n[2] the cycle is clearly not over\n\n[3] bullish on attention",
      },
    ],
    model: "claude-sonnet-4-6",
    category: "calibration",
  },
  {
    id: "blend-preview",
    name: "Blend Preview",
    description:
      "Generates a sample tweet in the user's freshly-blended voice, so they can preview what their blend 'sounds like' before committing. Used in the Voice Library blend flow.",
    systemPrompt: BLEND_PREVIEW_SYSTEM,
    userPromptTemplate: BLEND_PREVIEW_USER,
    variables: [
      {
        name: "humor",
        description: "Blended humor dimension (0-100).",
        example: "60",
      },
      {
        name: "formality",
        description: "Blended formality dimension (0-100).",
        example: "35",
      },
      {
        name: "brevity",
        description: "Blended brevity dimension (0-100).",
        example: "80",
      },
      {
        name: "contrarianTone",
        description: "Blended contrarian dimension (0-100).",
        example: "70",
      },
      {
        name: "blendDescription",
        description: "Comma-separated blend labels and percentages.",
        example: "Cobie: 60%, Hasu: 40%",
      },
      {
        name: "topic",
        description: "Topic the preview tweet should be about.",
        example: "Solana's TVL milestone",
      },
    ],
    model: "claude-haiku-4-5-20251001",
    category: "generation",
  },
];

/** Return the full catalog. */
export function getPromptCatalog(): PromptConfig[] {
  return PROMPT_CATALOG;
}

/** Look up a single prompt config by id. */
export function getPromptById(id: string): PromptConfig | null {
  return PROMPT_CATALOG.find((p) => p.id === id) ?? null;
}

/**
 * Substitute {{variable}} placeholders in a template with values from the
 * provided record. Missing variables are replaced with a visible placeholder
 * so test runs surface problems clearly rather than silently dropping.
 */
export function renderTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => {
    const value = variables[name];
    if (value === undefined || value === null || value === "") {
      return `[${name}]`;
    }
    return String(value);
  });
}
