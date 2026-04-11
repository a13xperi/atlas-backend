import { Router, Response } from "express";
import { z } from "zod";
import { parsePagination } from "../lib/pagination";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { buildErrorResponse } from "../middleware/requestId";
import { logger } from "../lib/logger";
import { emitToUser } from "../lib/socket";
import { success } from "../lib/response";

export const alertsRouter = Router();
alertsRouter.use(authenticate);

const deliverySchema = z.array(z.enum(["PORTAL", "TELEGRAM"])).optional();

const subscriptionSchema = z.object({
  type: z.enum(["CATEGORY", "ACCOUNT", "REPORT_TYPE"]),
  value: z.string().min(1),
  delivery: deliverySchema,
});

const updateSubscriptionSchema = z.object({
  isActive: z.boolean().optional(),
  delivery: deliverySchema,
});

/**
 * Defense-in-depth userId guard.
 *
 * `authenticate` already rejects unauthenticated requests with 401, so in
 * normal operation `req.userId` is guaranteed to be set before any handler
 * here runs. This helper exists for two reasons:
 *
 *   1. TypeScript narrowing. `AuthRequest.userId` is declared as
 *      `string | undefined`, so every query used to carry a `req.userId!`
 *      non-null assertion. A silent middleware-ordering regression could
 *      then compile cleanly and leak every user's alert data to anonymous
 *      callers. Narrowing to `string` at the top of each handler makes
 *      the compiler refuse any query that forgets to scope.
 *
 *   2. Layered defense. If a future refactor ever moves `alertsRouter.use(
 *      authenticate)` or introduces a pre-middleware that bypasses it, the
 *      handler's own 401 response stops the request before it reaches a
 *      Prisma query. This is the "alert security — add userId filter" fix
 *      tracked as atlas-backend #3947.
 *
 * Returns the userId string on success, or `null` after having written a
 * 401 response to `res`. Callers must early-return on `null`.
 */
function requireUserId(req: AuthRequest, res: Response): string | null {
  if (!req.userId) {
    res.status(401).json(buildErrorResponse(req, "Unauthorized"));
    return null;
  }
  return req.userId;
}

// Get user's alert subscriptions
alertsRouter.get("/subscriptions", async (req: AuthRequest, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const { take, skip } = parsePagination(req.query, { limit: 20, offset: 0 });

    const subscriptions = await prisma.alertSubscription.findMany({
      where: { userId },
      take,
      skip,
    });
    res.json(success({ subscriptions }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to load subscriptions");
    res
      .status(500)
      .json(buildErrorResponse(req, "Failed to load subscriptions", { message: err.message }));
  }
});

// Add subscription
alertsRouter.post("/subscriptions", async (req: AuthRequest, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const body = subscriptionSchema.parse(req.body);

    const subscription = await prisma.alertSubscription.upsert({
      where: {
        userId_type_value: { userId, type: body.type, value: body.value },
      },
      update: { isActive: true, delivery: body.delivery || ["PORTAL"] },
      create: {
        userId,
        type: body.type,
        value: body.value,
        delivery: body.delivery || ["PORTAL"],
      },
    });

    res.json(success({ subscription }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      if (req.body?.type === undefined || req.body?.value === undefined) {
        return res.status(400).json(buildErrorResponse(req, "Type and value required"));
      }
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    res
      .status(500)
      .json(buildErrorResponse(req, "Failed to save subscription"));
  }
});

// Toggle subscription
alertsRouter.patch("/subscriptions/:id", async (req: AuthRequest, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const body = updateSubscriptionSchema.parse(req.body);

    // Ownership check — scoped to this user. If another user owns the row
    // (or no row exists), findFirst returns null and we 404 before the
    // update ever runs. The subsequent update is keyed by primary id only,
    // but it's protected by the prior check.
    const sub = await prisma.alertSubscription.findFirst({
      where: { id: req.params.id as string, userId },
    });
    if (!sub) return res.status(404).json(buildErrorResponse(req, "Subscription not found"));

    const updated = await prisma.alertSubscription.update({
      where: { id: req.params.id as string },
      data: {
        ...(body.isActive !== undefined && { isActive: body.isActive }),
        ...(body.delivery !== undefined && { delivery: body.delivery }),
      },
    });

    res.json(success({ subscription: updated }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json(buildErrorResponse(req, "Invalid request", { details: err.errors }));
    }
    res
      .status(500)
      .json(buildErrorResponse(req, "Failed to update subscription"));
  }
});

// Delete subscription
alertsRouter.delete("/subscriptions/:id", async (req: AuthRequest, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    // Ownership check — see PATCH handler for why we scope findFirst by
    // userId and only then delete by primary id.
    const sub = await prisma.alertSubscription.findFirst({
      where: { id: req.params.id as string, userId },
    });
    if (!sub) return res.status(404).json(buildErrorResponse(req, "Subscription not found"));

    await prisma.alertSubscription.delete({ where: { id: req.params.id as string } });
    res.json(success({ success: true }));
  } catch (err: any) {
    res
      .status(500)
      .json(buildErrorResponse(req, "Failed to delete subscription"));
  }
});

// Get recent alerts (feed) — must be before /:id to avoid matching "feed" as an ID
alertsRouter.get("/feed", async (req: AuthRequest, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const { take, skip } = parsePagination(req.query, { limit: 20, offset: 0 });

    const category = req.query.category as string | undefined;
    const where: any = { userId };
    if (category) {
      where.category = category;
    }

    const alerts = await prisma.alert.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      skip,
    });

    alerts.forEach((alert: any) => {
      if (alert.createdAt instanceof Date) {
        alert.createdAt = alert.createdAt.toISOString();
      }
    });

    res.json(success({ alerts }));
  } catch (err: any) {
    res.status(500).json(buildErrorResponse(req, "Failed to load alert feed"));
  }
});

// Get single alert (ownership verified)
alertsRouter.get("/:id", async (req: AuthRequest, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const alertId = req.params.id as string;
    const alert = await prisma.alert.findFirst({
      where: { id: alertId, userId },
    });
    if (!alert) return res.status(404).json(buildErrorResponse(req, "Alert not found"));
    res.json(success({ alert }));
  } catch (err: any) {
    res.status(500).json(buildErrorResponse(req, "Failed to get alert"));
  }
});

// Dismiss/acknowledge alert (set expiresAt to now, ownership verified)
alertsRouter.patch("/:id", async (req: AuthRequest, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const alertId = req.params.id as string;
    // Ownership check — scoped to this user before the update.
    const alert = await prisma.alert.findFirst({
      where: { id: alertId, userId },
    });
    if (!alert) return res.status(404).json(buildErrorResponse(req, "Alert not found"));

    const updated = await prisma.alert.update({
      where: { id: alertId },
      data: { expiresAt: new Date() },
    });
    res.json(success({ alert: updated }));
  } catch (err: any) {
    res.status(500).json(buildErrorResponse(req, "Failed to update alert"));
  }
});

// Delete alert (ownership verified)
alertsRouter.delete("/:id", async (req: AuthRequest, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const alertId = req.params.id as string;
    // Ownership check — scoped to this user before the delete.
    const alert = await prisma.alert.findFirst({
      where: { id: alertId, userId },
    });
    if (!alert) return res.status(404).json(buildErrorResponse(req, "Alert not found"));

    await prisma.alert.delete({ where: { id: alertId } });
    res.json(success({ success: true }));
  } catch (err: any) {
    res.status(500).json(buildErrorResponse(req, "Failed to delete alert"));
  }
});
