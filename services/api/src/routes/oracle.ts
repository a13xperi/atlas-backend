import { Prisma } from "@prisma/client";
import { Response, Router } from "express";
import { z } from "zod";
import { authenticate, AuthRequest } from "../middleware/auth";
import { rateLimitByUser } from "../middleware/rateLimit";
import { config } from "../lib/config";
import { getAnthropicClient } from "../lib/anthropic";
import {
  runOracleCompletion,
  resolveProfileForPhase,
} from "../lib/openclaw-router";
import { routeCompletion, streamCompletion } from "../lib/providers/router";
import {
  buildCalibrationCommentary,
  buildBlendPreview,
  buildDimensionReaction,
  buildFreeTextResponse,
  buildOracleSystemPrompt,
} from "../lib/oracle-prompt";
import { ORACLE_TOOLS, CONFIRMATION_REQUIRED, SERVER_EXECUTABLE } from "../lib/oracle-tools";
import { error, success } from "../lib/response";
import { validationFailResponse } from "../lib/schemas";
import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { withTimeout } from "../lib/timeout";
import type { ToolCall } from "../lib/providers/types";

export const oracleRouter = Router();
oracleRouter.use(authenticate);

// Oracle endpoints all hit Anthropic (and sometimes burn multiple
// turns per request via tool calling). They're the most expensive
// surface in the API, so they get the same per-user AI cost cap as
// drafts/research/transcribe/images/campaigns-pdf. Read endpoints
// (`GET /session`, `DELETE /session`) stay on the general limiter.
const aiGenerationLimiter = rateLimitByUser(
  config.RATE_LIMIT_AI_GENERATION_MAX_REQUESTS,
  config.RATE_LIMIT_AI_GENERATION_WINDOW_MS,
);

// ── Schema ───────────────────────────────────────────────────────

const oracleSessionMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  timestamp: z.string(),
});

const oracleSessionContextSchema = z.record(z.unknown());

const oracleSessionRequestSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  context: oracleSessionContextSchema.optional(),
});

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

type OracleSessionMessage = z.infer<typeof oracleSessionMessageSchema>;
type OracleSessionContext = z.infer<typeof oracleSessionContextSchema>;
type OraclePromptDimensions = Parameters<typeof buildCalibrationCommentary>[0];
type OracleBlendVoices = Parameters<typeof buildBlendPreview>[1];

function normalizeOracleSessionMessages(raw: unknown): OracleSessionMessage[] {
  const parsed = z.array(oracleSessionMessageSchema).safeParse(raw);
  return parsed.success ? parsed.data : [];
}

