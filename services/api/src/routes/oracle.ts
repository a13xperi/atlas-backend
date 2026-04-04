import { Router } from "express";
import { z } from "zod";
import { authenticate, AuthRequest } from "../middleware/auth";
import { routeCompletion } from "../lib/providers/router";
import {
  buildCalibrationCommentary,
  buildBlendPreview,
  buildDimensionReaction,
  buildFreeTextResponse,
} from "../lib/oracle-prompt";
import { success } from "../lib/response";
import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { withTimeout } from "../lib/timeout";

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

const messageSchema = z.object({
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

// ── Route ────────────────────────────────────────────────────────

oracleRouter.post("/message", async (req: AuthRequest, res) => {
  try {
    const body = messageSchema.parse(req.body);
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
      res.status(400).json({ ok: false, error: "Invalid request", details: err.errors });
      return;
    }
    logger.error({ error: err }, "Oracle message error");
    res.status(500).json({ ok: false, error: "Internal server error" });
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
  ctx: z.infer<typeof messageSchema>["context"] & {},
): ResolvedPrompt | null {
  // Calibration commentary — after voice scan completes
  if (
    action === "scan-complete" &&
    ctx.calibrationResult &&
    ctx.dimensions
  ) {
    const { system, userMessage } = buildCalibrationCommentary(
      ctx.dimensions,
      ctx.calibrationResult.tweetsAnalyzed,
      ctx.handle,
    );
    return { system, userMessage, taskType: "oracle_smart", maxTokens: 150, temperature: 0.8 };
  }

  // Blend preview tweet
  if (action === "blend-preview" && ctx.dimensions && ctx.blendVoices) {
    const { system, userMessage } = buildBlendPreview(
      ctx.dimensions,
      ctx.blendVoices,
    );
    return { system, userMessage, taskType: "oracle_smart", maxTokens: 300, temperature: 0.7 };
  }

  // Dimension reaction for unusual combos
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

  // Free-text response
  if (ctx.freeText) {
    const { system, userMessage } = buildFreeTextResponse(ctx.freeText, {
      track: undefined, // will be set from body.track in a future pass
      step,
      dimensions: ctx.dimensions,
    });
    return { system, userMessage, taskType: "oracle_fast", maxTokens: 100, temperature: 0.7 };
  }

  // No LLM needed — client handles scripted messages
  return null;
}
