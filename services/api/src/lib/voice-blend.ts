/**
 * Voice Blending Engine — primary + secondary weighting.
 *
 * Takes Twitter user IDs for a primary and optional secondary voice inspirations,
 * fetches their tweets, analyzes style signals, and produces a weighted blended
 * voice profile suitable for tweet generation.
 */

import { fetchUserTweets, lookupUser } from "./twitter";
import { calibrateFromTweets, CalibrationResult } from "./calibrate";
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

export interface StyleSignals {
  avgTweetLength: number;
  emojiRate: number; // emojis per tweet
  hashtagRate: number; // hashtags per tweet
  urlRate: number; // URLs per tweet
  mentionRate: number; // @mentions per tweet
  questionRate: number; // fraction of tweets with ?
  exclamationRate: number; // fraction of tweets with !
  allCapsWordRate: number; // fraction of words in ALL CAPS
  threadRate: number; // fraction that are thread-like (numbered or 1/)
  avgSentenceLength: number;
  tweetCount: number;
}

export interface InspirationProfile {
  twitterId: string;
  handle: string;
  name: string;
  styleSignals: StyleSignals;
  calibration: CalibrationResult;
  tweetCount: number;
}

export interface BlendResult {
  /** Blended 12-dimension voice profile (0-100 each) */
  dimensions: Record<DimensionKey, number>;
  /** Per-inspiration style signals for transparency */
  styleSignals: Record<string, StyleSignals>;
  /** Per-inspiration calibration results */
  inspirationProfiles: InspirationProfile[];
  /** Total tweets analyzed across all inspirations */
  totalTweetsAnalyzed: number;
  /** Human-readable summary of the blend */
  summary: string;
  /** The weights that were applied */
  appliedWeights: Record<string, number>;
}

// --- Style signal extraction ---

const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
const HASHTAG_REGEX = /#\w+/g;
const URL_REGEX = /https?:\/\/\S+/g;
const MENTION_REGEX = /@\w+/g;
const ALL_CAPS_WORD_REGEX = /\b[A-Z]{2,}\b/g;

/**
 * Extract raw style signals from a set of tweets.
 * These are statistical features that don't require AI — purely textual analysis.
 */
export function extractStyleSignals(tweets: string[]): StyleSignals {
  if (tweets.length === 0) {
    return {
      avgTweetLength: 0,
      emojiRate: 0,
      hashtagRate: 0,
      urlRate: 0,
      mentionRate: 0,
      questionRate: 0,
      exclamationRate: 0,
      allCapsWordRate: 0,
      threadRate: 0,
      avgSentenceLength: 0,
      tweetCount: 0,
    };
  }

  const n = tweets.length;
  let totalLength = 0;
  let totalEmojis = 0;
  let totalHashtags = 0;
  let totalUrls = 0;
  let totalMentions = 0;
  let questionsCount = 0;
  let exclamationCount = 0;
  let totalWords = 0;
  let totalCapsWords = 0;
  let threadCount = 0;
  let totalSentences = 0;

  for (const tweet of tweets) {
    totalLength += tweet.length;

    const emojis = tweet.match(EMOJI_REGEX);
    totalEmojis += emojis ? emojis.length : 0;

    const hashtags = tweet.match(HASHTAG_REGEX);
    totalHashtags += hashtags ? hashtags.length : 0;

    const urls = tweet.match(URL_REGEX);
    totalUrls += urls ? urls.length : 0;

    const mentions = tweet.match(MENTION_REGEX);
    totalMentions += mentions ? mentions.length : 0;

    if (tweet.includes("?")) questionsCount++;
    if (tweet.includes("!")) exclamationCount++;

    const words = tweet.split(/\s+/).filter(Boolean);
    totalWords += words.length;

    const capsWords = tweet.match(ALL_CAPS_WORD_REGEX);
    totalCapsWords += capsWords ? capsWords.length : 0;

    // Thread detection: starts with "1/" or "1." or numbered patterns
    if (/^(1\/|1\.|thread:|🧵)/i.test(tweet.trim())) {
      threadCount++;
    }

    // Rough sentence count
    const sentences = tweet.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    totalSentences += sentences.length;
  }

  return {
    avgTweetLength: Math.round(totalLength / n),
    emojiRate: Math.round((totalEmojis / n) * 100) / 100,
    hashtagRate: Math.round((totalHashtags / n) * 100) / 100,
    urlRate: Math.round((totalUrls / n) * 100) / 100,
    mentionRate: Math.round((totalMentions / n) * 100) / 100,
    questionRate: Math.round((questionsCount / n) * 100) / 100,
    exclamationRate: Math.round((exclamationCount / n) * 100) / 100,
    allCapsWordRate:
      totalWords > 0
        ? Math.round((totalCapsWords / totalWords) * 1000) / 1000
        : 0,
    threadRate: Math.round((threadCount / n) * 100) / 100,
    avgSentenceLength:
      totalSentences > 0 ? Math.round(totalWords / totalSentences) : 0,
    tweetCount: n,
  };
}