function normalizeOracleSessionContext(raw: unknown): OracleSessionContext | null {
  if (raw == null) {
    return null;
  }

  const parsed = oracleSessionContextSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function createOracleSessionMessage(
  role: OracleSessionMessage["role"],
  content: string,
): OracleSessionMessage {
  return {
    role,
    content,
    timestamp: new Date().toISOString(),
  };
}

async function getOrCreateOracleSession(userId: string) {
  const existingSession = await prisma.oracleSession.findFirst({
    where: { userId },
    orderBy: { updatedAt: "desc" },
  });

  if (existingSession) {
    return existingSession;
  }

  return prisma.oracleSession.create({
    data: {
      userId,
      messages: [] as Prisma.InputJsonArray,
    },
  });
}

function buildOracleSessionSystemPrompt(context: OracleSessionContext | null): string {
  const contextSuffix =
    context && Object.keys(context).length > 0
      ? `\n\nSession context:\n${JSON.stringify(context)}`
      : "";

  return (
    `${buildOracleSystemPrompt()}\n\n` +
    `You are in a persistent one-on-one chat with the authenticated Atlas user. ` +
    `Use the saved conversation state when it matters. Keep responses concise unless the user asks for detail.` +
    contextSuffix
  );
}

async function handleSessionMessage(req: AuthRequest, res: Response) {
  const body = oracleSessionRequestSchema.parse(req.body);
  const session = await getOrCreateOracleSession(req.userId!);
  const existingMessages = normalizeOracleSessionMessages(session.messages);
  const userMessage = createOracleSessionMessage("user", body.content);
  const messagesWithUser = [...existingMessages, userMessage];
  const nextContext = body.context ?? normalizeOracleSessionContext(session.context);

  await prisma.oracleSession.update({
    where: { id: session.id },
    data: {
      messages: messagesWithUser as Prisma.InputJsonArray,
      ...(body.context !== undefined
        ? { context: body.context as Prisma.InputJsonObject }
        : {}),
    },
  });

  try {
    const client = getAnthropicClient();
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 800,
      system: buildOracleSessionSystemPrompt(nextContext),
      messages: messagesWithUser.slice(-20).map((message) => ({
        role: message.role,
        content: message.content,
      })),
    });

    const text = response.content.reduce((combinedText, block) => {
      if (block.type !== "text") {
        return combinedText;
      }

      return combinedText ? `${combinedText}\n${block.text}` : block.text;
    }, "").trim();

    if (!text) {
      throw new Error("Empty response from Claude");
    }

    const assistantMessage = createOracleSessionMessage("assistant", text);
    const persistedMessages = [...messagesWithUser, assistantMessage];

    const updatedSession = await prisma.oracleSession.update({
      where: { id: session.id },
      data: {
        messages: persistedMessages as Prisma.InputJsonArray,
        ...(body.context !== undefined
          ? { context: body.context as Prisma.InputJsonObject }
          : {}),
      },
    });

    res.json(
      success({
        sessionId: updatedSession.id,
        reply: assistantMessage,
        messages: normalizeOracleSessionMessages(updatedSession.messages),
        context: normalizeOracleSessionContext(updatedSession.context),
      }),
    );
  } catch (err) {
    logger.error({ error: err }, "Oracle session message error");
    res.status(502).json(error("Oracle response failed", 502));
  }
}

// ── Route ────────────────────────────────────────────────────────

oracleRouter.get("/session", async (req: AuthRequest, res) => {
  try {
    const session = await getOrCreateOracleSession(req.userId!);

    res.json(
      success({
        sessionId: session.id,
        messages: normalizeOracleSessionMessages(session.messages),
        context: normalizeOracleSessionContext(session.context),
      }),
    );
  } catch (err) {
    logger.error({ error: err }, "Oracle session load error");
    res.status(500).json(error("Failed to load oracle session", 500));
  }
});

oracleRouter.delete("/session", async (req: AuthRequest, res) => {
  try {
    const session = await getOrCreateOracleSession(req.userId!);
    const clearedSession = await prisma.oracleSession.update({
      where: { id: session.id },
      data: {
        messages: [] as Prisma.InputJsonArray,
      },
    });

    res.json(
      success({
        sessionId: clearedSession.id,
        messages: normalizeOracleSessionMessages(clearedSession.messages),
        context: normalizeOracleSessionContext(clearedSession.context),
      }),
    );
  } catch (err) {
    logger.error({ error: err }, "Oracle session clear error");
    res.status(500).json(error("Failed to clear oracle session", 500));
  }
});

