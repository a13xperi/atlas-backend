import { Router } from "express";
import multer from "multer";
import { z } from "zod";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require("pdf-parse") as (buffer: Buffer, options?: object) => Promise<{ text: string }>;
import { authenticate, AuthRequest } from "../middleware/auth";
import { buildErrorResponse } from "../middleware/requestId";
import { logger } from "../lib/logger";
import { success } from "../lib/response";
import { validationFailResponse } from "../lib/schemas";

// /extract-text only reads `req.file` (the uploaded PDF / text blob).
// Empty-strict body rejects unexpected form fields.
const extractTextBodySchema = z.object({}).strict();

export const uploadRouter = Router();
uploadRouter.use(authenticate);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_TEXT_CHARS = 50_000; // safe LLM context ceiling

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const allowed = ["application/pdf", "text/plain", "text/markdown", "text/x-markdown"];
    if (allowed.includes(file.mimetype) || file.originalname.endsWith(".md")) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported file type. Upload a PDF or plain-text file."));
    }
  },
});

// POST /api/upload/extract-text
// Accepts: multipart/form-data with field "file" (PDF, .txt, .md)
// Returns: { text, wordCount, filename, mimeType, truncated }
uploadRouter.post("/extract-text", upload.single("file"), async (req: AuthRequest, res) => {
  const parsed = extractTextBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(validationFailResponse(parsed.error));
  }
  try {
    if (!req.file) {
      return res.status(400).json(buildErrorResponse(req, "No file provided"));
    }

    const { buffer, originalname, mimetype } = req.file;
    let rawText = "";

    if (mimetype === "application/pdf") {
      const parsed = await pdfParse(buffer);
      rawText = parsed.text;
    } else {
      // plain text / markdown
      rawText = buffer.toString("utf-8");
    }

    // Normalise whitespace: collapse runs of 3+ newlines, trim
    const normalized = rawText
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const truncated = normalized.length > MAX_TEXT_CHARS;
    const text = truncated ? normalized.slice(0, MAX_TEXT_CHARS) : normalized;
    const wordCount = text.split(/\s+/).filter(Boolean).length;

    logger.info(
      { userId: req.userId, filename: originalname, chars: text.length, truncated },
      "File text extraction completed",
    );

    res.json(
      success({
        text,
        wordCount,
        filename: originalname,
        mimeType: mimetype,
        truncated,
      }),
    );
  } catch (err: any) {
    if (err.message?.includes("Unsupported file type")) {
      return res.status(415).json(buildErrorResponse(req, err.message));
    }
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json(buildErrorResponse(req, "File too large. Maximum size is 10 MB."));
    }
    logger.error({ err: err.message, userId: req.userId }, "File extraction failed");
    res.status(500).json(buildErrorResponse(req, "Text extraction failed"));
  }
});
