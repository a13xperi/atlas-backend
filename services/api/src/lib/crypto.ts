import crypto from "node:crypto";
import { logger } from "./logger";

/**
 * XOAuth token encryption at rest (C-3).
 *
 * Design:
 * - AES-256-GCM with a 32-byte key read from `TOKEN_ENCRYPTION_KEY`
 *   (accepts hex-encoded or base64-encoded).
 * - Ciphertext format: `v1:<iv_b64>:<tag_b64>:<ct_b64>`
 * - If the env var is missing/invalid, encryption is DISABLED and all
 *   helpers fall through to the plaintext columns on User. This keeps
 *   existing deployments working during the migration window and lets
 *   us ship code ahead of the backfill.
 * - Dual-column schema: `xAccessToken`/`xRefreshToken` (plaintext, legacy)
 *   live alongside `xAccessTokenEnc`/`xRefreshTokenEnc` (ciphertext).
 *   Reads prefer enc and fall back to plaintext; writes target whichever
 *   column set is active based on whether encryption is enabled.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const VERSION = "v1";

// `undefined` = not yet resolved, `null` = resolved but disabled, Buffer = enabled.
let cachedKey: Buffer | null | undefined;

function loadKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;

  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    cachedKey = null;
    return null;
  }

  try {
    let key: Buffer;
    if (/^[0-9a-f]{64}$/i.test(raw)) {
      key = Buffer.from(raw, "hex");
    } else {
      key = Buffer.from(raw, "base64");
    }
    if (key.length !== KEY_LENGTH) {
      throw new Error(`Expected ${KEY_LENGTH}-byte key, got ${key.length}`);
    }
    cachedKey = key;
    return cachedKey;
  } catch (err: any) {
    logger.error(
      { err: err.message },
      "TOKEN_ENCRYPTION_KEY is invalid — falling through to plaintext XOAuth token storage",
    );
    cachedKey = null;
    return null;
  }
}

/** True if a valid `TOKEN_ENCRYPTION_KEY` is present. */
export function encryptionEnabled(): boolean {
  return loadKey() !== null;
}

/** True if the value looks like a `v1:` encrypted token. */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(`${VERSION}:`);
}

/** Encrypt a plaintext token. If encryption is disabled, returns the plaintext unchanged. */
export function encryptToken(plaintext: string): string {
  const key = loadKey();
  if (!key) return plaintext;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * Decrypt a ciphertext produced by `encryptToken`.
 * - Plaintext-looking values pass through unchanged (plaintext fallback).
 * - Throws only if the value *looks* encrypted (`v1:` prefix) but cannot be decrypted.
 */
export function decryptToken(value: string): string {
  if (!isEncrypted(value)) return value;

  const key = loadKey();
  if (!key) {
    throw new Error(
      "Cannot decrypt XOAuth token: TOKEN_ENCRYPTION_KEY is not set or invalid",
    );
  }

  const parts = value.split(":");
  if (parts.length !== 4) {
    throw new Error("Malformed encrypted XOAuth token (expected 4 segments)");
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plaintext.toString("utf8");
}

// ─── Prisma write helpers ─────────────────────────────────────────────

export interface TokenWriteFragment {
  xAccessToken: string | null;
  xRefreshToken: string | null;
  xAccessTokenEnc: string | null;
  xRefreshTokenEnc: string | null;
  xTokenExpiresAt: Date | null;
}

/**
 * Build the `data` fragment for a Prisma write that sets X tokens.
 * When encryption is enabled, writes go to the `*Enc` columns and the
 * plaintext columns are cleared to `null`. When disabled, the legacy
 * plaintext columns are populated and the `*Enc` columns stay `null`.
 */
export function buildTokenWrite(args: {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
}): TokenWriteFragment {
  if (encryptionEnabled()) {
    return {
      xAccessToken: null,
      xRefreshToken: null,
      xAccessTokenEnc: args.accessToken ? encryptToken(args.accessToken) : null,
      xRefreshTokenEnc: args.refreshToken ? encryptToken(args.refreshToken) : null,
      xTokenExpiresAt: args.expiresAt,
    };
  }
  return {
    xAccessToken: args.accessToken,
    xRefreshToken: args.refreshToken,
    xAccessTokenEnc: null,
    xRefreshTokenEnc: null,
    xTokenExpiresAt: args.expiresAt,
  };
}

/** Build the `data` fragment for clearing X tokens on disconnect. */
export function buildTokenClear(): TokenWriteFragment {
  return {
    xAccessToken: null,
    xRefreshToken: null,
    xAccessTokenEnc: null,
    xRefreshTokenEnc: null,
    xTokenExpiresAt: null,
  };
}

// ─── Prisma read helpers ──────────────────────────────────────────────

/**
 * Row shape used by read helpers. Use this in Prisma `select` clauses to
 * pull both the enc and plaintext columns so reads can transparently
 * fall back during the migration window.
 */
export interface UserTokenRow {
  xAccessToken?: string | null;
  xRefreshToken?: string | null;
  xAccessTokenEnc?: string | null;
  xRefreshTokenEnc?: string | null;
}

/** Prisma `select` fragment for reading both enc and plaintext token columns. */
export const TOKEN_READ_SELECT = {
  xAccessToken: true,
  xRefreshToken: true,
  xAccessTokenEnc: true,
  xRefreshTokenEnc: true,
} as const;

/** Decrypt & return the access token, preferring enc column, falling back to plaintext. */
export function readAccessToken(user: UserTokenRow | null | undefined): string | null {
  if (!user) return null;
  if (user.xAccessTokenEnc) {
    try {
      return decryptToken(user.xAccessTokenEnc);
    } catch (err: any) {
      logger.error(
        { err: err.message },
        "Failed to decrypt xAccessTokenEnc — falling back to plaintext column",
      );
    }
  }
  return user.xAccessToken ?? null;
}

/** Decrypt & return the refresh token, preferring enc column, falling back to plaintext. */
export function readRefreshToken(user: UserTokenRow | null | undefined): string | null {
  if (!user) return null;
  if (user.xRefreshTokenEnc) {
    try {
      return decryptToken(user.xRefreshTokenEnc);
    } catch (err: any) {
      logger.error(
        { err: err.message },
        "Failed to decrypt xRefreshTokenEnc — falling back to plaintext column",
      );
    }
  }
  return user.xRefreshToken ?? null;
}

/** Reset the cached key. Test-only — not exported from index. */
export function __resetKeyCacheForTests(): void {
  cachedKey = undefined;
}
