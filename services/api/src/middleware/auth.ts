import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../lib/config";
import { prisma } from "../lib/prisma";
import { supabaseAdmin } from "../lib/supabase";
import { getAccessToken } from "../lib/cookies";

export interface AuthRequest extends Request {
  userId?: string;
}

/**
 * Dual-mode auth middleware.
 * Token sources (priority): HttpOnly cookie > Authorization header
 * Path 1: Supabase JWT — verifies via supabaseAdmin.auth.getUser(), resolves Prisma user by supabaseId
 * Path 2: Legacy JWT — verifies via JWT_SECRET, uses payload.userId directly
 * Both paths set req.userId to a Prisma CUID. All downstream routes are unchanged.
 */
export async function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const token = getAccessToken(req);
  if (!token) {
    return res.status(401).json({ error: "Missing authorization token" });
  }

  // Path 1: Supabase token verification
  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin.auth.getUser(token);
      if (!error && data.user) {
        const supabaseId = data.user.id;

        // Look up Prisma user by supabaseId
        let user = await prisma.user.findFirst({ where: { supabaseId } });

        // Auto-link: if no user by supabaseId but email matches an existing user, link them
        if (!user && data.user.email) {
          user = await prisma.user.findUnique({ where: { email: data.user.email } });
          if (user && !user.supabaseId) {
            user = await prisma.user.update({
              where: { id: user.id },
              data: { supabaseId },
            });
          }
        }

        if (user) {
          req.userId = user.id;
          return next();
        }

        return res.status(403).json({ error: "Account not found. Please register first." });
      }
    } catch {
      // Supabase verification failed — fall through to legacy
    }
  }

  // Path 2: Legacy JWT fallback
  try {
    const secret = config.JWT_SECRET;
    if (!secret) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
    const payload = jwt.verify(token, secret) as { userId: string };
    req.userId = payload.userId;
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
