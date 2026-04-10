import { Prisma } from "@prisma/client";
import { Router, type Response } from "express";
import { z } from "zod";
import { authenticate, AuthRequest } from "../middleware/auth";
import { routeCompletion } from "../lib/providers/router";
import {
  buildCalibrationCommentary,
  buildBlendPreview,
  buildDimensionReaction,
  buildFreeTextResponse,
} from "../lib/oracle-prompt";
import {
  buildOracleCopilotSystemPrompt,
  buildOracleSessionContext,
  oracleContextInputSchema,
  parseOracleContext,
  parseOracleMessages,
  serializeOracleSession,
  type OracleStoredMessage,
} from "../lib/oracle-session";
import { streamOracleResponse } from "../lib/oracle-chat";
import { success, error } from "../lib/response";
import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { withTimeout } from "../lib/timeout";
import type { Message } from "../lib/providers/types";

export const oracleRouter = Router();
oracleRouter.use(authenticate);

// ── Schema ───────────────────────────────────────────────────────

const dimensionsSchema = z.object({
  humor: z.number(),
  formality: z.number(),
  brevity: z.number(),
  contrarianTone: z.number(),
  directness: z.number().optional(),
  warmth: z.number().optional(),
  technicalDepth: z.number().optional(),
  confidence: z.number().optional(),
  evidenceOrientation: z.number().optional(),
  solutionOrientation: z.number().optional(),
  socialPosture: z.number().optional(),
  selfPromotionalIntensity: z.number().optional(),
});

const legacyMessageSchema = z.object({
  track: z.enum(["a", "b"]),
  step: z.string(),
  action: z.string(),
  context: z
    .object({
      dimensions: dimensionsSchema.optional(),
      selectedRefs: z.array(z.string()).optional(),
      blendRatio: z.number().optional(),
      blendVoices: z
        .array(z.object({ label: z.string(), percentage: z.number() }))
        .optional(),
      topics: z.array(z.string()).optional(),
      calibrationResult: z
        .object({
          analysis: z.string(),
          tweetsAnalyzed: z.number(),
        })
        .optional(),
      handle: z.string().optional(),
      freeText: z.string().optional(),
    })
    .optional(),
});

const oracleSessionRequestSchema = z.object({
  sessionId: z.string().min(1).optional(),
  createNew: z.boolean().optional(),
  context: oracleContextInputSchema.optional(),
});

const sessionMessageSchema = z.object({
  sessionId: z.string().min(1),
  content: z.string().min(1).max(4000),
  context: oracleContextInputSchema.optional(),
});

// ── Session Endpoints ────────────────────────────────────────────

oracleRouter.post("/session", async (req: AuthRequest, res) => {
  try {
    const body = oracleSessionRequestSchema.parse(req.body ?? {});

    if (body.sessionId) {
      const existing = await prisma.oracleSession.findFirst({
        where: { id: body.sessionId, userId: req.userId! },
      });

      if (!existing) {
        return res.status(404).json(error("Oracle session not found", 404));
      }

      const updatedContext = await buildOracleSessionContext(
        req.userId!,
        body.context,
        parseOracleContext(existing.context),
      );

      const session = await prisma.oracleSession.update({
        where: { id: existing.id },
        data: {
          context: updatedContext as Prisma.InputJsonValue,
        },
      });

      return res.json(success({ session: serializeOracleSession(session), created: false }));
    }

    let session = body.createNew
      ? null
      : await prisma.oracleSession.findFirst({
          where: { userId: req.userId! },
          orderBy: { updatedAt: "desc" },
        });

    if (session) {
      const updatedContext = await buildOracleSessionContext(
        req.userId!,
        body.context,
        parseOracleContext(session.context),
      );

      session = await prisma.oracleSession.update({
        where: { id: session.id },
        data: {
          context: updatedContext as Prisma.InputJsonValue,
        },
      });

      return res.json(success({ session: serializeOracleSession(session), created: false }));
    }

    const context = await buildOracleSessionContext(req.userId!, body.context);

    session = await prisma.oracleSession.create({
      data: {
        userId: req.userId!,
        messages: [] as Prisma.InputJsonValue[],
        context: context as Prisma.InputJsonValue,
      },
    });

    prisma.analyticsEvent
      .create({
        data: {
          userId: req.userId!,
          type: "SESSION_START",
          metadata: {
            oracleSessionId: session.id,
            persistent: true,
          },
        },
      })
      .catch((analyticsError) => {
        logger.warn({ error: analyticsError }, "Failed to log oracle session analytics");
      });

    res.status(201).json(success({ session: serializeOracleSession(session), created: true }));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }

    logger.error({ error: err }, "Oracle session create/retrieve error");
    res.status(500).json(error("Failed to open Oracle session"));
  }
});

