/**
 * Voice Dimension Insights — feedback loop scoring engine.
 *
 * Correlates voice dimension values used during tweet generation
 * with actual engagement metrics to produce actionable recommendations.
 *
 * Minimum 10 posted drafts with engagement data required.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { logger } from "./logger";

// The 12 voice dimensions tracked by Atlas
const DIMENSION_KEYS = [
  "humor",
  "formality",
  "brevity",
  "contrarianTone",
  "directness",
  "warmth",
  "technicalDepth",
  "confidence",
  "evidenceOrientation",
  "solutionOrientation",
  "socialPosture",
  "selfPromotionalIntensity",
] as const;

type DimensionKey = (typeof DIMENSION_KEYS)[number];

const MIN_SAMPLE_SIZE = 10;

interface EngagementMetrics {
  likes?: number;
  retweets?: number;
  impressions?: number;
  replies?: number;
  bookmarks?: number;
}

interface DraftWithDimensions {
  id: string;
  voiceDimensionsSnapshot: Record<string, number>;
  engagementMetrics: EngagementMetrics;
  actualEngagement: number | null;
}

export interface DimensionScore {
  dimension: DimensionKey;
  correlation: number; // -1 to 1 — Pearson correlation with performance
  avgValueHighPerformers: number; // avg value among top-quartile drafts
  avgValueLowPerformers: number; // avg value among bottom-quartile drafts
  impact: "positive" | "negative" | "neutral";
  recommendation: string;
}

export interface DimensionCombination {
  dimensions: Partial<Record<DimensionKey, "high" | "low">>;
  avgPerformance: number;
  count: number;
}

export interface VoiceInsights {
  sampleSize: number;
  avgPerformanceScore: number;
  dimensionScores: DimensionScore[];
  topCombinations: DimensionCombination[];
  recommendations: string[];
  computedAt: string;
}

/**
 * Compute a composite performance score from raw engagement metrics.
 * Weights: impressions 1x (reach), likes 3x (resonance), retweets 5x (amplification).
 */
function computePerformanceScore(metrics: EngagementMetrics): number {
  const impressions = metrics.impressions ?? 0;
  const likes = metrics.likes ?? 0;
  const retweets = metrics.retweets ?? 0;
  const replies = metrics.replies ?? 0;
  const bookmarks = metrics.bookmarks ?? 0;

  // Composite: weighted sum normalized by impressions to get engagement rate
  // If no impressions, fall back to raw engagement counts
  if (impressions > 0) {
    const engagementRate =
      (likes * 3 + retweets * 5 + replies * 2 + bookmarks * 4) / impressions;
    // Scale to 0-100 range (typical engagement rate is 1-5%)
    return Math.min(100, engagementRate * 1000);
  }

  // Fallback: raw count scoring
  return likes * 3 + retweets * 5 + replies * 2 + bookmarks * 4;
}

/**
 * Pearson correlation coefficient between two arrays.
 */
function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;

  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  const denom = Math.sqrt(denomX * denomY);
  if (denom === 0) return 0;

  return numerator / denom;
}

/**
 * Generate a human-readable recommendation for a dimension.
 */
function generateRecommendation(
  dimension: DimensionKey,
  correlation: number,
  avgHigh: number,
  avgLow: number,
): string {
  const dimLabel = dimension
    .replace(/([A-Z])/g, " $1")
    .toLowerCase()
    .trim();

  const absCorr = Math.abs(correlation);

  if (absCorr < 0.15) {
    return `${dimLabel} has minimal impact on engagement — keep at your preferred level.`;
  }

  const pctDiff = avgHigh > 0 ? Math.round(((avgHigh - avgLow) / avgLow) * 100) : 0;
  const direction = correlation > 0 ? "higher" : "lower";
  const targetValue = correlation > 0 ? Math.round(avgHigh) : Math.round(avgLow);

  if (absCorr >= 0.4) {
    return `Strong signal: tweets perform ${Math.abs(pctDiff)}% better when ${dimLabel} is ${direction}. Target ~${targetValue}/100.`;
  }

  return `Moderate signal: ${dimLabel} around ${targetValue}/100 correlates with better engagement.`;
}

/**
 * Identify top-performing dimension combinations using quartile analysis.
 */
