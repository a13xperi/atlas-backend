/**
 * HttpOnly Cookie helpers for secure session management.
 * Replaces localStorage token storage (XSS-vulnerable).
 */

import { Response, Request } from "express";

const IS_PRODUCTION = process.env.NODE_ENV === "production";

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: IS_PRODUCTION,
  sameSite: IS_PRODUCTION ? ("none" as const) : ("lax" as const),
  path: "/",
};

const ACCESS_TOKEN_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
const REFRESH_TOKEN_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  res.cookie("atlas_access_token", accessToken, {
    ...COOKIE_OPTIONS,
    maxAge: ACCESS_TOKEN_MAX_AGE,
  });
  res.cookie("atlas_refresh_token", refreshToken, {
    ...COOKIE_OPTIONS,
    maxAge: REFRESH_TOKEN_MAX_AGE,
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie("atlas_access_token", COOKIE_OPTIONS);
  res.clearCookie("atlas_refresh_token", COOKIE_OPTIONS);
}

export function getAccessToken(req: Request): string | null {
  // Priority: cookie > Authorization header (backwards compatible)
  const cookieToken = req.cookies?.atlas_access_token;
  if (cookieToken) return cookieToken;

  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);

  return null;
}

export function getRefreshToken(req: Request): string | null {
  return req.cookies?.atlas_refresh_token || null;
}
