import { config } from "./config";

/**
 * Twitter/X API v2 client for fetching user tweets.
 * Uses Bearer Token authentication (app-only).
 */

const TWITTER_API_BASE = "https://api.twitter.com/2";

interface Tweet {
  id: string;
  text: string;
  created_at?: string;
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

async function twitterGet<T>(path: string): Promise<T> {
  const res = await fetch(`${TWITTER_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${getBearerToken()}` },
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
export async function lookupUser(username: string): Promise<UserLookupResult> {
  const clean = username.replace(/^@/, "");
  const data = await twitterGet<{ data: UserLookupResult }>(
    `/users/by/username/${encodeURIComponent(clean)}?user.fields=profile_image_url`
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
  maxResults = 50
): Promise<Tweet[]> {
  const params = new URLSearchParams({
    max_results: String(Math.min(maxResults, 100)),
    "tweet.fields": "created_at",
    exclude: "retweets,replies",
  });

  const data = await twitterGet<{ data?: Tweet[]; meta: { result_count: number } }>(
    `/users/${userId}/tweets?${params}`
  );

  return data.data || [];
}

/**
 * Convenience: fetch tweets by handle (combines lookup + fetch).
 */
export async function fetchTweetsByHandle(
  handle: string,
  maxResults = 50
): Promise<{ user: UserLookupResult; tweets: Tweet[] }> {
  const user = await lookupUser(handle);
  const tweets = await fetchUserTweets(user.id, maxResults);
  return { user, tweets };
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
    scope: "tweet.read tweet.write users.read offline.access",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return { url: `https://twitter.com/i/oauth2/authorize?${params}`, codeVerifier };
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