oracleRouter.get("/session/:id", async (req: AuthRequest, res) => {
  try {
    const session = await prisma.oracleSession.findFirst({
      where: { id: req.params.id, userId: req.userId! },
    });

    if (!session) {
      return res.status(404).json(error("Oracle session not found", 404));
    }

    res.json(success({ session: serializeOracleSession(session) }));
  } catch (err) {
    logger.error({ error: err, sessionId: req.params.id }, "Oracle session fetch error");
    res.status(500).json(error("Failed to fetch Oracle session"));
  }
});

oracleRouter.delete("/session/:id", async (req: AuthRequest, res) => {
  try {
    const deleted = await prisma.oracleSession.deleteMany({
      where: { id: req.params.id, userId: req.userId! },
    });

    if (deleted.count === 0) {
      return res.status(404).json(error("Oracle session not found", 404));
    }

    res.json(success({ deleted: true }));
  } catch (err) {
    logger.error({ error: err, sessionId: req.params.id }, "Oracle session delete error");
    res.status(500).json(error("Failed to clear Oracle session"));
  }
});

// ── Message Route ────────────────────────────────────────────────

oracleRouter.post("/message", async (req: AuthRequest, res) => {
  const legacyResult = legacyMessageSchema.safeParse(req.body);
  if (legacyResult.success) {
    await handleLegacyOracleMessage(req, res, legacyResult.data);
    return;
  }

  const persistentResult = sessionMessageSchema.safeParse(req.body);
  if (persistentResult.success) {
    await handlePersistentOracleMessage(req, res, persistentResult.data);
    return;
  }

  res.status(400).json(error("Invalid request", 400, {
    onboarding: legacyResult.error.flatten(),
    session: persistentResult.error.flatten(),
  }));
});

async function handleLegacyOracleMessage(
  req: AuthRequest,
  res: Response,
  body: z.infer<typeof legacyMessageSchema>,
) {
  try {
    const ctx = body.context ?? {};

    let messages: Array<{ content: string; role: "oracle" }> = [];
    let llmGenerated = false;

    const prompt = resolvePrompt(body.action, body.step, ctx);

    if (prompt) {
      try {
        const response = await withTimeout(
          routeCompletion({
            taskType: prompt.taskType as "oracle_smart" | "oracle_fast",
            maxTokens: prompt.maxTokens,
            temperature: prompt.temperature,
            messages: [
              { role: "system", content: prompt.system },
              { role: "user", content: prompt.userMessage },
            ],
          }),
          8_000,
          "oracle-message",
        );

        messages = [{ content: response.content.trim(), role: "oracle" }];
        llmGenerated = true;

        logger.info(
          {
            provider: response.provider,
            model: response.model,
            latencyMs: response.latencyMs,
            track: body.track,
            step: body.step,
            action: body.action,
          },
          "Oracle onboarding response generated",
        );
      } catch (llmError) {
        logger.warn(
          { error: llmError instanceof Error ? llmError.message : String(llmError), step: body.step },
          "Oracle onboarding call failed, falling back to scripted response",
        );
      }
    }

    prisma.analyticsEvent
      .create({
        data: {
          userId: req.userId!,
          type: "SESSION_START",
          metadata: {
            track: body.track,
            step: body.step,
            action: body.action,
            llmGenerated,
          },
        },
      })
      .catch((analyticsError) => {
        logger.warn({ error: analyticsError }, "Failed to log oracle onboarding analytics");
      });

    res.json(success({ messages, llmGenerated }));
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json(error("Invalid request", 400, err.errors));
      return;
    }

    logger.error({ error: err }, "Oracle onboarding message error");
    res.status(500).json(error("Internal server error"));
  }
}

