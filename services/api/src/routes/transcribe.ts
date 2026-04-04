import { Router } from "express";
import multer from "multer";
import OpenAI from "openai";
import { authenticate, AuthRequest } from "../middleware/auth";
import { logger } from "../lib/logger";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

let openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openai) openai = new OpenAI({ timeout: 30_000, maxRetries: 1 });
  return openai;
}

export const transcribeRouter = Router();
transcribeRouter.use(authenticate);

transcribeRouter.post("/", upload.single("audio"), async (req: AuthRequest, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file provided" });
    }

    const file = new File([req.file.buffer], req.file.originalname || "recording.webm", {
      type: req.file.mimetype || "audio/webm",
    });

    const result = await getOpenAI().audio.transcriptions.create({
      file,
      model: "whisper-1",
      language: "en",
    });

    logger.info({ userId: req.userId, chars: result.text.length }, "Voice transcription complete");

    res.json({ text: result.text });
  } catch (err: any) {
    logger.error({ err: err.message }, "Transcription failed");
    res.status(500).json({ error: "Transcription failed", message: err.message });
  }
});
