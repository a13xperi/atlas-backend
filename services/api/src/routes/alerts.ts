import { Router } from "express";
import { z } from "zod";
import { parsePagination } from "../lib/pagination";
import { prisma } from "../lib/prisma";
import { error, success } from "../lib/response";
import { authenticate, AuthRequest } from "../middleware/auth";
import { logger } from "../lib/logger";

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

const dismissAlertSchema = z.object({}).passthrough();

// Get user's alert subscriptions
alertsRouter.get("/subscriptions", async (req: AuthRequest, res) => {
  try {
    const { take, skip } = parsePagination(req.query, { limit: 20, offset: 0 });

    const subscriptions = await prisma.alertSubscription.findMany({
      where: { userId: req.userId },
      take,
      skip,
    });
    res.json(success({ subscriptions }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to load subscriptions");
    res.status(500).json(error("Failed to load subscriptions", 500, { message: err.message }));
  }
});

// Add subscription
alertsRouter.post("/subscriptions", async (req: AuthRequest, res) => {
  try {
    const body = subscriptionSchema.parse(req.body);

    const subscription = await prisma.alertSubscription.upsert({
      where: {
        userId_type_value: { userId: req.userId!, type: body.type, value: body.value },
      },
      update: { isActive: true, delivery: body.delivery || ["PORTAL"] },
      create: {
        userId: req.userId!,
        type: body.type,
        value: body.value,
        delivery: body.delivery || ["PORTAL"],
      },
    });

    res.json(success({ subscription }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to save subscription"));
  }
});

// Toggle subscription
alertsRouter.patch("/subscriptions/:id", async (req: AuthRequest, res) => {
  try {
    const body = updateSubscriptionSchema.parse(req.body);

    const sub = await prisma.alertSubscription.findFirst({
      where: { id: req.params.id as string, userId: req.userId },
    });
    if (!sub) return res.status(404).json(error("Subscription not found"));

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
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to update subscription"));
  }
});

// Delete subscription
alertsRouter.delete("/subscriptions/:id", async (req: AuthRequest, res) => {
  try {
    const sub = await prisma.alertSubscription.findFirst({
      where: { id: req.params.id as string, userId: req.userId },
    });
    if (!sub) return res.status(404).json(error("Subscription not found"));

    await prisma.alertSubscription.delete({ where: { id: req.params.id as string } });
    res.json(success({ success: true }));
  } catch (err: any) {
    res.status(500).json(error("Failed to delete subscription"));
  }
});

// Get recent alerts (feed) — must be before /:id to avoid matching "feed" as an ID
alertsRouter.get("/feed", async (req: AuthRequest, res) => {
  try {
    const { take, skip } = parsePagination(req.query, { limit: 20, offset: 0 });

    const alerts = await prisma.alert.findMany({
      where: { userId: req.userId },
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
    res.status(500).json(error("Failed to load alert feed"));
  }
});

// Get single alert
alertsRouter.get("/:id", async (req: AuthRequest, res) => {
  try {
    const alertId = req.params.id as string;
    const alert = await prisma.alert.findUnique({ where: { id: alertId } });
    if (!alert) return res.status(404).json(error("Alert not found"));
    res.json(success({ alert }));
  } catch (err: any) {
    res.status(500).json(error("Failed to get alert"));
  }
});

// Dismiss/acknowledge alert (set expiresAt to now)
alertsRouter.patch("/:id", async (req: AuthRequest, res) => {
  try {
    dismissAlertSchema.parse(req.body ?? {});

    const alertId = req.params.id as string;
    const alert = await prisma.alert.findUnique({ where: { id: alertId } });
    if (!alert) return res.status(404).json(error("Alert not found"));

    const updated = await prisma.alert.update({
      where: { id: alertId },
      data: { expiresAt: new Date() },
    });
    res.json(success({ alert: updated }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to update alert"));
  }
});

// Delete alert
alertsRouter.delete("/:id", async (req: AuthRequest, res) => {
  try {
    const alertId = req.params.id as string;
    const alert = await prisma.alert.findUnique({ where: { id: alertId } });
    if (!alert) return res.status(404).json(error("Alert not found"));

    await prisma.alert.delete({ where: { id: alertId } });
    res.json(success({ success: true }));
  } catch (err: any) {
    res.status(500).json(error("Failed to delete alert"));
  }
});