oracleRouter.post("/message", aiGenerationLimiter, async (req: AuthRequest, res) => {
  try {
    if (
      typeof req.body === "object" &&
      req.body !== null &&
      "content" in req.body
    ) {
      await handleSessionMessage(req, res);
      return;
    }

    const body = legacyMessageSchema.parse(req.body);
    const ctx = body.context ?? {};

    let messages: Array<{ content: string; role: "oracle" }> = [];
    let llmGenerated = false;

    // Determine if this step needs LLM
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
          8_000, // 8s timeout — never block onboarding
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
          "Oracle LLM response generated",
        );
      } catch (err) {
        // LLM failure is non-fatal — return empty so client uses scripted messages
        logger.warn(
          { error: err instanceof Error ? err.message : String(err), step: body.step },
          "Oracle LLM call failed, falling back to scripted",
        );
      }
    }

    // Log analytics event (fire and forget)
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
      .catch((e) => logger.warn({ error: e }, "Failed to log oracle analytics"));

    res.json(success({ messages, llmGenerated }));
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json(error("Invalid request", 400, err.errors));
      return;
    }
    logger.error({ error: err }, "Oracle message error");
    res.status(500).json(error("Internal server error", 500));
  }
});

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
  const parsedDimensions = ctx.dimensions as OraclePromptDimensions | undefined;

  // Calibration commentary — after voice scan completes
  if (
    action === "scan-complete" &&
    ctx.calibrationResult &&
    parsedDimensions
  ) {
    const { system, userMessage } = buildCalibrationCommentary(
      parsedDimensions,
      ctx.calibrationResult.tweetsAnalyzed,
      ctx.handle,
    );
    return { system, userMessage, taskType: "oracle_smart", maxTokens: 150, temperature: 0.8 };
  }

  // Blend preview tweet
  if (action === "blend-preview" && parsedDimensions && ctx.blendVoices) {
    const { system, userMessage } = buildBlendPreview(
      parsedDimensions,
      ctx.blendVoices as OracleBlendVoices,
    );
    return { system, userMessage, taskType: "oracle_smart", maxTokens: 300, temperature: 0.7 };
  }

  // Dimension reaction for unusual combos
  if (action === "dims-continue" && parsedDimensions) {
    const reaction = buildDimensionReaction(parsedDimensions);
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

  // Free-text response
  if (ctx.freeText) {
    const { system, userMessage } = buildFreeTextResponse(ctx.freeText, {
      track: undefined, // will be set from body.track in a future pass
      step,
      dimensions: parsedDimensions,
    });
    return { system, userMessage, taskType: "oracle_fast", maxTokens: 100, temperature: 0.7 };
  }

  // No LLM needed — client handles scripted messages
  return null;
}

// ── General Chat ────────────────────────────────────────────────

// Legacy shape — used by the floating widget / crafting advisor:
//   { messages: [{ role, content }], page?: string }
// Response: { text }
const chatLegacySchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "oracle"]), content: z.string().max(2000) }))
    .min(1)
    .max(20),
  page: z.string().optional(),
});

// New OpenClaw-routed shape:
//   { message: string, userId?: string, context?: object, phase?: string }
// Response: { reply, model, tokens }
const chatOpenClawSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  userId: z.string().optional(),
  context: z.record(z.unknown()).optional(),
  phase: z.string().max(64).optional(),
});

// Top-level dispatch schema for POST /chat — the handler accepts either
// the new OpenClaw shape OR the legacy widget shape. This lets the router
// safeParse once at the top of the handler (per Atlas BO 30 contract) and
// still delegate to the existing shape-specific sub-handlers for the
// actual work.
const chatDispatchSchema = z.union([chatOpenClawSchema, chatLegacySchema]);

/**
 * Build personalized context (voice profile + recent activity) for the
 * Oracle. Mirrors how other routes build context — safe to call per request.
 */
async function buildOracleUserContext(userId: string): Promise<{
  voiceHint: string;
  activityHint: string;
}> {
  let voiceHint = "";
  let activityHint = "";

  try {
    const profile = await prisma.voiceProfile.findUnique({ where: { userId } });
    if (profile) {
      voiceHint =
        `\nVoice: Humor ${profile.humor}/100, Formality ${profile.formality}/100, ` +
        `Brevity ${profile.brevity}/100, Contrarian ${profile.contrarianTone}/100.`;
    }
  } catch {
    /* non-fatal */
  }

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
    const [draftsRecent, postsRecent] = await Promise.all([
      prisma.tweetDraft.count({
        where: { userId, createdAt: { gte: sevenDaysAgo } },
      }),
      prisma.tweetDraft.count({
        where: { userId, status: "POSTED", updatedAt: { gte: sevenDaysAgo } },
      }),
    ]);
    if (draftsRecent > 0 || postsRecent > 0) {
      activityHint = `\nLast 7 days: ${draftsRecent} drafts created, ${postsRecent} posted.`;
    }
  } catch {
    /* non-fatal */
  }

  return { voiceHint, activityHint };
}

