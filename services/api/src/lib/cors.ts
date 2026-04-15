import type { CorsOptions } from "cors";

/**
 * CORS hardening — extracted so the origin-matching logic is unit-testable.
 *
 * The previous inline middleware had three sharp edges:
 *
 *   1. Wildcard compilation escaped `*` but nothing else, so an entry like
 *      `https://*.vercel.app` silently became the regex
 *      `^https://.*.vercel.app$` — where the literal dots are any-char
 *      metachars. That over-matched `https://x.vercelxapp` and friends.
 *
 *   2. The origin callback ended with `callback(null, allowed || undefined)`.
 *      Passing `undefined` as the second arg to cors is ambiguous, and the
 *      `!origin → callback(null, true)` bypass unconditionally allowed any
 *      request that lacked an Origin header even though `credentials: true`
 *      was in effect. Both paths should reject explicitly.
 *
 *   3. `FRONTEND_URL.split(",").filter(Boolean)` can evaluate to `[]` in
 *      production when someone forgets to set the env var, leaving the API
 *      booted with zero allowed origins. That should fail loudly at boot,
 *      not silently accept nothing.
 */

// Metacharacters that must be escaped before we substitute `*` → `.*`.
// NOTE: `*` is intentionally absent — we want to convert it to `.*` after
// everything else is literalised.
const REGEX_METACHARS = /[.+?^${}()|[\]\\]/g;

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(REGEX_METACHARS, "\\$&");
  return new RegExp("^" + escaped.replace(/\*/g, ".*") + "$");
}

/**
 * Build an origin predicate. Patterns are compiled once so we don't rebuild
 * a RegExp on every request.
 */
export function buildOriginMatcher(
  allowedOrigins: readonly string[],
): (origin: string) => boolean {
  const matchers = allowedOrigins.map((ao) => {
    if (ao.includes("*")) {
      const re = globToRegExp(ao);
      return (origin: string) => re.test(origin);
    }
    return (origin: string) => ao === origin;
  });
  return (origin: string) => matchers.some((match) => match(origin));
}

// Explicit allowlists — keep the attack surface small and obvious.
export const DEFAULT_ALLOWED_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
];

export const DEFAULT_ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-Requested-With",
  "X-Request-Id",
];

export const DEFAULT_EXPOSED_HEADERS = ["X-Request-Id"];

/**
 * Build the full cors options object for the API. The origin callback
 * rejects no-origin requests explicitly via `callback(null, false)` — with
 * `credentials: true` we never want to hand out CORS headers to a request
 * that didn't declare an origin.
 */
export function buildCorsOptions(
  allowedOrigins: readonly string[],
): CorsOptions {
  const isAllowed = buildOriginMatcher(allowedOrigins);
  return {
    origin: (origin, callback) => {
      if (!origin) return callback(null, false);
      return callback(null, isAllowed(origin));
    },
    credentials: true,
    methods: DEFAULT_ALLOWED_METHODS,
    allowedHeaders: DEFAULT_ALLOWED_HEADERS,
    exposedHeaders: DEFAULT_EXPOSED_HEADERS,
    maxAge: 600,
  };
}

/**
 * Boot-time guard: refuse to start a production API with no allowed
 * origins. `.filter(Boolean)` on a malformed `FRONTEND_URL` can quietly
 * collapse to `[]` and we'd rather crash now than drift into an API that
 * rejects every browser client at runtime.
 */
export function assertCorsConfig(params: {
  allowedOrigins: readonly string[];
  nodeEnv: string;
}): void {
  const { allowedOrigins, nodeEnv } = params;
  if (nodeEnv === "production" && allowedOrigins.length === 0) {
    throw new Error(
      "CORS: FRONTEND_URL is empty in production. Refusing to boot with no allowed origins.",
    );
  }
}
