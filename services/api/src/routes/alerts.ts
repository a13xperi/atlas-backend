import { Router } from "express";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";

export const alertsRouter = Router();
alertsRouter.use(authenticate);

// Get user's alert subscriptions
alertsRouter.get("/subscriptions", async (req: AuthRequest, res) => {
  const subscriptions = await prisma.alertSubscription.findMany({
    where: { userId: req.userId },
  });
  res.json({ subscriptions });
});

// Add subscription
alertsRouter.post("/subscriptions", async (req: AuthRequest, res) => {
  const { type, value, delivery } = req.body;
  if (!type || !value) return res.status(400).json({ error: "Type and value required" });

  const subscription = await prisma.alertSubscription.upsert({
    where: {
      userId_type_value: { userId: req.userId!, type, value },
    },
    update: { isActive: true, delivery: delivery || ["PORTAL"] },
    create: {
      userId: req.userId!,
      type,
      value,
      delivery: delivery || ["PORTAL"],
    },
  });

  res.json({ subscription });
});

// Toggle subscription
alertsRouter.patch("/subscriptions/:id", async (req: AuthRequest, res) => {
  const { isActive, delivery } = req.body;

  const sub = await prisma.alertSubscription.findFirst({
    where: { id: req.params.id as string, userId: req.userId },
  });
  if (!sub) return res.status(404).json({ error: "Subscription not found" });

  const updated = await prisma.alertSubscription.update({
    where: { id: req.params.id as string },
    data: {
      ...(isActive !== undefined && { isActive }),
      ...(delivery && { delivery }),
    },
  });

  res.json({ subscription: updated });
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
  const { limit = "20" } = req.query;

  const alerts = await prisma.alert.findMany({
    orderBy: { createdAt: "desc" },
    take: parseInt(limit as string),
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
