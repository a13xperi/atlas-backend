import { Router } from "express";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { refreshAccessToken } from "../lib/twitter";
import { logger } from "../lib/logger";
import { success, error } from "../lib/response";
import { buildErrorResponse } from "../middleware/requestId";
import { getCached, setCache } from "../lib/redis";
import { config } from "../lib/config";
import { rateLimitByUser } from "../middleware/rateLimit";
import {
  buildTokenWrite,
  readAccessToken,
  readRefreshToken,
  TOKEN_READ_SELECT,
} from "../lib/crypto";

export const twitterRouter: Router = Router();

const TWITTER_API_BASE = "https://api.twitter.com/2";
const CACHE_TTL_SECONDS = 3600; // 1 hour

// ── In-memory fallback cache ─────────────────────────────────────────
interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const memoryCache = new Map<string, CacheEntry<unknown>>();

async function getFromCache<T>(key: string): Promise<T | null> {
  // Try Redis first
  const raw = await getCached(key);
  if (raw) {
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Parse failed — fall through
    }
  }
  // Fallback to in-memory
  const entry = memoryCache.get(key) as CacheEntry<T> | undefined;
  if (entry && entry.expiresAt > Date.now()) {
    return entry.data;
  }
  if (entry) memoryCache.delete(key);
  return null;
}

async function writeToCache<T>(key: string, data: T, ttlSeconds = CACHE_TTL_SECONDS): Promise<void> {
  const json = JSON.stringify(data);
  await setCache(key, json, ttlSeconds);
  memoryCache.set(key, { data, expiresAt: Date.now() + ttlSeconds * 1000 });
}

// ── Token helpers ────────────────────────────────────────────────────

/**
 * Retrieve the user's X access token, refreshing if expired.
 * Returns null if user has no linked X account.
 *
 * Transparently handles the C-3 encrypted token columns — reads prefer
 * the encrypted column, fall back to plaintext, and refreshed tokens
 * are persisted via buildTokenWrite so they honor the active mode.
 */
async function getValidAccessToken(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { ...TOKEN_READ_SELECT, xTokenExpiresAt: true },
  });

  const accessToken = readAccessToken(user);
  if (!accessToken) return null;

  // Check if token is expired (with 60s buffer)
  const isExpired = user?.xTokenExpiresAt
    ? user.xTokenExpiresAt.getTime() < Date.now() + 60_000
    : false;

  if (!isExpired) return accessToken;

  // Attempt refresh
  const currentRefreshToken = readRefreshToken(user);
  if (!currentRefreshToken) return null;

  try {
    const refreshed = await refreshAccessToken(currentRefreshToken);
    await prisma.user.update({
      where: { id: userId },
      data: buildTokenWrite({
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
      }),
    });
    return refreshed.accessToken;
  } catch (err: any) {
    logger.error({ err: err.message, userId }, "Failed to refresh X token");
    return null;
  }
}

/**
 * Make an authenticated GET request to the Twitter API v2.
 * Returns { data, rateLimited } — rateLimited is true if we got a 429.
 */
