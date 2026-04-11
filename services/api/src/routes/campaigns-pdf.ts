import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { authenticate, AuthRequest } from "../middleware/auth";
import { logger } from "../lib/logger";
import { success, error } from "../lib/response";
import { extractInsights } from "../lib/content-extraction";
import { batchGenerateDrafts } from "../lib/batch-generate";
import {
  extractTextFromUploadedFile,
  MAX_UPLOAD_FILE_SIZE,
} from "../lib/file-extract";

/**
 * Campaign-from-PDF router.
 *
 * Lives in its own file so we can ship the v1.1 flagship flow without
 * touching routes/campaigns.ts — which is under active concurrent edit
 * from two sibling sessions right now (session-lock conflict). Mounting
 * this router at `/api/campaigns` in index.ts is what stitches the new
 * endpoint into the URL namespace alongside the existing routes.
 *
 * The URL is `POST /api/campaigns/generate-from-pdf`.
 */
export const campaignsPdfRouter = Router();
campaignsPdfRouter.use(authenticate);

// Multipart body coerces everything to strings, so validate accordingly and
// coerce after. The file itself is handled by multer and isn't in req.body.
const generateFromPdfSchema = z.object({
  angles: z.coerce.number().int().min(1).max(10).optional(),
  tone: z.string().min(1).max(50).optional(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
});

// Mirror the rules enforced by /api/upload/extract-text so the two
// endpoints are indistinguishable from a client's POV.
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const allowed = ["application/pdf", "text/plain", "text/markdown", "text/x-markdown"];
    if (allowed.includes(file.mimetype) || file.originalname.endsWith(".md")) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported file type. Upload a PDF or plain-text file."));
    }
  },
});

// POST /api/campaigns/generate-from-pdf
//
// The v1.1 flagship workflow — one round-trip from raw report to a
// campaign-backed batch of angled drafts:
//
//   1. Client POSTs multipart/form-data: file=<pdf|txt|md>, optional
//      { angles, tone, name, description } fields.
//   2. Server extracts text via the shared helper, normalises + truncates.
//   3. `extractInsights` distills the source into a ranked list of angles.
//   4. `batchGenerateDrafts` runs each angle through the generation pipeline
//      and attaches the drafts to a fresh campaign.
//   5. Response mirrors POST /api/campaigns/generate: { campaignId, drafts }.
//
// Prerequisites already live in main:
//   - `/api/upload/extract-text` speaks this file-format matrix
//   - `POST /api/campaigns/generate` already owns the insight → batch-draft
//     pipeline for stored content
// This route is the bridge so a client doesn't need to stage intermediate
// content to call those two separately.
campaignsPdfRouter.post("/generate-from-pdf", pdfUpload.single("file"), async (req: AuthRequest, res) => {
  try {
    if (!req.file) {
      return res.status(400).json(error("No file provided", 400));
    }

    const body = generateFromPdfSchema.parse(req.body ?? {});
    const angles = body.angles ?? 5;
    const tone = body.tone ?? "professional";

    const { originalname, mimetype } = req.file;
    const { text, wordCount, truncated } = await extractTextFromUploadedFile(req.file);

    // `extractInsights` itself enforces a 50-char minimum, but catching it
    // here as a 422 gives the client a clearer message than the downstream
    // "Failed to generate any drafts" error.
    if (text.trim().length < 50) {
      return res
        .status(422)
        .json(error("Uploaded file has too little text to generate a campaign", 422));
    }

    const insights = await extractInsights(text, { limit: angles });
    const campaignTitle = body.name?.trim() || `${originalname} Campaign`;
    const campaignDescription =
      body.description?.trim() ||
      `Generated from ${originalname} using a ${tone} tone (${wordCount} words${truncated ? ", truncated" : ""}).`;

    const result = await batchGenerateDrafts({
      userId: req.userId!,
      insights,
      sourceContent: text,
      sourceType: "REPORT",
      tone,
      createCampaign: true,
      campaignTitle,
      campaignDescription,
    });

    if (!result.campaign) {
      throw new Error("Campaign creation failed");
    }

    logger.info(
      {
        userId: req.userId,
        filename: originalname,
        mimeType: mimetype,
        chars: text.length,
        angles,
        draftCount: result.drafts.length,
        campaignId: result.campaign.id,
      },
      "Campaign generated from uploaded file",
    );

    res.status(201).json(
      success({
        campaignId: result.campaign.id,
        filename: originalname,
        mimeType: mimetype,
        wordCount,
        truncated,
        drafts: result.drafts.map((draft) => ({
          id: draft.id,
          content: draft.content,
          angle: draft.angle,
          score: draft.score,
        })),
      }),
    );
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    if (err.message?.includes("Unsupported file type")) {
      return res.status(415).json(error(err.message, 415));
    }
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json(error("File too large. Maximum size is 10 MB.", 413));
    }
    if (err.message?.includes("Content too short")) {
      return res.status(422).json(error(err.message, 422));
    }
    if (err.message?.includes("Voice profile not found")) {
      return res.status(400).json(error(err.message, 400));
    }
    if (err.message?.includes("Failed to generate any drafts")) {
      return res.status(502).json(error(err.message, 502));
    }
    logger.error({ err: err.message, userId: req.userId }, "Failed to generate campaign from PDF");
    res.status(502).json(error("Failed to generate campaign from PDF", 502));
  }
});
