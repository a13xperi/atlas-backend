import { Prisma } from "@prisma/client";
import { Response, Router } from "express";
import { z } from "zod";
import { config } from "../lib/config";
import { logger } from "../lib/logger";
import {
  PaperclipError,
  type PaperclipTaskTriggerInput,
  triggerPaperclipTask,
} from "../lib/paperclip";
import { prisma } from "../lib/prisma";
import { error, success } from "../lib/response";
import { deliverAlertToUser } from "../lib/telegram";
import { authenticate, AuthRequest } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";

export const paperclipRouter: Router = Router();

/**
 * IP-based rate limiter for the public Paperclip webhook endpoint.
 *
 * The webhook is "public" in that it carries no `Authorization` header —
 * it's protected by a shared `x-paperclip-secret`, which stops external
 * attackers but does nothing about an upstream Paperclip bug looping on
 * digest.ready events, nor about a leaked secret being blasted at the
 * endpoint. Each successful hit creates a `briefing` row and fans out a
 * Telegram alert, so the blast radius of "too many valid hits" is real.
 *
 * 30 req/min per IP is tighter than the general `/api` limiter
 * (100/min) and leaves enough headroom for normal Paperclip traffic,
 * which in practice sends a handful of digests per user per day. The
 * `"paperclip-webhook"` namespace prevents counter collision with any
 * other route-level limiter that might stack on the same path.
 *
 * This limiter is ONLY wired into the `/webhook` route (see below) —
 * `/trigger` is authenticated + admin-gated and already benefits from
 * the per-user general limiter.
 */
const paperclipWebhookRateLimiter = rateLimit(30, 60 * 1000, "paperclip-webhook");

const supportedEventTypes = [
  "task.completed",
  "agent.decision",
  "digest.ready",
] as const;

const webhookEnvelopeSchema = z
  .object({
    type: z.string().optional(),
    event: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const digestShapeSchema = z
  .object({
    title: z.string().optional(),
    summary: z.string().optional(),
    content: z.string().optional(),
    sections: z.array(z.unknown()).optional(),
    topics: z.array(z.string()).optional(),
    sources: z.array(z.string()).optional(),
  })
  .passthrough();

const digestPayloadSchema = z
  .object({
    userId: z.string().optional(),
    atlasUserId: z.string().optional(),
    title: z.string().optional(),
    summary: z.string().optional(),
    content: z.string().optional(),
    sections: z.array(z.unknown()).optional(),
    topics: z.array(z.string()).optional(),
    sources: z.array(z.string()).optional(),
    digest: z.union([z.string(), digestShapeSchema]).optional(),
  })
  .passthrough();

const triggerSchema = z.object({
  agentId: z.string().min(1),
  taskType: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
});

async function requireAdmin(req: AuthRequest, res: Response): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { role: true },
  });

  if (!user || user.role !== "ADMIN") {
    res.status(403).json(error("Admin access required", 403));
    return false;
  }

  return true;
}

function normalizeDigestPayload(input: unknown) {
  const parsed = digestPayloadSchema.safeParse(input);
  if (!parsed.success) return null;

  const payload = parsed.data;
  const digest =
    typeof payload.digest === "string"
      ? { content: payload.digest }
      : payload.digest;

  const userId = payload.userId ?? payload.atlasUserId;
  const title = (digest?.title ?? payload.title ?? "Paperclip Digest").trim();
  const summary = (
    digest?.summary ??
    payload.summary ??
    digest?.content ??
    payload.content ??
    ""
  ).trim();
  const sections =
    digest?.sections ??
    payload.sections ??
    (summary
      ? [
          {
            heading: "Paperclip Digest",
            emoji: "🧠",
            bullets: [summary],
          },
        ]
      : []);
  const topics = digest?.topics ?? payload.topics ?? [];
  const sources = digest?.sources ?? payload.sources ?? ["Paperclip"];

  if (!userId || !summary) return null;

  return {
    userId,
    title,
    summary,
    sections,
    topics,
    sources,
  };
}

paperclipRouter.post("/webhook", paperclipWebhookRateLimiter, async (req, res) => {
  try {
    const expectedSecret = config.PAPERCLIP_WEBHOOK_SECRET?.trim();
    if (!expectedSecret) {
      return res
        .status(500)
        .json(error("PAPERCLIP_WEBHOOK_SECRET is not configured", 500));
    }

    const receivedSecret = req.header("x-paperclip-secret")?.trim();
    if (receivedSecret !== expectedSecret) {
      return res.status(401).json(error("Invalid Paperclip secret", 401));
    }

    const envelope = webhookEnvelopeSchema.safeParse(req.body);
    if (!envelope.success) {
      return res.status(400).json(error("Invalid request", 400, envelope.error.errors));
    }

    const eventType = (envelope.data.type ?? envelope.data.event) as
      | (typeof supportedEventTypes)[number]
      | undefined;

    if (!eventType || !supportedEventTypes.includes(eventType)) {
      return res.status(400).json(error("Unsupported Paperclip event", 400));
    }

    if (eventType !== "digest.ready") {
      logger.info({ eventType }, "[paperclip] Webhook event acknowledged");
      return res.json(success({ received: true, event: eventType }));
    }

    const digestPayload = normalizeDigestPayload(
      envelope.data.data ?? envelope.data.payload ?? req.body,
    );

    if (!digestPayload) {
      return res.status(400).json(error("Invalid digest payload", 400));
    }

    const briefing = await prisma.briefing.create({
      data: {
        userId: digestPayload.userId,
        title: digestPayload.title,
        summary: digestPayload.summary,
        sections: digestPayload.sections as Prisma.InputJsonValue,
        topics: digestPayload.topics,
        sources: digestPayload.sources,
      },
    });

    const telegramNotified = await deliverAlertToUser(
      {
        title: digestPayload.title,
        context: digestPayload.summary,
      },
      digestPayload.userId,
    );

    logger.info(
      {
        eventType,
        userId: digestPayload.userId,
        briefingId: briefing.id,
        telegramNotified,
      },
      "[paperclip] Digest stored",
    );

    res.json(
      success({
        received: true,
        event: eventType,
        briefingId: briefing.id,
        telegramNotified,
      }),
    );
  } catch (err) {
    logger.error({ err }, "[paperclip] Webhook handling failed");
    res.status(500).json(error("Failed to process Paperclip webhook", 500));
  }
});

paperclipRouter.post("/trigger", authenticate, async (req: AuthRequest, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;

    const input = triggerSchema.parse(req.body) as PaperclipTaskTriggerInput;
    const task = await triggerPaperclipTask(input);

    res.status(201).json(success({ task: task ?? null }));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }

    if (err instanceof PaperclipError) {
      return res
        .status(err.statusCode)
        .json(error(err.message, err.statusCode, err.details));
    }

    logger.error({ err }, "[paperclip] Trigger failed");
    res.status(500).json(error("Failed to trigger Paperclip task", 500));
  }
});