function findTopCombinations(
  drafts: Array<{ dimensions: Record<string, number>; performance: number }>,
): DimensionCombination[] {
  if (drafts.length < 8) return [];

  // Sort by performance, take top quartile
  const sorted = [...drafts].sort((a, b) => b.performance - a.performance);
  const topQuartile = sorted.slice(0, Math.ceil(sorted.length / 4));

  // For each dimension, determine if top performers tend to be high (>60) or low (<40)
  const patterns: Partial<Record<DimensionKey, "high" | "low">> = {};

  for (const dim of DIMENSION_KEYS) {
    const topValues = topQuartile.map((d) => d.dimensions[dim]).filter((v) => v != null);
    if (topValues.length === 0) continue;

    const avgTop = topValues.reduce((a, b) => a + b, 0) / topValues.length;
    if (avgTop > 60) patterns[dim] = "high";
    else if (avgTop < 40) patterns[dim] = "low";
    // 40-60 is neutral, not included
  }

  const topAvg =
    topQuartile.reduce((a, b) => a + b.performance, 0) / topQuartile.length;

  const combinations: DimensionCombination[] = [];

  // Only include if we found at least 2 distinguishing dimensions
  const patternKeys = Object.keys(patterns) as DimensionKey[];
  if (patternKeys.length >= 2) {
    combinations.push({
      dimensions: patterns,
      avgPerformance: Math.round(topAvg * 10) / 10,
      count: topQuartile.length,
    });
  }

  return combinations;
}

/**
 * Compute voice dimension insights for a user.
 * Returns null if insufficient data.
 */