/** New OpenClaw-routed handler — { reply, model, tokens } */
async function handleOpenClawChat(req: AuthRequest, res: Response) {
  const body = chatOpenClawSchema.parse(req.body);
  const userId = req.userId!;
  const profile = resolveProfileForPhase(body.phase);
  const { voiceHint, activityHint } = await buildOracleUserContext(userId);

  const contextSuffix =
    body.context && Object.keys(body.context).length > 0
      ? `\n\nSession context:\n${JSON.stringify(body.context).slice(0, 1500)}`
      : "";
  const phaseLine = body.phase ? `\nCurrent phase: ${body.phase}.` : "";

  const systemPrompt =
    buildOracleSystemPrompt() +
    `\n\nYou are in a chat with the authenticated Atlas user.` +
    phaseLine +
    voiceHint +
    activityHint +
    `\n\nKeep responses concise unless the user asks for detail.` +
    contextSuffix;

  try {
    const result = await runOracleCompletion({
      profile,
      systemPrompt,
      userMessage: body.message,
      label: "oracle-chat-openclaw",
    });

    logger.info(
      {
        profile,
        provider: result.provider,
        model: result.model,
        latencyMs: result.latencyMs,
        tokens: result.tokens,
        phase: body.phase,
      },
      "Oracle OpenClaw chat response",
    );

    res.json(
      success({
        reply: result.reply,
        model: result.model,
        tokens: result.tokens,
      }),
    );
  } catch (err) {
    logger.error({ error: err }, "Oracle OpenClaw chat error");
    res.status(502).json(error("Oracle response failed", 502));
  }
}

/** Legacy handler — preserves { text } response shape for existing callers. */
async function handleLegacyChat(req: AuthRequest, res: Response) {
  const body = chatLegacySchema.parse(req.body);

  const pageHint = body.page ? `\nThe user is on the ${body.page} page.` : "";

  let voiceHint = "";
  try {
    const profile = await prisma.voiceProfile.findUnique({ where: { userId: req.userId! } });
    if (profile) {
      voiceHint = `\nVoice: Humor ${profile.humor}/100, Formality ${profile.formality}/100, Brevity ${profile.brevity}/100, Contrarian ${profile.contrarianTone}/100.`;
    }
  } catch {}

  const systemPrompt =
    buildOracleSystemPrompt() +
    `\n\nYou are in the floating chat widget inside Atlas.` +
    pageHint + voiceHint +
    `\n\nKeep responses under 50 words. Be helpful and personalized.`;

  const llmMessages = [
    { role: "system" as const, content: systemPrompt },
    ...body.messages.map((m) => ({
      role: (m.role === "oracle" ? "assistant" : "user") as "system" | "user" | "assistant",
      content: m.content,
    })),
  ];

  const response = await withTimeout(
    routeCompletion({ taskType: "oracle_fast", maxTokens: 150, temperature: 0.7, messages: llmMessages }),
    8_000,
    "oracle-chat",
  );

  logger.info({ provider: response.provider, latencyMs: response.latencyMs, page: body.page }, "Oracle chat response");
  res.json(success({ text: response.content.trim() }));
}

oracleRouter.post("/chat", aiGenerationLimiter, async (req: AuthRequest, res) => {
  // Validate against the union schema at the top of the handler. This
  // catches malformed bodies before dispatch and keeps the handler
  // consistent with the Atlas BO 30 safeParse-at-top convention.
  const parsed = chatDispatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(validationFailResponse(parsed.error));
  }

  try {
    // Discriminate by body shape — the new OpenClaw route uses `message`
    // (singular string); the legacy widget path uses `messages` (array).
    // Sub-handlers re-parse with their narrow schema for type safety,
    // which is a trivial cost (microseconds) relative to the downstream
    // LLM call.
    if (
      typeof req.body === "object" &&
      req.body !== null &&
      typeof (req.body as { message?: unknown }).message === "string"
    ) {
      await handleOpenClawChat(req, res);
      return;
    }

    await handleLegacyChat(req, res);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ ok: false, error: "Invalid request", details: err.errors });
      return;
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    const isProviderIssue = errMsg.includes("No providers available") || errMsg.includes("All providers failed");
    logger.error({ error: err, isProviderIssue }, "Oracle chat error");
    res.status(isProviderIssue ? 503 : 500).json({
      ok: false,
      error: isProviderIssue
        ? "Oracle is temporarily unavailable — no AI providers could be reached. Please try again shortly."
        : "Oracle encountered an unexpected error. Please try again.",
      code: isProviderIssue ? "PROVIDER_UNAVAILABLE" : "INTERNAL_ERROR",
    });
  }
});

