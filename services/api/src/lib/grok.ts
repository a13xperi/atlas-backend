import OpenAI from "openai";
import { config } from "./config";
import { getCached, setCache } from "./redis";
import { withRetry } from "./retry";

// Grok uses OpenAI-compatible API with different base URL
let client: OpenAI | null = null;

export function getGrokClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: config.XAI_API_KEY,
      baseURL: "https://api.x.ai/v1",
    });
  }
  return client;
}

export interface TrendingItem {
  topic: string;
  headline: string;
  context: string;
  tweetUrl?: string;
  sentiment: "bullish" | "bearish" | "neutral" | "mixed";
  relevanceScore: number;
}

interface TrendingSearchParams {
  topics: string[];
  limit?: number;
}

const TRENDING_SYSTEM_PROMPT = `You are a Twitter/X trend analyst specializing in crypto, DeFi, and Web3. Given a list of topics the user follows, identify the most relevant current trending discussions on Twitter/X.

You MUST respond with valid JSON matching this schema:
{
  "trending": [
    {
      "topic": "the category this falls under",
      "headline": "a short, punchy headline summarizing the trend (under 100 chars)",
      "context": "2-3 sentences explaining what's happening and why it matters",
      "tweetUrl": "https://x.com/... (a real or representative tweet URL if known, or null)",
      "sentiment": "bullish" | "bearish" | "neutral" | "mixed",
      "relevanceScore": 0.0 to 1.0
    }
  ]
}

Return 5-10 trending items, ordered by relevance. Focus on:
- Breaking news and developments
- High-engagement discussions and debates
- Notable takes from influential accounts
- Market-moving events
- Emerging narratives

Be specific and current. Include real account names and data points when possible.`;

export async function searchTrending(params: TrendingSearchParams): Promise<TrendingItem[]> {
  const { topics, limit = 10 } = params;

  // Check cache (5 min TTL for trending data)
  const cacheKey = `trending:${topics.sort().join(",")}`;
  const cached = await getCached(cacheKey);
  if (cached) {
    return JSON.parse(cached) as TrendingItem[];
  }

  const client = getGrokClient();

  const response = await withRetry(
    () =>
      client.chat.completions.create({
        model: "grok-3",
        max_tokens: 2000,
        temperature: 0.5,
        messages: [
          { role: "system", content: TRENDING_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Topics I follow: ${topics.join(", ")}\n\nFind me the top ${limit} trending discussions on Twitter/X related to these topics right now.`,
          },
        ],
      }),
    "grok:searchTrending",
  );

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Empty response from Grok");

  // Parse JSON — handle potential markdown code blocks
  const jsonStr = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const parsed = JSON.parse(jsonStr);
  const items: TrendingItem[] = (parsed.trending || parsed).slice(0, limit);

  // Normalize
  for (const item of items) {
    item.relevanceScore = Math.min(Math.max(item.relevanceScore || 0.5, 0), 1);
    item.sentiment = item.sentiment || "neutral";
  }

  // Cache for 5 minutes
  await setCache(cacheKey, JSON.stringify(items), 300);

  return items;
}
