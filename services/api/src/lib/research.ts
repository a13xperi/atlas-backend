import { complete } from "./providers";
import { getCached, setCache } from "./redis";
import crypto from "crypto";

export interface ResearchResult {
  summary: string;
  keyFacts: string[];
  sentiment: "bullish" | "bearish" | "neutral" | "mixed";
  relatedTopics: string[];
  sources: string[];
  confidence: number;
}

interface ResearchParams {
  query: string;
  context?: string;
}

const RESEARCH_SYSTEM_PROMPT = `You are a crypto/finance research analyst. Given a piece of content or query, conduct deep analysis and return structured findings.

You MUST respond with valid JSON matching this exact schema:
{
  "summary": "2-3 sentence summary of key findings",
  "keyFacts": ["fact 1", "fact 2", "fact 3"],
  "sentiment": "bullish" | "bearish" | "neutral" | "mixed",
  "relatedTopics": ["topic 1", "topic 2"],
  "sources": ["known source or reference 1"],
  "confidence": 0.0 to 1.0
}

Focus on:
- Market context and current state
- Key data points and metrics
- Sentiment analysis (bullish/bearish/neutral/mixed)
- Related trends and topics worth mentioning
- Why this matters right now

Be concise but data-rich. Prioritize actionable insights over generic observations.`;

export async function conductResearch(params: ResearchParams): Promise<ResearchResult> {
  const { query, context } = params;

  // Check cache first
  const cacheKey = `research:${crypto.createHash("md5").update(query).digest("hex")}`;
  const cached = await getCached(cacheKey);
  if (cached) {
    return JSON.parse(cached) as ResearchResult;
  }

  const userMessage = context
    ? `[Source type: ${context}]\n\n${query}`
    : query;

  const response = await complete({
    taskType: "research",
    maxTokens: 1000,
    temperature: 0.3,
    jsonMode: true,
    messages: [
      { role: "system", content: RESEARCH_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
  });

  const content = response.content;
  if (!content) throw new Error("Empty response from provider");

  const result = JSON.parse(content) as ResearchResult;

  // Validate and normalize
  result.confidence = Math.min(Math.max(result.confidence || 0.5, 0), 1);
  result.keyFacts = result.keyFacts || [];
  result.relatedTopics = result.relatedTopics || [];
  result.sources = result.sources || [];

  // Cache for 15 minutes
  await setCache(cacheKey, JSON.stringify(result), 900);

  return result;
}