oracleRouter.post("/chat/stream", aiGenerationLimiter, async (req: AuthRequest, res) => {
  const parsed = chatLegacySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(validationFailResponse(parsed.error));
  }

  try {
    const body = chatLegacySchema.parse(req.body);

    const pageHint = body.page ? `\nThe user is on the ${body.page} page.` : "";

    let voiceHint = "";
    try {
      const profile = await prisma.voiceProfile.findUnique({ where: { userId: req.userId! } });
      if (profile) {
        voiceHint = `\nVoice: Humor ${profile.humor}/100, Formality ${profile.formality}/100, Brevity ${profile.brevity}/100, Contrarian ${profile.contrarianTone}/100.`;
      }
    } catch {}

    const systemPrompt =
      buildOracleSystemPrompt() +
      `\n\nYou are in the floating chat widget inside Atlas.` +
      pageHint + voiceHint +
      `\n\nKeep responses under 50 words. Be helpful and personalized.`;

    const llmMessages = [
      { role: "system" as const, content: systemPrompt },
      ...body.messages.map((m) => ({
        role: (m.role === "oracle" ? "assistant" : "user") as "system" | "user" | "assistant",
        content: m.content,
      })),
    ];

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    for await (const chunk of streamCompletion({ taskType: "oracle_fast", maxTokens: 150, temperature: 0.7, messages: llmMessages })) {
      res.write("data: " + JSON.stringify({ delta: chunk }) + "\n\n");
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ ok: false, error: "Invalid request", details: err.errors });
      return;
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    const isProviderIssue = errMsg.includes("No providers available") || errMsg.includes("All providers failed");
    logger.error({ error: err, isProviderIssue }, "Oracle chat stream error");
    res.status(isProviderIssue ? 503 : 500).json({
      ok: false,
      error: isProviderIssue
        ? "Oracle is temporarily unavailable — no AI providers could be reached. Please try again shortly."
        : "Oracle encountered an unexpected error. Please try again.",
      code: isProviderIssue ? "PROVIDER_UNAVAILABLE" : "INTERNAL_ERROR",
    });
  }
});

// ── Agent Mode ─────────────────────────────────��───────────────

const agentSchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "oracle"]), content: z.string().max(4000) }))
    .min(1)
    .max(30),
  page: z.string().optional(),
  actionResults: z
    .array(
      z.object({
        actionId: z.string(),
        type: z.string(),
        success: z.boolean(),
        data: z.unknown().optional(),
        error: z.string().optional(),
      }),
    )
    .optional(),
});

interface OracleAgentAction {
  id: string;
  type: string;
  input: Record<string, unknown>;
  requiresConfirmation: boolean;
  label: string;
}

function buildAgentSystemPrompt(pageHint: string, voiceHint: string): string {
  return `${buildOracleSystemPrompt()}

You are now in Agent mode inside the Atlas floating chat widget.
You can execute actions on behalf of the user using the tools provided.
${pageHint}${voiceHint}

Rules:
- Use tools when the user asks you to DO something, not just answer questions.
- For read-only tools (analytics, voice profile, signals, drafts list), just use them.
- For write actions (generating drafts, posting), explain what you'll do.
- You can use multiple tools in one response if needed.
- After tool use, summarize what happened in 1-2 sentences in your Oracle voice.
- If you're unsure what the user wants, ask — don't guess.
- Keep text responses under 60 words.
- Never use bullet points. Speak in natural sentences.`;
}