async function twitterUserGet<T>(
  accessToken: string,
  path: string,
): Promise<{ data: T | null; rateLimited: boolean; status: number }> {
  const res = await fetch(`${TWITTER_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 429) {
    return { data: null, rateLimited: true, status: 429 };
  }

  if (!res.ok) {
    const body = await res.text();
    logger.warn({ status: res.status, body }, "Twitter API error");
    return { data: null, rateLimited: false, status: res.status };
  }

  const json = (await res.json()) as T;
  return { data: json, rateLimited: false, status: res.status };
}

// ── GET /api/twitter/follows ─────────────────────────────────────────

interface TwitterFollowUser {
  id: string;
  username: string;
  name: string;
  description?: string;
  profile_image_url?: string;
  public_metrics?: {
    followers_count: number;
    following_count: number;
    tweet_count: number;
  };
}

interface FollowsApiResponse {
  data?: TwitterFollowUser[];
  meta?: { result_count: number; next_token?: string };
}

twitterRouter.get("/follows", authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const cacheKey = `twitter:follows:${userId}`;

    // Check cache first
    const cached = await getFromCache<ReturnType<typeof mapFollows>>(cacheKey);
    if (cached) {
      return res.json(success({ follows: cached, cached: true }));
    }

    const accessToken = await getValidAccessToken(userId);
    if (!accessToken) {
      return res.status(401).json(error("X account not linked or token expired. Please reconnect."));
    }

    // Get the authenticated user's ID first
    const meResult = await twitterUserGet<{ data: { id: string } }>(accessToken, "/users/me");
    if (meResult.rateLimited) {
      // Return cached data if available (already checked above, but in-memory might have stale)
      return res.status(429).json(error("Twitter API rate limit reached. Please try again later."));
    }
    if (!meResult.data?.data?.id) {
      return res.status(502).json(error("Failed to verify X identity"));
    }

    const xUserId = meResult.data.data.id;
    const params = new URLSearchParams({
      max_results: "1000",
      "user.fields": "description,profile_image_url,public_metrics",
    });

    const result = await twitterUserGet<FollowsApiResponse>(
      accessToken,
      `/users/${xUserId}/following?${params}`,
    );

    if (result.rateLimited) {
      return res.status(429).json(error("Twitter API rate limit reached. Please try again later."));
    }

    if (result.status === 401) {
      return res.status(401).json(error("X token expired. Please reconnect your account."));
    }

    if (!result.data) {
      return res.status(502).json(error("Failed to fetch follows from X"));
    }

    const follows = mapFollows(result.data.data || []);

    // Cache the result
    await writeToCache(cacheKey, follows);

    res.json(success({ follows, cached: false }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Twitter follows fetch failed");
    res.status(500).json(buildErrorResponse(req, "Failed to fetch Twitter follows"));
  }
});

function mapFollows(users: TwitterFollowUser[]) {
  return users
    .map((u) => ({
      id: u.id,
      handle: u.username,
      display_name: u.name,
      bio: u.description || null,
      avatar_url: u.profile_image_url
        ? u.profile_image_url.replace("_normal", "_400x400")
        : null,
      follower_count: u.public_metrics?.followers_count ?? 0,
    }))
    .sort((a, b) => {
      if (b.follower_count !== a.follower_count) {
        return b.follower_count - a.follower_count;
      }
      return a.handle.localeCompare(b.handle);
    });
}

// ── GET /api/twitter/likes ───────────────────────────────────────────

interface TwitterLikeTweet {
  id: string;
  text: string;
  created_at?: string;
  public_metrics?: {
    like_count: number;
    retweet_count: number;
    reply_count: number;
    impression_count: number;
  };
  author_id?: string;
}

interface TwitterLikeAuthor {
  id: string;
  username: string;
  profile_image_url?: string;
}

interface LikesApiResponse {
  data?: TwitterLikeTweet[];
  includes?: {
    users?: TwitterLikeAuthor[];
  };
  meta?: { result_count: number; next_token?: string };
}

twitterRouter.get("/likes", authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const cacheKey = `twitter:likes:${userId}`;

    // Check cache first
    const cached = await getFromCache<ReturnType<typeof mapLikes>>(cacheKey);
    if (cached) {
      return res.json(success({ likes: cached, cached: true }));
    }

    const accessToken = await getValidAccessToken(userId);
    if (!accessToken) {
      return res.status(401).json(error("X account not linked or token expired. Please reconnect."));
    }

    // Get the authenticated user's ID
    const meResult = await twitterUserGet<{ data: { id: string } }>(accessToken, "/users/me");
    if (meResult.rateLimited) {
      return res.status(429).json(error("Twitter API rate limit reached. Please try again later."));
    }
    if (!meResult.data?.data?.id) {
      return res.status(502).json(error("Failed to verify X identity"));
    }

    const xUserId = meResult.data.data.id;
    const params = new URLSearchParams({
      max_results: "50",
      "tweet.fields": "created_at,public_metrics,author_id",
      expansions: "author_id",
      "user.fields": "username,profile_image_url",
    });

    const result = await twitterUserGet<LikesApiResponse>(
      accessToken,
      `/users/${xUserId}/liked_tweets?${params}`,
    );

    if (result.rateLimited) {
      return res.status(429).json(error("Twitter API rate limit reached. Please try again later."));
    }

    if (result.status === 401) {
      return res.status(401).json(error("X token expired. Please reconnect your account."));
    }

    if (!result.data) {
      return res.status(502).json(error("Failed to fetch likes from X"));
    }

    const likes = mapLikes(result.data.data || [], result.data.includes?.users || []);

    // Cache the result
    await writeToCache(cacheKey, likes);

    res.json(success({ likes, cached: false }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Twitter likes fetch failed");
    res.status(500).json(buildErrorResponse(req, "Failed to fetch Twitter likes"));
  }
});

function mapLikes(tweets: TwitterLikeTweet[], authors: TwitterLikeAuthor[]) {
  const authorMap = new Map(authors.map((a) => [a.id, a]));

  return tweets.map((t) => {
    const author = t.author_id ? authorMap.get(t.author_id) : undefined;
    return {
      id: t.id,
      text: t.text,
      author_handle: author?.username || null,
      author_avatar: author?.profile_image_url
        ? author.profile_image_url.replace("_normal", "_400x400")
        : null,
      created_at: t.created_at || null,
      like_count: t.public_metrics?.like_count ?? 0,
      retweet_count: t.public_metrics?.retweet_count ?? 0,
    };
  });
}

// ── Top tweets (swipe onboarding) ────────────────────────────────────

interface TwitterTopTweetRaw {
  id: string;
  text: string;
  created_at?: string;
  public_metrics?: {
    like_count: number;
    retweet_count: number;
    reply_count: number;
  };
}

interface TwitterTopTweet {
  id: string;
  text: string;
  author_handle: string | null;
  author_avatar: string | null;
  created_at: string | null;
  like_count: number;
  retweet_count: number;
  reply_count: number;
}

const DEMO_TOP_TWEETS: TwitterTopTweet[] = [
  {
    id: "demo-1",
    text: "The best time to build was 10 years ago. The second best time is right now.",
    author_handle: "demo",
    author_avatar: null,
    created_at: new Date().toISOString(),
    like_count: 1240,
    retweet_count: 180,
    reply_count: 45,
  },
  {
    id: "demo-2",
    text: "Crypto isn't about getting rich quick. It's about not getting poor slowly.",
    author_handle: "demo",
    author_avatar: null,
    created_at: new Date(Date.now() - 86400000).toISOString(),
    like_count: 890,
    retweet_count: 120,
    reply_count: 32,
  },
  {
    id: "demo-3",
    text: "Bear markets are for builders. Bull markets are for believers. Which one are you?",
    author_handle: "demo",
    author_avatar: null,
    created_at: new Date(Date.now() - 172800000).toISOString(),
    like_count: 650,
    retweet_count: 95,
    reply_count: 28,
  },
  {
    id: "demo-4",
    text: "Simplicity scales. Complexity fails. This applies to protocols, portfolios, and life.",
    author_handle: "demo",
    author_avatar: null,
    created_at: new Date(Date.now() - 259200000).toISOString(),
    like_count: 420,
    retweet_count: 70,
    reply_count: 15,
  },
  {
    id: "demo-5",
    text: "Don't trust, verify. Then ship.",
    author_handle: "demo",
    author_avatar: null,
    created_at: new Date(Date.now() - 345600000).toISOString(),
    like_count: 310,
    retweet_count: 55,
    reply_count: 12,
  },
];

function sortTopTweets(tweets: TwitterTopTweet[]): TwitterTopTweet[] {
  return tweets.sort((a, b) => {
    const scoreA = a.like_count + 2 * a.retweet_count + a.reply_count;
    const scoreB = b.like_count + 2 * b.retweet_count + b.reply_count;
    return scoreB - scoreA;
  });
}

function mapTopTweets(tweets: TwitterTopTweetRaw[], handle: string | null, avatar: string | null): TwitterTopTweet[] {
  return tweets.map((t) => ({
    id: t.id,
    text: t.text,
    author_handle: handle,
    author_avatar: avatar,
    created_at: t.created_at || null,
    like_count: t.public_metrics?.like_count ?? 0,
    retweet_count: t.public_metrics?.retweet_count ?? 0,
    reply_count: t.public_metrics?.reply_count ?? 0,
  }));
}

/**
 * Make an authenticated GET request to the Twitter API v2 using the app Bearer token.
 */
async function twitterBearerGet<T>(path: string): Promise<{ data: T | null; status: number }> {
  const token = config.TWITTER_BEARER_TOKEN;
  if (!token) {
    return { data: null, status: 503 };
  }
  const res = await fetch(`${TWITTER_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    logger.warn({ status: res.status, body }, "Twitter API error (bearer)");
    return { data: null, status: res.status };
  }
  const json = (await res.json()) as T;
  return { data: json, status: res.status };
}

// GET /api/twitter/me/top-tweets
twitterRouter.get("/me/top-tweets", authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 10, 1), 50);
    const cacheKey = `twitter:top-self:${userId}`;

    const cached = await getFromCache<TwitterTopTweet[]>(cacheKey);
    if (cached) {
      return res.json(success({ tweets: cached.slice(0, limit), cached: true }));
    }

    const accessToken = await getValidAccessToken(userId);
    if (!accessToken) {
      return res.json(success({ tweets: DEMO_TOP_TWEETS.slice(0, limit), cached: false, fallback: "demo" }));
    }

    const meResult = await twitterUserGet<{ data: { id: string } }>(accessToken, "/users/me");
    if (meResult.rateLimited) {
      return res.status(429).json(error("Twitter API rate limit reached. Please try again later."));
    }
    if (meResult.status === 401) {
      return res.json(success({ tweets: DEMO_TOP_TWEETS.slice(0, limit), cached: false, fallback: "demo" }));
    }
    if (!meResult.data?.data?.id) {
      return res.status(502).json(error("Failed to verify X identity"));
    }

    const xUserId = meResult.data.data.id;
    const params = new URLSearchParams({
      max_results: String(limit),
      "tweet.fields": "created_at,public_metrics",
      exclude: "retweets,replies",
    });

    const result = await twitterUserGet<{ data?: TwitterTopTweetRaw[] }>(
      accessToken,
      `/users/${xUserId}/tweets?${params}`,
    );

    if (result.rateLimited) {
      return res.status(429).json(error("Twitter API rate limit reached. Please try again later."));
    }
    if (result.status === 401) {
      return res.json(success({ tweets: DEMO_TOP_TWEETS.slice(0, limit), cached: false, fallback: "demo" }));
    }
    if (!result.data?.data) {
      return res.status(502).json(error("Failed to fetch tweets from X"));
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { xHandle: true, xAvatarUrl: true },
    });

    const tweets = sortTopTweets(mapTopTweets(result.data.data, user?.xHandle ?? null, user?.xAvatarUrl ?? null));
    await writeToCache(cacheKey, tweets, 3600); // 1 hour

    res.json(success({ tweets: tweets.slice(0, limit), cached: false }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Twitter me/top-tweets fetch failed");
    res.status(500).json(buildErrorResponse(req, "Failed to fetch top tweets"));
  }
});

