import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { error, success } from "../lib/response";
import { authenticate, AuthRequest } from "../middleware/auth";
import {
  getBackupConfigurationSummary,
  getLatestBackupLog,
  serializeBackupLog,
  triggerBackup,
} from "../lib/backup";
import { AppError } from "../lib/errors";

export const adminBackupRouter: Router = Router();
adminBackupRouter.use(authenticate);

const triggerBackupSchema = z
  .object({
    reason: z.string().trim().max(200).optional(),
  })
  .passthrough();

adminBackupRouter.post("/trigger", async (req: AuthRequest, res) => {
  try {
    triggerBackupSchema.parse(req.body ?? {});

    const currentUser = await requireAdmin(req);
    if (!currentUser) {
      return res.status(403).json(error("Admin access required", 403));
    }

    const backupLog = await triggerBackup({ triggerSource: "MANUAL" });
    res.json(
      success({
        backup: serializeBackupLog(backupLog),
        configuration: getBackupConfigurationSummary(),
      })
    );
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    if (err instanceof AppError && err.statusCode === 409) {
      return res.status(409).json(error(err.message, 409));
    }
    res.status(500).json(error("Failed to trigger backup", 500));
  }
});

adminBackupRouter.get("/status", async (req: AuthRequest, res) => {
  try {
    const currentUser = await requireAdmin(req);
    if (!currentUser) {
      return res.status(403).json(error("Admin access required", 403));
    }

    const latestBackup = await getLatestBackupLog();
    res.json(
      success({
        backup: serializeBackupLog(latestBackup),
        configuration: getBackupConfigurationSummary(),
      })
    );
  } catch (err: any) {
    res.status(500).json(error("Failed to load backup status", 500));
  }
});

async function requireAdmin(req: AuthRequest) {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, role: true },
  });

  if (!user || user.role !== "ADMIN") {
    return null;
  }

  return user;
}
