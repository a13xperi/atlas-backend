import { config } from "./config";

/**
 * Twitter/X API v2 client for fetching user tweets.
 * Uses Bearer Token authentication (app-only).
 */

const TWITTER_API_BASE = "https://api.twitter.com/2";

export interface Tweet {
  id: string;
  text: string;
  created_at?: string;
  public_metrics?: {
    like_count: number;
    retweet_count: number;
    reply_count: number;
    quote_count?: number;
    impression_count?: number;
    bookmark_count?: number;
  };
}

interface UserLookupResult {
  id: string;
  username: string;
  name: string;
  profile_image_url?: string;
}

function getBearerToken(): string {
  const token = config.TWITTER_BEARER_TOKEN;
  if (!token) throw new Error("TWITTER_BEARER_TOKEN not configured");
  return token;
}

function withTimeoutSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export class TwitterTimeoutError extends Error {
  constructor(message = "Twitter API request timed out") {
    super(message);
    this.name = "TwitterTimeoutError";
  }
}

async function twitterGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${TWITTER_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${getBearerToken()}` },
    signal: withTimeoutSignal(8000, signal),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Twitter API ${res.status}: ${body}`);
  }

  return res.json() as T;
}

/**
 * Look up a Twitter user by username (handle without @).
 */
export async function lookupUser(username: string, signal?: AbortSignal): Promise<UserLookupResult> {
  const clean = username.replace(/^@/, "");
  const data = await twitterGet<{ data: UserLookupResult }>(
    `/users/by/username/${encodeURIComponent(clean)}?user.fields=profile_image_url`,
    signal,
  );
  if (!data.data) throw new Error(`User @${clean} not found on Twitter/X`);
  // Upsize from default 48px (_normal) to 400px
  if (data.data.profile_image_url) {
    data.data.profile_image_url = data.data.profile_image_url.replace("_normal", "_400x400");
  }
  return data.data;
}

/**
 * Fetch recent tweets for a user (up to 100, excludes retweets and replies).
 */
export async function fetchUserTweets(
  userId: string,
  maxResults = 100,
  signal?: AbortSignal,
): Promise<Tweet[]> {
  const params = new URLSearchParams({
    max_results: String(Math.min(maxResults, 100)),
    "tweet.fields": "created_at,public_metrics",
    exclude: "retweets,replies",
  });

  const data = await twitterGet<{ data?: Tweet[]; meta: { result_count: number } }>(
    `/users/${userId}/tweets?${params}`,
    signal,
  );

  return data.data || [];
}

/**
 * Fetch top-engaged + most-recent tweets for a user.
 */
export async function fetchTopAndRecentTweets(
  userId: string,
  opts: { poolSize?: number; topN?: number; recentN?: number; signal?: AbortSignal } = {}
): Promise<Tweet[]> {
  const pool = await fetchUserTweets(userId, opts.poolSize ?? 100, opts.signal);
  const topN = opts.topN ?? 25;
  const recentN = opts.recentN ?? 25;

  const scored = pool.map((t) => {
    const m = t.public_metrics;
    const engagement =
      (m?.like_count ?? 0) +
      (m?.retweet_count ?? 0) * 2 +
      (m?.reply_count ?? 0) +
      (m?.bookmark_count ?? 0);
    return { tweet: t, engagement };
  });

  const topEngaged = [...scored]
    .sort((a, b) => b.engagement - a.engagement)
    .slice(0, topN)
    .map((s) => s.tweet);

  const recent = [...pool]
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
    .slice(0, recentN);

  const seen = new Set<string>();
  const blended: Tweet[] = [];
  for (const t of [...topEngaged, ...recent]) {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      blended.push(t);
    }
  }
  return blended;
}

/**
 * Convenience: fetch tweets by handle (combines lookup + fetch).
 */
export async function fetchTweetsByHandle(
  handle: string,
  opts:
    | { mode?: "recent" | "blended"; maxResults?: number; signal?: AbortSignal }
    | number = {},
): Promise<{
  user: UserLookupResult;
  tweets: Tweet[];
  stats: { pool: number; topN: number; recentN: number };
}> {
  // Backwards compatibility: if opts is a number, treat it as maxResults
  const options: { mode?: "recent" | "blended"; maxResults?: number; signal?: AbortSignal } =
    typeof opts === "number" ? { mode: "recent", maxResults: opts } : opts;

  const user = await lookupUser(handle, options.signal);
  if (options.mode === "blended" || options.mode === undefined) {
    const blended = await fetchTopAndRecentTweets(user.id, {
      poolSize: 100,
      topN: 25,
      recentN: 25,
      signal: options.signal,
    });
    return {
      user,
      tweets: blended,
      stats: { pool: 100, topN: 25, recentN: 25 },
    };
  }
  const tweets = await fetchUserTweets(user.id, options.maxResults ?? 50, options.signal);
  return {
    user,
    tweets,
    stats: { pool: tweets.length, topN: 0, recentN: tweets.length },
  };
}

// --- Tweet Metrics ---