const topTweetsByHandleLimiter = rateLimitByUser(30, 60 * 1000);

// GET /api/twitter/handle/:handle/top-tweets
twitterRouter.get("/handle/:handle/top-tweets", authenticate, topTweetsByHandleLimiter, async (req: AuthRequest, res) => {
  try {
    const handle = normalizeReferenceHandle(req.params.handle as string);
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 10, 1), 50);
    const cacheKey = `twitter:top-public:${handle}`;

    const cached = await getFromCache<TwitterTopTweet[]>(cacheKey);
    if (cached) {
      return res.json(success({ tweets: cached.slice(0, limit), cached: true }));
    }

    const lookup = await twitterBearerGet<{ data: { id: string; username: string; name: string; profile_image_url?: string } }>(
      `/users/by/username/${encodeURIComponent(handle)}?user.fields=profile_image_url`,
    );

    if (lookup.status === 404) {
      return res.json(success({ tweets: DEMO_TOP_TWEETS.slice(0, limit), cached: false, fallback: "demo" }));
    }
    if (lookup.status === 429) {
      return res.status(429).json(error("Twitter API rate limit reached. Please try again later."));
    }
    if (!lookup.data?.data) {
      return res.status(502).json(error("Failed to lookup user on X"));
    }

    const xUser = lookup.data.data;
    const params = new URLSearchParams({
      max_results: String(limit),
      "tweet.fields": "created_at,public_metrics",
      exclude: "retweets,replies",
    });

    const result = await twitterBearerGet<{ data?: TwitterTopTweetRaw[] }>(
      `/users/${xUser.id}/tweets?${params}`,
    );

    if (result.status === 429) {
      return res.status(429).json(error("Twitter API rate limit reached. Please try again later."));
    }
    if (!result.data?.data) {
      return res.status(502).json(error("Failed to fetch tweets from X"));
    }

    const avatarUrl = xUser.profile_image_url
      ? xUser.profile_image_url.replace("_normal", "_400x400")
      : null;

    const tweets = sortTopTweets(mapTopTweets(result.data.data, xUser.username, avatarUrl));
    await writeToCache(cacheKey, tweets, 86400); // 24 hours

    res.json(success({ tweets: tweets.slice(0, limit), cached: false }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Twitter handle/top-tweets fetch failed");
    res.status(500).json(buildErrorResponse(req, "Failed to fetch top tweets"));
  }
});

function normalizeReferenceHandle(handle: string) {
  return handle.replace(/^@/, "").trim().toLowerCase();
}
