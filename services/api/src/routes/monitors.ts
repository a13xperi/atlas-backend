import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { logger } from "../lib/logger";

export const monitorsRouter = Router();
monitorsRouter.use(authenticate);

function paramId(req: AuthRequest): string {
  return paramId(req) as string;
}

const createSchema = z.object({
  name: z.string().min(1).max(100),
  keywords: z.array(z.string().min(1).max(100)).min(1).max(20),
  minRelevance: z.number().min(0).max(1).optional(),
  delivery: z.array(z.enum(["PORTAL", "TELEGRAM"])).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  keywords: z.array(z.string().min(1).max(100)).min(1).max(20).optional(),
  minRelevance: z.number().min(0).max(1).optional(),
  delivery: z.array(z.enum(["PORTAL", "TELEGRAM"])).optional(),
  isActive: z.boolean().optional(),
});

// List user's monitors
monitorsRouter.get("/", async (req: AuthRequest, res) => {
  try {
    const monitors = await prisma.nlpMonitor.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: "desc" },
    });
    res.json({ monitors });
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to list monitors");
    res.status(500).json({ error: "Failed to list monitors" });
  }
});

// Create monitor
monitorsRouter.post("/", async (req: AuthRequest, res) => {
  try {
    const body = createSchema.parse(req.body);
    const monitor = await prisma.nlpMonitor.create({
      data: {
        userId: req.userId!,
        name: body.name,
        keywords: body.keywords,
        minRelevance: body.minRelevance ?? 0.5,
        delivery: body.delivery ?? ["PORTAL"],
      },
    });
    logger.info({ monitorId: monitor.id, userId: req.userId }, "Monitor created");
    res.status(201).json({ monitor });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request", details: err.errors });
    }
    if (err.code === "P2002") {
      return res.status(409).json({ error: "A monitor with that name already exists" });
    }
    logger.error({ err: err.message }, "Failed to create monitor");
    res.status(500).json({ error: "Failed to create monitor" });
  }
});

// Update monitor
monitorsRouter.patch("/:id", async (req: AuthRequest, res) => {
  try {
    const body = updateSchema.parse(req.body);
    const monitor = await prisma.nlpMonitor.updateMany({
      where: { id: paramId(req), userId: req.userId },
      data: body,
    });
    if (monitor.count === 0) {
      return res.status(404).json({ error: "Monitor not found" });
    }
    const updated = await prisma.nlpMonitor.findUnique({ where: { id: paramId(req) } });
    res.json({ monitor: updated });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request", details: err.errors });
    }
    logger.error({ err: err.message }, "Failed to update monitor");
    res.status(500).json({ error: "Failed to update monitor" });
  }
});

// Delete monitor
monitorsRouter.delete("/:id", async (req: AuthRequest, res) => {
  try {
    const deleted = await prisma.nlpMonitor.deleteMany({
      where: { id: paramId(req), userId: req.userId },
    });
    if (deleted.count === 0) {
      return res.status(404).json({ error: "Monitor not found" });
    }
    res.json({ success: true });
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to delete monitor");
    res.status(500).json({ error: "Failed to delete monitor" });
  }
});

// Match keywords against text — used by trending scan
export function matchMonitorKeywords(
  text: string,
  keywords: string[],
): { matched: boolean; matchedKeywords: string[]; score: number } {
  const lowerText = text.toLowerCase();
  const matchedKeywords = keywords.filter((kw) => lowerText.includes(kw.toLowerCase()));
  return {
    matched: matchedKeywords.length > 0,
    matchedKeywords,
    score: matchedKeywords.length / keywords.length,
  };
}