// --- Weight normalization ---

/**
 * Normalize weights so they sum to 1.0.
 * Primary defaults to 0.7, secondaries split the remaining 0.3 equally.
 */
export function normalizeWeights(
  primaryId: string,
  additionalIds: string[],
  userWeights?: Record<string, number>,
): Record<string, number> {
  const weights: Record<string, number> = {};

  if (userWeights && Object.keys(userWeights).length > 0) {
    // User provided explicit weights — normalize to sum=1
    const allIds = [primaryId, ...additionalIds];
    let total = 0;

    for (const id of allIds) {
      weights[id] = userWeights[id] ?? (id === primaryId ? 0.7 : 0.1);
      total += weights[id];
    }

    // Normalize
    if (total > 0) {
      for (const id of allIds) {
        weights[id] = Math.round((weights[id] / total) * 1000) / 1000;
      }
    }
  } else {
    // Default: primary 70%, secondaries split 30% equally
    weights[primaryId] = 0.7;
    const secondaryWeight =
      additionalIds.length > 0 ? 0.3 / additionalIds.length : 0;
    for (const id of additionalIds) {
      weights[id] = Math.round(secondaryWeight * 1000) / 1000;
    }
  }

  return weights;
}

// --- Blending ---

/**
 * Blend calibration results using weighted averaging.
 */
function blendDimensions(
  profiles: InspirationProfile[],
  weights: Record<string, number>,
): Record<DimensionKey, number> {
  const result: Record<string, number> = {};

  for (const dim of DIMENSION_KEYS) {
    let weightedSum = 0;
    let weightSum = 0;

    for (const profile of profiles) {
      const w = weights[profile.twitterId] ?? 0;
      const value = profile.calibration[dim];
      if (typeof value === "number") {
        weightedSum += value * w;
        weightSum += w;
      }
    }

    result[dim] = weightSum > 0 ? Math.round(weightedSum / weightSum) : 50;
  }

  return result as Record<DimensionKey, number>;
}

/**
 * Generate a human-readable summary of the blend.
 */
function generateBlendSummary(
  profiles: InspirationProfile[],
  weights: Record<string, number>,
): string {
  const primary = profiles.find(
    (p) => weights[p.twitterId] === Math.max(...Object.values(weights)),
  );
  const secondaries = profiles.filter((p) => p !== primary);

  let summary = `Voice blend anchored on @${primary?.handle ?? "unknown"} (${Math.round((weights[primary?.twitterId ?? ""] ?? 0.7) * 100)}%)`;

  if (secondaries.length > 0) {
    const handles = secondaries
      .map(
        (s) =>
          `@${s.handle} (${Math.round((weights[s.twitterId] ?? 0) * 100)}%)`,
      )
      .join(", ");
    summary += ` with flavor from ${handles}`;
  }

  summary += `. Analyzed ${profiles.reduce((sum, p) => sum + p.tweetCount, 0)} tweets total.`;

  return summary;
}

// --- Main blend function ---

/**
 * Fetch tweets, analyze style, and produce a blended voice profile.
 *
 * @param primaryId - Twitter user ID of the primary voice inspiration
 * @param additionalIds - Twitter user IDs of secondary inspirations
 * @param weights - Optional user-specified weights (0-1 per ID)
 * @param maxTweetsPerUser - Max tweets to fetch per inspiration (default 50)
 */
