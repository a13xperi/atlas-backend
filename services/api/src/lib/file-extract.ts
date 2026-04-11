// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require("pdf-parse") as (buffer: Buffer, options?: object) => Promise<{ text: string }>;

/**
 * Shared file-to-text extraction helper.
 *
 * Two endpoints care about this — the standalone `POST /api/upload/extract-text`
 * and the campaign-level `POST /api/campaigns/generate-from-pdf`. Both need
 * identical PDF/plain-text handling, whitespace normalisation, and an LLM
 * context ceiling, so the logic lives here and the routes stay thin.
 */

export const MAX_UPLOAD_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Upper bound for text handed to downstream LLM calls. Keeps prompt cost
 * predictable and bounds the work done per request. If we ever need a
 * different ceiling for a specific caller we can pass an override.
 */
export const MAX_EXTRACT_TEXT_CHARS = 50_000;

export const SUPPORTED_UPLOAD_MIME_TYPES = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/x-markdown",
] as const;

export type SupportedUploadMimeType = (typeof SUPPORTED_UPLOAD_MIME_TYPES)[number];

export interface ExtractedText {
  text: string;
  wordCount: number;
  truncated: boolean;
}

export interface UploadedFileLike {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

/**
 * Normalise extracted text:
 *   - collapse CRLF to LF
 *   - collapse runs of 3+ newlines to a double newline
 *   - trim leading/trailing whitespace
 *
 * Separate from the I/O so tests can exercise it without a buffer round-trip.
 */
export function normalizeExtractedText(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Count words in already-normalised text. Matches the previous inline
 * `split(/\s+/).filter(Boolean).length` semantics so analytics stays stable.
 */
export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Parse the buffer for a PDF/text/markdown upload and return the normalised
 * text plus metadata. Throws on an unsupported mimetype so the route can map
 * the error to a 415 response via the existing multer fileFilter flow — but
 * it's also safe to call this helper directly; the error message pattern
 * `"Unsupported file type"` is what the upload route already matches on.
 */
export async function extractTextFromUploadedFile(
  file: UploadedFileLike,
  options: { maxChars?: number } = {},
): Promise<ExtractedText> {
  const maxChars = options.maxChars ?? MAX_EXTRACT_TEXT_CHARS;
  const { buffer, mimetype, originalname } = file;

  let rawText: string;

  if (mimetype === "application/pdf") {
    const parsed = await pdfParse(buffer);
    rawText = parsed.text ?? "";
  } else if (
    mimetype === "text/plain" ||
    mimetype === "text/markdown" ||
    mimetype === "text/x-markdown" ||
    originalname.endsWith(".md")
  ) {
    rawText = buffer.toString("utf-8");
  } else {
    throw new Error(`Unsupported file type: ${mimetype}`);
  }

  const normalized = normalizeExtractedText(rawText);
  const truncated = normalized.length > maxChars;
  const text = truncated ? normalized.slice(0, maxChars) : normalized;
  const wordCount = countWords(text);

  return { text, wordCount, truncated };
}