export interface TweetMetrics {
  id: string;
  public_metrics: {
    like_count: number;
    retweet_count: number;
    reply_count: number;
    impression_count: number;
    bookmark_count: number;
  };
}

/**
 * Fetch public metrics for one or more tweets (up to 100 per call).
 * Uses Bearer Token (app-only) — no user auth needed for public metrics.
 */
export async function getTweetsWithMetrics(tweetIds: string[]): Promise<TweetMetrics[]> {
  if (tweetIds.length === 0) return [];
  // X API allows up to 100 IDs per request
  const ids = tweetIds.slice(0, 100).join(",");
  const data = await twitterGet<{ data?: TweetMetrics[] }>(
    `/tweets?ids=${ids}&tweet.fields=public_metrics`,
  );
  return data.data || [];
}

// --- OAuth 2.0 PKCE + User-Context Posting ---

import crypto from "crypto";

export function generateOAuthUrl(state: string): { url: string; codeVerifier: string } {
  const clientId = config.TWITTER_CLIENT_ID;
  const callbackUrl = config.TWITTER_OAUTH_CALLBACK_URL;
  if (!clientId || !callbackUrl) throw new Error("TWITTER_CLIENT_ID and TWITTER_OAUTH_CALLBACK_URL required");

  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: callbackUrl,
    scope: "tweet.read users.read follows.read like.read offline.access",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return { url: `https://twitter.com/i/oauth2/authorize?${params}`, codeVerifier };
}

/**
 * Generate OAuth URL for login flow (uses login-specific callback URL).
 */
export function generateLoginOAuthUrl(state: string): { url: string; codeVerifier: string } {
  const clientId = config.TWITTER_CLIENT_ID;
  const callbackUrl = config.TWITTER_LOGIN_CALLBACK_URL || config.TWITTER_OAUTH_CALLBACK_URL;
  if (!clientId || !callbackUrl) throw new Error("TWITTER_CLIENT_ID and callback URL required");

  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: callbackUrl,
    scope: "tweet.read users.read follows.read like.read offline.access",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return { url: `https://twitter.com/i/oauth2/authorize?${params}`, codeVerifier };
}

/**
 * Exchange code for tokens using login callback URL.
 */
export async function exchangeLoginCodeForTokens(code: string, codeVerifier: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const clientId = config.TWITTER_CLIENT_ID;
  const clientSecret = config.TWITTER_CLIENT_SECRET;
  const callbackUrl = config.TWITTER_LOGIN_CALLBACK_URL || config.TWITTER_OAUTH_CALLBACK_URL;
  if (!clientId || !clientSecret || !callbackUrl) throw new Error("X OAuth credentials not configured");

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch("https://api.twitter.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      redirect_uri: callbackUrl,
      code_verifier: codeVerifier,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`X token exchange failed (${res.status}): ${body}`);
  }

  const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
}

export async function exchangeCodeForTokens(code: string, codeVerifier: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const clientId = config.TWITTER_CLIENT_ID;
  const clientSecret = config.TWITTER_CLIENT_SECRET;
  const callbackUrl = config.TWITTER_OAUTH_CALLBACK_URL;
  if (!clientId || !clientSecret || !callbackUrl) throw new Error("X OAuth credentials not configured");

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch("https://api.twitter.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      redirect_uri: callbackUrl,
      code_verifier: codeVerifier,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`X token exchange failed (${res.status}): ${body}`);
  }

  const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
}

export async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const clientId = config.TWITTER_CLIENT_ID;
  const clientSecret = config.TWITTER_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("X OAuth credentials not configured");

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch("https://api.twitter.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`X token refresh failed (${res.status}): ${body}`);
  }

  const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
}

// --- Authenticated User Profile ---

export interface TwitterUserProfile {
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

/**
 * Fetch the authenticated user's full profile using an OAuth 2.0 user token.
 * Returns handle, display name, bio, avatar (400x400), and follower count.
 */
export async function fetchTwitterUserProfile(accessToken: string): Promise<TwitterUserProfile> {
  const res = await fetch(
    `${TWITTER_API_BASE}/users/me?user.fields=description,profile_image_url,public_metrics`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Twitter /users/me failed (${res.status}): ${body}`);
  }

  const data = await res.json() as { data: TwitterUserProfile };
  if (!data.data) throw new Error("Twitter /users/me returned empty data");

  // Upsize avatar from 48px to 400px
  if (data.data.profile_image_url) {
    data.data.profile_image_url = data.data.profile_image_url.replace("_normal", "_400x400");
  }

  return data.data;
}

export async function postTweet(accessToken: string, text: string, replyToId?: string): Promise<{ id: string; text: string }> {
  const body: Record<string, unknown> = { text };
  if (replyToId) body.reply = { in_reply_to_tweet_id: replyToId };

  const res = await fetch(`${TWITTER_API_BASE}/tweets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`X post failed (${res.status}): ${err}`);
  }

  const data = await res.json() as { data: { id: string; text: string } };
  return data.data;
}
