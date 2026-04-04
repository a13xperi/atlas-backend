import { Router } from "express";
import multer from "multer";
import OpenAI from "openai";
import { authenticate, AuthRequest } from "../middleware/auth";
import { buildErrorResponse } from "../middleware/requestId";
import { logger } from "../lib/logger";
import { config } from "../lib/config";
import { success } from "../lib/response";

export const transcribeRouter = Router();
transcribeRouter.use(authenticate);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB (Whisper limit)
});

transcribeRouter.post("/", upload.single("audio"), async (req: AuthRequest, res) => {
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
