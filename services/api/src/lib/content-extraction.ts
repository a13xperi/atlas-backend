/**
 * Content Extraction — Analyze long-form content to extract distinct insights.
 *
 * Takes a research PDF text, article body, or any long-form content and uses
 * Claude to identify 3-7 distinct tweetable angles. This is the analysis step
 * before tweet generation.
 */

import { complete } from "./providers";

export interface Insight {
  title: string;
  summary: string;
  keyQuote: string;
  angle:
    | "contrarian take"
    | "data highlight"
    | "prediction"
    | "practical advice"
    | "narrative arc"
    | "hot take"
    | "explainer";
}

const SYSTEM_PROMPT = `You are an expert content analyst for crypto Twitter. Your job is to read long-form content (reports, articles, whitepapers) and extract 3-7 distinct, tweetable insights.

For each insight, provide:
- title: A concise label (5-10 words)
- summary: 1-2 sentences capturing the core point
- keyQuote: The most compelling sentence or data point from the source that supports this insight (exact quote when possible, otherwise a close paraphrase)
- angle: One of: "contrarian take", "data highlight", "prediction", "practical advice", "narrative arc", "hot take", "explainer"

Rules:
- Each insight must be DISTINCT — different angles on the source material
- Prefer insights with concrete data, numbers, or specific claims
- At least one insight should be a contrarian or hot take
- At least one should highlight a specific data point
- Order by tweet-worthiness (most engaging first)
- Output valid JSON only — no markdown, no explanation

Output format:
[
  { "title": "...", "summary": "...", "keyQuote": "...", "angle": "..." },
  ...
]`;

/**
 * Extract 3-7 distinct insights from long-form content using Claude.
 */
export async function extractInsights(content: string): Promise<Insight[]> {
  if (!content || content.trim().length < 50) {
    throw new Error("Content too short for insight extraction (minimum 50 characters)");
  }

  const response = await complete({
    taskType: "research",
    maxTokens: 2000,
    temperature: 0.4,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: content.slice(0, 100_000) },
    ],
  });

  const raw = response.content.trim();

  // Parse JSON — handle potential markdown fencing
  let cleaned = raw;
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Failed to parse insight extraction response as JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Insight extraction response is not an array");
  }

  // Validate and constrain to 3-7 insights
  const validAngles = new Set([
    "contrarian take",
    "data highlight",
    "prediction",
    "practical advice",
    "narrative arc",
    "hot take",
    "explainer",
  ]);

  const insights: Insight[] = parsed
    .filter(
      (item: any) =>
        item &&
        typeof item.title === "string" &&
        typeof item.summary === "string" &&
        typeof item.keyQuote === "string" &&
        typeof item.angle === "string",
    )
    .map((item: any) => ({
      title: item.title,
      summary: item.summary,
      keyQuote: item.keyQuote,
      angle: validAngles.has(item.angle) ? item.angle : "explainer",
    }));

  if (insights.length < 1) {
    throw new Error("No valid insights extracted from content");
  }

  // Clamp to 3-7 range
  return insights.slice(0, 7);
}