function toolCallToAction(call: ToolCall): OracleAgentAction {
  const input = call.input as Record<string, unknown>;
  const needsConfirm = CONFIRMATION_REQUIRED.has(call.name);

  // Generate a human-readable label
  const labels: Record<string, (i: Record<string, unknown>) => string> = {
    navigate: (i) => `Go to ${i.page}`,
    generate_draft: (i) => `Draft tweet about "${String(i.sourceContent ?? "").slice(0, 40)}..."`,
    list_drafts: () => "List your drafts",
    get_voice_profile: () => "Check your voice profile",
    get_analytics_summary: () => "Get your analytics",
    get_trending: () => "Check trending topics",
    get_signals: () => "Check your signals",
    refine_draft: (i) => `Refine draft: "${String(i.instruction ?? "").slice(0, 40)}"`,
    post_draft: () => "Post draft to X",
    schedule_draft: (i) => `Schedule draft for ${String(i.scheduledAt ?? "").slice(0, 10)}`,
    calibrate_voice: (i) => `Calibrate voice from @${i.handle}`,
    update_voice_dimension: () => "Update voice dimensions",
    subscribe_signal: (i) => `Subscribe to ${i.value} signals`,
    conduct_research: (i) => `Research "${String(i.query ?? "").slice(0, 40)}"`,
  };

  const labelFn = labels[call.name];
  const label = labelFn ? labelFn(input) : call.name;

  return {
    id: call.id,
    type: call.name,
    input,
    requiresConfirmation: needsConfirm,
    label,
  };
}