async function handlePersistentOracleMessage(
  req: AuthRequest,
  res: Response,
  body: z.infer<typeof sessionMessageSchema>,
) {
  let clientClosed = false;

  try {
    const session = await prisma.oracleSession.findFirst({
      where: { id: body.sessionId, userId: req.userId! },
    });

    if (!session) {
      return res.status(404).json(error("Oracle session not found", 404));
    }

    const existingMessages = parseOracleMessages(session.messages);
    const context = await buildOracleSessionContext(
      req.userId!,
      body.context,
      parseOracleContext(session.context),
    );

    const userMessage: OracleStoredMessage = {
      role: "user",
      content: body.content,
      timestamp: new Date().toISOString(),
    };

    const pendingMessages = [...existingMessages, userMessage];

    await prisma.oracleSession.update({
      where: { id: session.id },
      data: {
        messages: pendingMessages as unknown as Prisma.InputJsonValue[],
        context: context as Prisma.InputJsonValue,
      },
    });

    initSse(res);
    sendSseEvent(res, "session", { sessionId: session.id });
    sendSseEvent(res, "message_start", { role: "oracle" });

    const abortController = new AbortController();

    req.on("close", () => {
      if (res.writableEnded) {
        return;
      }

      clientClosed = true;
      abortController.abort();
    });

    const result = await streamOracleResponse({
      systemPrompt: buildOracleCopilotSystemPrompt(context),
      messages: toProviderMessages(pendingMessages),
      signal: abortController.signal,
      onText: (delta, snapshot) => {
        if (!clientClosed) {
          sendSseEvent(res, "delta", { text: delta, snapshot });
        }
      },
    });

    if (clientClosed) {
      logger.warn({ sessionId: session.id, userId: req.userId }, "Oracle stream aborted by client");
      return;
    }

    if (!result.text) {
      throw new Error("Oracle returned an empty response");
    }

    const assistantMessage: OracleStoredMessage = {
      role: "oracle",
      content: result.text,
      timestamp: new Date().toISOString(),
    };

    const persistedSession = await prisma.oracleSession.update({
      where: { id: session.id },
      data: {
        messages: [...pendingMessages, assistantMessage] as unknown as Prisma.InputJsonValue[],
        context: context as Prisma.InputJsonValue,
      },
    });

    logger.info(
      {
        userId: req.userId,
        sessionId: session.id,
        model: result.model,
        requestId: result.requestId,
      },
      "Oracle persistent response streamed",
    );

    sendSseEvent(res, "message", {
      message: assistantMessage,
      session: serializeOracleSession(persistedSession),
    });
    sendSseEvent(res, "done", { sessionId: session.id });
    res.end();
  } catch (err) {
    if (clientClosed) {
      logger.warn({ sessionId: body.sessionId, userId: req.userId }, "Oracle stream aborted by client");
      return;
    }

    logger.error({ error: err, userId: req.userId, sessionId: body.sessionId }, "Oracle persistent message error");

    if (!res.headersSent) {
      res.status(500).json(error("Oracle is thinking... try again in a moment."));
      return;
    }

    sendSseEvent(res, "error", { error: "Oracle is thinking... try again in a moment." });
    res.end();
  }
}

// ── Prompt Resolution ────────────────────────────────────────────

interface ResolvedPrompt {
  system: string;
  userMessage: string;
  taskType: string;
  maxTokens: number;
  temperature: number;
}

function resolvePrompt(
  action: string,
  step: string,
  ctx: z.infer<typeof legacyMessageSchema>["context"] & {},
): ResolvedPrompt | null {
  if (action === "scan-complete" && ctx.calibrationResult && ctx.dimensions) {
    const { system, userMessage } = buildCalibrationCommentary(
      ctx.dimensions,
      ctx.calibrationResult.tweetsAnalyzed,
      ctx.handle,
    );
    return { system, userMessage, taskType: "oracle_smart", maxTokens: 150, temperature: 0.8 };
  }

  if (action === "blend-preview" && ctx.dimensions && ctx.blendVoices) {
    const { system, userMessage } = buildBlendPreview(
      ctx.dimensions,
      ctx.blendVoices,
    );
    return { system, userMessage, taskType: "oracle_smart", maxTokens: 300, temperature: 0.7 };
  }

  if (action === "dims-continue" && ctx.dimensions) {
    const reaction = buildDimensionReaction(ctx.dimensions);
    if (reaction) {
      return {
        system: reaction.system,
        userMessage: reaction.userMessage,
        taskType: "oracle_fast",
        maxTokens: 80,
        temperature: 0.9,
      };
    }
  }

  if (ctx.freeText) {
    const { system, userMessage } = buildFreeTextResponse(ctx.freeText, {
      track: undefined,
      step,
      dimensions: ctx.dimensions,
    });
    return { system, userMessage, taskType: "oracle_fast", maxTokens: 100, temperature: 0.7 };
  }

  return null;
}

function initSse(res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
}

function sendSseEvent(res: Response, event: string, payload: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function toProviderMessages(messages: OracleStoredMessage[]): Message[] {
  return messages.slice(-20).map((message) => ({
    role: message.role === "oracle" ? "assistant" : "user",
    content: message.content,
  }));
}
