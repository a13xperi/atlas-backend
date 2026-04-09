import { completeWith } from "./providers";

export type InsightAngle =
  | "contrarian take"
  | "data highlight"
  | "prediction"
  | "practical advice"
  | "narrative arc"
  | "hot take"
  | "explainer";

export interface Insight {
  title: string;
  summary: string;
  keyQuote: string;
  angle: InsightAngle;
}

interface ExtractInsightsOptions {
  limit?: number;
}

const VALID_ANGLES = new Set<InsightAngle>([
  "contrarian take",
  "data highlight",
  "prediction",
  "practical advice",
  "narrative arc",
  "hot take",
  "explainer",
]);

function clampLimit(limit?: number): number {
  const value = limit ?? 5;
  return Math.min(Math.max(value, 1), 10);
}

function buildSystemPrompt(limit: number): string {
  return `You are an expert content analyst for crypto Twitter.

Read the long-form source content and extract up to ${limit} distinct, tweetable insights.

For each insight, provide:
- title: a concise label (5-10 words)
- summary: 1-2 sentences capturing the core point
- keyQuote: the strongest sentence, claim, or data point supporting the insight (exact quote when possible, close paraphrase otherwise)
- angle: one of "contrarian take", "data highlight", "prediction", "practical advice", "narrative arc", "hot take", "explainer"

Rules:
- Each insight must be materially distinct.
- Prefer insights with concrete numbers, mechanisms, or falsifiable claims.
- Include at least one insight that is bold, contrarian, or surprising when the source supports it.
- Order by tweet-worthiness.
- Output valid JSON only.

Output format:
[
  { "title": "...", "summary": "...", "keyQuote": "...", "angle": "..." }
]`;
}

function parseInsights(raw: string, limit: number): Insight[] {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Failed to parse insight extraction response as JSON");
  }

  const items = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { insights?: unknown[] }).insights)
      ? (parsed as { insights: unknown[] }).insights
      : null;

  if (!items) {
    throw new Error("Insight extraction response is not an array");
  }

  const insights = items
    .filter(
      (item): item is { title: string; summary: string; keyQuote: string; angle: string } =>
        !!item &&
        typeof item === "object" &&
        typeof (item as { title?: unknown }).title === "string" &&
        typeof (item as { summary?: unknown }).summary === "string" &&
        typeof (item as { keyQuote?: unknown }).keyQuote === "string" &&
        typeof (item as { angle?: unknown }).angle === "string",
    )
    .map((item) => ({
      title: item.title.trim(),
      summary: item.summary.trim(),
      keyQuote: item.keyQuote.trim(),
      angle: VALID_ANGLES.has(item.angle as InsightAngle)
        ? (item.angle as InsightAngle)
        : "explainer",
    }))
    .filter((item) => item.title && item.summary && item.keyQuote)
    .slice(0, limit);

  if (insights.length === 0) {
    throw new Error("No valid insights extracted from content");
  }

  return insights;
}

export async function extractInsights(
  content: string,
  options: ExtractInsightsOptions = {},
): Promise<Insight[]> {
  if (!content || content.trim().length < 50) {
    throw new Error("Content too short for insight extraction (minimum 50 characters)");
  }

  const limit = clampLimit(options.limit);
  const response = await completeWith("anthropic", {
    taskType: "research",
    maxTokens: 2200,
    temperature: 0.4,
    messages: [
      { role: "system", content: buildSystemPrompt(limit) },
      { role: "user", content: content.trim().slice(0, 100_000) },
    ],
  });

  return parseInsights(response.content, limit);
}
