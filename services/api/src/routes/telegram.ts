import { Router } from "express";
import { z } from "zod";
import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import {
  formatTelegramDispatchMessage,
  sendTelegramMessage,
} from "../lib/telegramClient";
import { error, success } from "../lib/response";
import { authenticate, AuthRequest } from "../middleware/auth";

export const telegramRouter = Router();
telegramRouter.use(authenticate);

const connectSchema = z.object({
  chatId: z
    .union([z.string(), z.number()])
    .transform((value) => String(value).trim())
    .refine((value) => value.length > 0, "chatId is required"),
});

const sendSchema = z.object({
  userId: z.string().min(1),
  message: z.string().trim().min(1),
  type: z.enum(["alert", "report", "digest"]),
});

telegramRouter.post("/connect", async (req: AuthRequest, res) => {
  try {
    const { chatId } = connectSchema.parse(req.body);

    const existingLink = await prisma.user.findFirst({
      where: {
        telegramChatId: chatId,
        id: { not: req.userId },
      },
      select: { id: true },
    });

    if (existingLink) {
      return res.status(409).json(error("Telegram chat is already linked to another Atlas account"));
    }

    const user = await prisma.user.update({
      where: { id: req.userId },
      data: { telegramChatId: chatId },
      select: { id: true, handle: true, telegramChatId: true },
    });

    res.json(success({ user }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }

    logger.error({ err: err.message }, "Failed to connect Telegram chat");
    res.status(500).json(error("Failed to connect Telegram"));
  }
});

telegramRouter.post("/send", async (req: AuthRequest, res) => {
  try {
    const body = sendSchema.parse(req.body);

    const requester = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { role: true },
    });

    if (!requester) {
      return res.status(404).json(error("User not found"));
    }

    if (requester.role === "ANALYST" && body.userId !== req.userId) {
      return res
        .status(403)
        .json(error("Cannot send Telegram messages for another user"));
    }

    const recipient = await prisma.user.findUnique({
      where: { id: body.userId },
      select: { telegramChatId: true },
    });

    if (!recipient?.telegramChatId) {
      return res.status(404).json(error("Telegram is not linked for that user"));
    }

    const sent = await sendTelegramMessage(
      recipient.telegramChatId,
      formatTelegramDispatchMessage(body.type, body.message),
    );

    if (!sent) {
      return res.status(502).json(error("Failed to send Telegram message"));
    }

    res.json(success({ sent: true }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }

    logger.error({ err: err.message }, "Failed to send Telegram message");
    res.status(500).json(error("Failed to send Telegram message"));
  }
});