export async function computeVoiceInsights(
  userId: string,
): Promise<VoiceInsights | null> {
  // Fetch posted drafts with both voice dimensions snapshot and engagement data
  const drafts = await prisma.tweetDraft.findMany({
    where: {
      userId,
      status: "POSTED",
      voiceDimensionsSnapshot: { not: Prisma.DbNull },
      engagementMetrics: { not: Prisma.DbNull },
    },
    select: {
      id: true,
      voiceDimensionsSnapshot: true,
      engagementMetrics: true,
      actualEngagement: true,
    },
  });

  if (drafts.length < MIN_SAMPLE_SIZE) {
    return null;
  }

  // Parse and score each draft
  const scored = drafts
    .map((draft) => {
      const dimensions = draft.voiceDimensionsSnapshot as Record<string, number> | null;
      const metrics = draft.engagementMetrics as EngagementMetrics | null;

      if (!dimensions || !metrics) return null;

      return {
        id: draft.id,
        dimensions,
        metrics,
        performance: computePerformanceScore(metrics),
      };
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);

  if (scored.length < MIN_SAMPLE_SIZE) {
    return null;
  }

  const performances = scored.map((d) => d.performance);
  const avgPerformance =
    performances.reduce((a, b) => a + b, 0) / performances.length;

  // Sort by performance for quartile analysis
  const sortedByPerf = [...scored].sort((a, b) => b.performance - a.performance);
  const topQuartileIdx = Math.ceil(scored.length / 4);
  const bottomQuartileStart = scored.length - topQuartileIdx;

  // Compute per-dimension correlation and quartile analysis
  const dimensionScores: DimensionScore[] = [];

  for (const dim of DIMENSION_KEYS) {
    const dimValues = scored.map((d) => d.dimensions[dim] ?? 50);
    const correlation = pearsonCorrelation(dimValues, performances);

    const topValues = sortedByPerf
      .slice(0, topQuartileIdx)
      .map((d) => d.dimensions[dim] ?? 50);
    const bottomValues = sortedByPerf
      .slice(bottomQuartileStart)
      .map((d) => d.dimensions[dim] ?? 50);

    const avgHigh =
      topValues.length > 0
        ? topValues.reduce((a, b) => a + b, 0) / topValues.length
        : 50;
    const avgLow =
      bottomValues.length > 0
        ? bottomValues.reduce((a, b) => a + b, 0) / bottomValues.length
        : 50;

    const absCorr = Math.abs(correlation);
    const impact: "positive" | "negative" | "neutral" =
      absCorr < 0.15 ? "neutral" : correlation > 0 ? "positive" : "negative";

    dimensionScores.push({
      dimension: dim,
      correlation: Math.round(correlation * 1000) / 1000,
      avgValueHighPerformers: Math.round(avgHigh),
      avgValueLowPerformers: Math.round(avgLow),
      impact,
      recommendation: generateRecommendation(dim, correlation, avgHigh, avgLow),
    });
  }

  // Sort by absolute correlation strength (most impactful first)
  dimensionScores.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

  // Find top-performing dimension combinations
  const topCombinations = findTopCombinations(scored);

  // Generate top-level recommendations
  const recommendations: string[] = [];
  const strongDims = dimensionScores.filter(
    (d) => Math.abs(d.correlation) >= 0.3,
  );
  const weakDims = dimensionScores.filter(
    (d) => d.impact === "negative" && Math.abs(d.correlation) >= 0.2,
  );

  if (strongDims.length > 0) {
    const topDim = strongDims[0];
    const dimLabel = topDim.dimension
      .replace(/([A-Z])/g, " $1")
      .toLowerCase()
      .trim();
    recommendations.push(
      `Your strongest engagement driver is ${dimLabel} — keep it around ${topDim.avgValueHighPerformers}/100.`,
    );
  }

  if (weakDims.length > 0) {
    const weakDim = weakDims[0];
    const dimLabel = weakDim.dimension
      .replace(/([A-Z])/g, " $1")
      .toLowerCase()
      .trim();
    recommendations.push(
      `Consider adjusting ${dimLabel} — currently correlating with lower engagement.`,
    );
  }

  if (topCombinations.length > 0) {
    const combo = topCombinations[0];
    const dims = Object.entries(combo.dimensions)
      .map(
        ([k, v]) =>
          `${k.replace(/([A-Z])/g, " $1").toLowerCase().trim()} ${v}`,
      )
      .join(", ");
    recommendations.push(
      `Your best-performing voice pattern: ${dims} (avg score: ${combo.avgPerformance}).`,
    );
  }

  if (recommendations.length === 0) {
    recommendations.push(
      "No strong patterns detected yet. Keep posting and the algorithm will refine its recommendations.",
    );
  }

  const insights: VoiceInsights = {
    sampleSize: scored.length,
    avgPerformanceScore: Math.round(avgPerformance * 10) / 10,
    dimensionScores,
    topCombinations,
    recommendations,
    computedAt: new Date().toISOString(),
  };

  // Persist to database
  try {
    await prisma.voiceDimensionInsight.upsert({
      where: { userId },
      update: {
        sampleSize: insights.sampleSize,
        avgPerformanceScore: insights.avgPerformanceScore,
        dimensionScores: insights.dimensionScores as any,
        topCombinations: insights.topCombinations as any,
        recommendations: insights.recommendations,
        computedAt: new Date(),
      },
      create: {
        userId,
        sampleSize: insights.sampleSize,
        avgPerformanceScore: insights.avgPerformanceScore,
        dimensionScores: insights.dimensionScores as any,
        topCombinations: insights.topCombinations as any,
        recommendations: insights.recommendations,
      },
    });
  } catch (err: any) {
    logger.error({ err: err.message, userId }, "Failed to persist voice dimension insights");
  }

  return insights;
}

/**
 * Get cached insights or recompute if stale (>1 hour old).
 */
export async function getVoiceInsights(
  userId: string,
): Promise<VoiceInsights | null> {
  // Check for cached insights
  const cached = await prisma.voiceDimensionInsight.findUnique({
    where: { userId },
  });

  const ONE_HOUR = 60 * 60 * 1000;
  const isStale =
    !cached || Date.now() - cached.computedAt.getTime() > ONE_HOUR;

  if (cached && !isStale) {
    return {
      sampleSize: cached.sampleSize,
      avgPerformanceScore: cached.avgPerformanceScore ?? 0,
      dimensionScores: (cached.dimensionScores as unknown as DimensionScore[]) ?? [],
      topCombinations:
        (cached.topCombinations as unknown as DimensionCombination[]) ?? [],
      recommendations: (cached.recommendations as unknown as string[]) ?? [],
      computedAt: cached.computedAt.toISOString(),
    };
  }

  // Recompute
  return computeVoiceInsights(userId);
}