export async function blendVoices(
  primaryId: string,
  additionalIds: string[],
  weights?: Record<string, number>,
  maxTweetsPerUser = 50,
): Promise<BlendResult> {
  const allIds = [primaryId, ...additionalIds];
  const appliedWeights = normalizeWeights(primaryId, additionalIds, weights);

  // Fetch tweets and analyze each inspiration in parallel
  const profilePromises = allIds.map(async (twitterId): Promise<InspirationProfile> => {
    try {
      // Look up user info
      // Twitter API: lookup by ID
      const userInfo = await lookupUserById(twitterId);
      const handle = userInfo.username;
      const name = userInfo.name;

      // Fetch recent tweets
      const tweets = await fetchUserTweets(twitterId, maxTweetsPerUser);
      const tweetTexts = tweets.map((t) => t.text);

      if (tweetTexts.length === 0) {
        logger.warn({ twitterId, handle }, "No tweets found for inspiration");
        // Return default profile
        return {
          twitterId,
          handle,
          name,
          styleSignals: extractStyleSignals([]),
          calibration: defaultCalibration(),
          tweetCount: 0,
        };
      }

      // Extract raw style signals (fast, no AI)
      const styleSignals = extractStyleSignals(tweetTexts);

      // Run AI calibration for voice dimensions
      const calibration = await calibrateFromTweets(tweetTexts);

      return {
        twitterId,
        handle,
        name,
        styleSignals,
        calibration,
        tweetCount: tweetTexts.length,
      };
    } catch (err: any) {
      logger.error(
        { err: err.message, twitterId },
        "Failed to analyze inspiration",
      );
      throw new Error(
        `Failed to analyze Twitter user ${twitterId}: ${err.message}`,
      );
    }
  });

  const profiles = await Promise.all(profilePromises);

  // Blend the dimensions using weights
  const dimensions = blendDimensions(profiles, appliedWeights);

  // Collect style signals per inspiration
  const styleSignals: Record<string, StyleSignals> = {};
  for (const p of profiles) {
    styleSignals[p.twitterId] = p.styleSignals;
  }

  const totalTweetsAnalyzed = profiles.reduce(
    (sum, p) => sum + p.tweetCount,
    0,
  );

  const summary = generateBlendSummary(profiles, appliedWeights);

  return {
    dimensions,
    styleSignals,
    inspirationProfiles: profiles,
    totalTweetsAnalyzed,
    summary,
    appliedWeights,
  };
}

// --- Helpers ---

/**
 * Look up a Twitter user by numeric ID.
 * Uses Twitter API v2 /users/:id endpoint.
 */
async function lookupUserById(
  userId: string,
): Promise<{ id: string; username: string; name: string }> {
  // Try to use the existing twitter.ts helpers by looking up via the API
  // The twitter.ts module exposes lookupUser (by handle) and fetchUserTweets (by ID)
  // For ID-based lookup, we use the Twitter API directly
  const { config } = await import("./config");
  const token = config.TWITTER_BEARER_TOKEN;
  if (!token) throw new Error("TWITTER_BEARER_TOKEN not configured");

  const res = await fetch(
    `https://api.twitter.com/2/users/${userId}?user.fields=profile_image_url`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Twitter API ${res.status}: ${body}`);
  }

  const data = (await res.json()) as {
    data: { id: string; username: string; name: string };
  };
  if (!data.data)
    throw new Error(`Twitter user ID ${userId} not found`);

  return data.data;
}

/**
 * Return a default calibration result for users with no tweets.
 */
function defaultCalibration(): CalibrationResult {
  return {
    humor: 50,
    formality: 50,
    brevity: 50,
    contrarianTone: 50,
    directness: 50,
    warmth: 50,
    technicalDepth: 50,
    confidence: 50,
    evidenceOrientation: 50,
    solutionOrientation: 50,
    socialPosture: 50,
    selfPromotionalIntensity: 50,
    calibrationConfidence: 0,
    analysis: "No tweets available for analysis.",
    tweetsAnalyzed: 0,
  };
}