/** Execute a server-safe tool and return the result data. */
async function executeServerSide(
  call: ToolCall,
  userId: string,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  try {
    switch (call.name) {
      case "get_voice_profile": {
        const profile = await prisma.voiceProfile.findUnique({ where: { userId } });
        const blends = await prisma.savedBlend.findMany({
          where: { userId },
          include: { voices: true },
          orderBy: { createdAt: "desc" },
          take: 10,
        });
        return { success: true, data: { profile, blends } };
      }
      case "get_analytics_summary": {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
        const [drafts, posts, events] = await Promise.all([
          prisma.tweetDraft.count({ where: { userId, createdAt: { gte: thirtyDaysAgo } } }),
          prisma.tweetDraft.count({ where: { userId, status: "POSTED", updatedAt: { gte: thirtyDaysAgo } } }),
          prisma.analyticsEvent.count({ where: { userId, createdAt: { gte: thirtyDaysAgo } } }),
        ]);
        return { success: true, data: { draftsCreated: drafts, postsPublished: posts, totalEvents: events, period: "30d" } };
      }
      case "list_drafts": {
        const status = (call.input as Record<string, unknown>).status as string | undefined;
        const drafts = await prisma.tweetDraft.findMany({
          where: { userId, ...(status && { status: status as never }) },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: { id: true, content: true, status: true, createdAt: true, sourceType: true },
        });
        return { success: true, data: { drafts, count: drafts.length } };
      }
      case "get_signals": {
        const category = (call.input as Record<string, unknown>).category as string | undefined;
        const alerts = await prisma.alert.findMany({
          where: { userId, ...(category && { category: category as never }) },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: { id: true, title: true, category: true, createdAt: true },
        });
        return { success: true, data: { signals: alerts, count: alerts.length } };
      }
      case "get_trending": {
        // Trending requires external API call — delegate to frontend
        return { success: false, error: "Trending requires frontend execution" };
      }
      case "conduct_research": {
        // Research requires LLM call — delegate to frontend for now
        return { success: false, error: "Research requires frontend execution" };
      }
      case "refine_draft": {
        const draftId = (call.input as Record<string, unknown>).draftId as string;
        const instruction = (call.input as Record<string, unknown>).instruction as string;
        if (!draftId || !instruction) return { success: false, error: "Missing draftId or instruction" };
        const draft = await prisma.tweetDraft.findFirst({ where: { id: draftId, userId } });
        if (!draft) return { success: false, error: "Draft not found" };
        // Use the provider to refine
        const refinedResponse = await routeCompletion({
          taskType: "tweet_generation",
          maxTokens: 500,
          temperature: 0.7,
          messages: [
            { role: "system", content: "You are a tweet writer. Refine the following tweet based on the instruction. Return ONLY the refined tweet text, nothing else." },
            { role: "user", content: `Original tweet: "${draft.content}"\nInstruction: ${instruction}` },
          ],
        });
        const refined = await prisma.tweetDraft.update({
          where: { id: draftId },
          data: { content: refinedResponse.content.trim() },
          select: { id: true, content: true, status: true },
        });
        return { success: true, data: refined };
      }
      default:
        return { success: false, error: `Unknown server-side tool: ${call.name}` };
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

oracleRouter.post("/agent", aiGenerationLimiter, async (req: AuthRequest, res) => {
  try {
    const body = agentSchema.parse(req.body);

    const pageHint = body.page ? `\nThe user is on the ${body.page} page.` : "";

    let voiceHint = "";
    try {
      const profile = await prisma.voiceProfile.findUnique({ where: { userId: req.userId! } });
      if (profile) {
        voiceHint = `\nVoice: Humor ${profile.humor}/100, Formality ${profile.formality}/100, Brevity ${profile.brevity}/100, Contrarian ${profile.contrarianTone}/100.`;
      }
    } catch {}

    const systemPrompt = buildAgentSystemPrompt(pageHint, voiceHint);

    // Build LLM messages
    const llmMessages = [
      { role: "system" as const, content: systemPrompt },
      ...body.messages.map((m) => ({
        role: (m.role === "oracle" ? "assistant" : "user") as "system" | "user" | "assistant",
        content: m.content,
      })),
    ];

    // If we have action results from a previous round, inject them
    if (body.actionResults?.length) {
      const resultSummary = body.actionResults
        .map((r) => `Tool ${r.type}: ${r.success ? "succeeded" : "failed"}${r.data ? ` — ${JSON.stringify(r.data).slice(0, 500)}` : ""}${r.error ? ` — error: ${r.error}` : ""}`)
        .join("\n");
      llmMessages.push({
        role: "user" as const,
        content: `[Action results]\n${resultSummary}`,
      });
    }

    const response = await withTimeout(
      routeCompletion({
        taskType: "oracle_agent",
        maxTokens: 1024,
        temperature: 0.7,
        messages: llmMessages,
        tools: ORACLE_TOOLS,
        tool_choice: { type: "auto" },
      }),
      15_000,
      "oracle-agent",
    );

    // Convert tool calls to structured actions
    const toolCalls = response.toolCalls ?? [];
    const actions: OracleAgentAction[] = [];
    const serverResults: Array<{ toolCallId: string; result: unknown }> = [];

    for (const call of toolCalls) {
      if (SERVER_EXECUTABLE.has(call.name)) {
        // Execute read-only tools server-side
        const result = await executeServerSide(call, req.userId!);
        if (result.success) {
          serverResults.push({ toolCallId: call.id, result: result.data });
          // Still include in actions so frontend knows what happened
          actions.push({ ...toolCallToAction(call), input: { ...call.input, _serverResult: result.data } });
        } else {
          // Couldn't execute server-side, pass to frontend
          actions.push(toolCallToAction(call));
        }
      } else {
        actions.push(toolCallToAction(call));
      }
    }

    logger.info(
      {
        provider: response.provider,
        model: response.model,
        latencyMs: response.latencyMs,
        page: body.page,
        toolCalls: toolCalls.length,
        serverExecuted: serverResults.length,
      },
      "Oracle agent response",
    );

    res.json(
      success({
        text: response.content.trim(),
        actions,
        serverResults,
      }),
    );
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ ok: false, error: "Invalid request", details: err.errors });
      return;
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    const isProviderIssue = errMsg.includes("No providers available") || errMsg.includes("All providers failed");
    logger.error({ error: err, isProviderIssue }, "Oracle agent error");
    res.status(isProviderIssue ? 503 : 500).json({
      ok: false,
      error: isProviderIssue
        ? "Oracle is temporarily unavailable — no AI providers could be reached. Please try again shortly."
        : "Oracle encountered an unexpected error. Please try again.",
      code: isProviderIssue ? "PROVIDER_UNAVAILABLE" : "INTERNAL_ERROR",
    });
  }
});
