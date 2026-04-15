/**
 * JWT revocation via Redis-backed jti blacklist (C-6).
 *
 * Logout inserts the token's `jti` into Redis with a TTL equal to the
 * remaining lifetime of the token. The `authenticate` middleware then
 * rejects any token whose `jti` is present in the blacklist, even though
 * the JWT itself is still cryptographically valid.
 *
 * Fail-open behavior:
 *   - `revokeJti` is best-effort. Logout should still clear cookies and
 *     return success if Redis is unavailable.
 *   - `isJtiRevoked` also fails OPEN on Redis errors so auth does not
 *     break during a transient Redis outage. Operators still get logs.
 */

import { getRedis } from "./redis";
import { logger } from "./logger";

const KEY_PREFIX = "jwt:revoked:";

function key(jti: string): string {
  return `${KEY_PREFIX}${jti}`;
}

/**
 * Insert a jti into the revocation blacklist with the given TTL (seconds).
 * Returns true if the entry was written (or Redis is unavailable and we
 * intentionally skipped); false only on an unexpected error.
 */
export async function revokeJti(jti: string, ttlSeconds: number): Promise<boolean> {
  if (!jti) return false;
  // Treat any non-positive TTL as already-expired — nothing to revoke.
  if (ttlSeconds <= 0) return true;

  const r = getRedis();
  if (!r) {
    // Redis unavailable: log and skip. Logout still clears cookies, but
    // the token remains technically valid until its natural expiry.
    logger.warn(
      { jti: jti.slice(0, 8) },
      "Redis unavailable — jti revocation skipped",
    );
    return false;
  }

  try {
    await r.set(key(jti), "1", "EX", ttlSeconds);
    return true;
  } catch (err: any) {
    logger.error({ err: err?.message, jti: jti.slice(0, 8) }, "Failed to revoke jti");
    return false;
  }
}

/**
 * Check whether a jti has been revoked.
 *
 * Fail-open: if Redis is unreachable we return FALSE (treat as not revoked)
 * and log the failure so auth and refresh flows continue to work.
 */
export async function isJtiRevoked(jti: string | undefined): Promise<boolean> {
  if (!jti) return false;

  const r = getRedis();
  if (!r) {
    // No Redis configured at all → treat the blacklist as empty so the
    // service still works in dev. Production environments are expected
    // to always have Redis configured (Railway provisions it).
    return false;
  }

  try {
    const value = await r.get(key(jti));
    return value !== null;
  } catch (err: any) {
    logger.error({ err: err?.message, jti: jti.slice(0, 8) }, "jti lookup failed");
    return false;
  }
}

/**
 * Compute the remaining TTL (seconds) for a JWT given its `exp` claim.
 * Returns 0 when the token has already expired.
 */
export function remainingTtlSeconds(exp: number | undefined): number {
  if (!exp || typeof exp !== "number") return 0;
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.max(0, exp - nowSec);
}
