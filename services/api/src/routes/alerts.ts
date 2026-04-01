import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";

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

// Get user's alert subscriptions
alertsRouter.get("/subscriptions", async (req: AuthRequest, res) => {
  const subscriptions = await prisma.alertSubscription.findMany({
    where: { userId: req.userId },
  });
  res.json({ subscriptions });
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

    res.json({ subscription });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      if (req.body?.type === undefined || req.body?.value === undefined) {
        return res.status(400).json({ error: "Type and value required" });
      }
      return res.status(400).json({ error: "Invalid request", details: err.errors });
    }
    res.status(500).json({ error: "Failed to save subscription", message: err.message });
  }
});

// Toggle subscription
alertsRouter.patch("/subscriptions/:id", async (req: AuthRequest, res) => {
  try {
    const body = updateSubscriptionSchema.parse(req.body);

    const sub = await prisma.alertSubscription.findFirst({
      where: { id: req.params.id as string, userId: req.userId },
    });
    if (!sub) return res.status(404).json({ error: "Subscription not found" });

    const updated = await prisma.alertSubscription.update({
      where: { id: req.params.id as string },
      data: {
        ...(body.isActive !== undefined && { isActive: body.isActive }),
        ...(body.delivery !== undefined && { delivery: body.delivery }),
      },
    });

    res.json({ subscription: updated });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request", details: err.errors });
    }
    res.status(500).json({ error: "Failed to update subscription", message: err.message });
  }
});

// Delete subscription
alertsRouter.delete("/subscriptions/:id", async (req: AuthRequest, res) => {
  const sub = await prisma.alertSubscription.findFirst({
    where: { id: req.params.id as string, userId: req.userId },
  });
  if (!sub) return res.status(404).json({ error: "Subscription not found" });

  await prisma.alertSubscription.delete({ where: { id: req.params.id as string } });
  res.json({ success: true });
});

// Get recent alerts (feed) — must be before /:id to avoid matching "feed" as an ID
alertsRouter.get("/feed", async (req: AuthRequest, res) => {
  const { limit = "20", offset = "0" } = req.query;

  const alerts = await prisma.alert.findMany({
    orderBy: { createdAt: "desc" },
    take: parseInt(limit as string),
    skip: parseInt(offset as string),
  });

  alerts.forEach((alert: any) => {
    if (alert.createdAt instanceof Date) {
      alert.createdAt = alert.createdAt.toISOString();
    }
  });

  res.json({ alerts });
});

// Get single alert
alertsRouter.get("/:id", async (req: AuthRequest, res) => {
  try {
    const alertId = req.params.id as string;
    const alert = await prisma.alert.findUnique({ where: { id: alertId } });
    if (!alert) return res.status(404).json({ error: "Alert not found" });
    res.json({ alert });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to get alert", message: err.message });
  }
});

// Dismiss/acknowledge alert (set expiresAt to now)
alertsRouter.patch("/:id", async (req: AuthRequest, res) => {
  try {
    const alertId = req.params.id as string;
    const alert = await prisma.alert.findUnique({ where: { id: alertId } });
    if (!alert) return res.status(404).json({ error: "Alert not found" });

    const updated = await prisma.alert.update({
      where: { id: alertId },
      data: { expiresAt: new Date() },
    });
    res.json({ alert: updated });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to update alert", message: err.message });
  }
});

// Delete alert
alertsRouter.delete("/:id", async (req: AuthRequest, res) => {
  try {
    const alertId = req.params.id as string;
    const alert = await prisma.alert.findUnique({ where: { id: alertId } });
    if (!alert) return res.status(404).json({ error: "Alert not found" });

    await prisma.alert.delete({ where: { id: alertId } });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to delete alert", message: err.message });
  }
});
