import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import OpenAI from "openai";
import { authenticate, AuthRequest } from "../middleware/auth";
import { rateLimitByUser } from "../middleware/rateLimit";
import { buildErrorResponse } from "../middleware/requestId";
import { logger } from "../lib/logger";
import { config } from "../lib/config";
import { success } from "../lib/response";
import { validationFailResponse } from "../lib/schemas";

// Transcription only reads `req.file` from multer; the body itself is
// expected to be empty. `.strict()` rejects any unexpected form field so
// a typo-drift client can't silently bypass validation.
const transcribeBodySchema = z.object({}).strict();

export const transcribeRouter = Router();
transcribeRouter.use(authenticate);

// Whisper transcription is paid per-minute of audio and runs unbounded
// until the file size limit kicks in. Cap it on the same per-user knob
// as the other AI cost paths (drafts/research/oracle/images/campaigns-pdf)
// so a single demo account can't burn through the OpenAI quota.
const aiGenerationLimiter = rateLimitByUser(
  config.RATE_LIMIT_AI_GENERATION_MAX_REQUESTS,
  config.RATE_LIMIT_AI_GENERATION_WINDOW_MS,
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB (Whisper limit)
});

// Rate-limit BEFORE multer so we don't waste the multipart parse on
// requests we're going to reject anyway.
transcribeRouter.post("/", aiGenerationLimiter, upload.single("audio"), async (req: AuthRequest, res) => {
  // Multer exposes form fields on `req.body`, so we validate *after*
  // multer has run. The schema is empty-strict — only the file on
  // `req.file` is part of the contract.
  const parsed = transcribeBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(validationFailResponse(parsed.error));
  }
  try {
    if (!req.file) {
      return res.status(400).json(buildErrorResponse(req, "No audio file provided"));
    }

    if (!config.OPENAI_API_KEY) {
      return res.status(503).json(buildErrorResponse(req, "Transcription service not configured"));
    }

    const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

    const file = new File([req.file.buffer], req.file.originalname || "recording.webm", {
      type: req.file.mimetype || "audio/webm",
    });

    const transcription = await openai.audio.transcriptions.create({
      file,
      model: "whisper-1",
      language: "en",
    });

    logger.info({ userId: req.userId, chars: transcription.text.length }, "Voice transcription completed");

    res.json(success({ text: transcription.text }));
  } catch (err: any) {
    logger.error({ err: err.message, userId: req.userId }, "Transcription failed");
    res.status(500).json(buildErrorResponse(req, "Transcription failed"));
  }
});
