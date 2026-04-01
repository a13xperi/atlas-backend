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
}

function getBearerToken(): string {
  const token = process.env.TWITTER_BEARER_TOKEN;
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
    `/users/by/username/${encodeURIComponent(clean)}`
  );
  if (!data.data) throw new Error(`User @${clean} not found on Twitter/X`);
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
