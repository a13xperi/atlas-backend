/**
 * Upload route test suite
 * Tests POST /api/upload/extract-text
 * Mocks: auth middleware, pdf-parse, logger
 */

import request from "supertest";
import express from "express";
import { uploadRouter } from "../../routes/upload";
import { requestIdMiddleware } from "../../middleware/requestId";
import { expectSuccessResponse } from "../helpers/response";

jest.mock("../../middleware/auth", () => ({
  authenticate: jest.fn((req: any, res: any, next: any) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing authorization token" });
    }
    req.userId = "user-123";
    next();
  }),
  AuthRequest: {},
}));

jest.mock("../../lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("../../lib/prisma", () => ({ prisma: {} }));
jest.mock("../../lib/logger", () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock("pdf-parse", () =>
  jest.fn().mockResolvedValue({ text: "Extracted PDF text content here." }),
);

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/upload", uploadRouter);

// Surface multer errors (fileFilter cb(err) and LIMIT_FILE_SIZE) to the test assertions
app.use((err: any, _req: any, res: any, _next: any) => {
  if (err.message?.includes("Unsupported file type")) {
    return res.status(415).json({ error: err.message });
  }
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File too large. Maximum size is 10 MB." });
  }
  res.status(500).json({ error: "Internal server error" });
});

const AUTH = { Authorization: "Bearer mock_token" };

describe("POST /api/upload/extract-text", () => {
  describe("authentication", () => {
    it("returns 401 without auth header", async () => {
      const buf = Buffer.from("hello world");
      const res = await request(app)
        .post("/api/upload/extract-text")
        .attach("file", buf, { filename: "test.txt", contentType: "text/plain" });
      expect(res.status).toBe(401);
    });
  });

  describe("validation", () => {
    it("returns 400 when no file is attached", async () => {
      const res = await request(app)
        .post("/api/upload/extract-text")
        .set(AUTH)
        .send();
      expect(res.status).toBe(400);
      expect(res.body.error).toBeTruthy();
    });
  });

  describe("plain text extraction", () => {
    it("returns 200 with extracted text for a .txt file", async () => {
      const content = "Hello world. This is a test document with some content.";
      const buf = Buffer.from(content, "utf-8");
      const res = await request(app)
        .post("/api/upload/extract-text")
        .set(AUTH)
        .attach("file", buf, { filename: "notes.txt", contentType: "text/plain" });

      expect(res.status).toBe(200);
      const data = expectSuccessResponse<any>(res.body);
      expect(data.text).toBe(content.trim());
      expect(data.wordCount).toBeGreaterThan(0);
      expect(data.filename).toBe("notes.txt");
      expect(data.mimeType).toBe("text/plain");
      expect(data.truncated).toBe(false);
    });
  });

  describe("PDF extraction", () => {
    it("returns 200 with pdf-parse output for a PDF file", async () => {
      const buf = Buffer.from("%PDF-1.4 fake pdf binary");
      const res = await request(app)
        .post("/api/upload/extract-text")
        .set(AUTH)
        .attach("file", buf, { filename: "report.pdf", contentType: "application/pdf" });

      expect(res.status).toBe(200);
      const data = expectSuccessResponse<any>(res.body);
      expect(data.text).toBe("Extracted PDF text content here.");
      expect(data.filename).toBe("report.pdf");
      expect(data.mimeType).toBe("application/pdf");
      expect(data.truncated).toBe(false);
    });
  });

  describe("unsupported file type", () => {
    it("returns 415 for an image upload", async () => {
      const buf = Buffer.from("fake image bytes");
      const res = await request(app)
        .post("/api/upload/extract-text")
        .set(AUTH)
        .attach("file", buf, { filename: "photo.jpg", contentType: "image/jpeg" });

      expect(res.status).toBe(415);
      expect(res.body.error).toMatch(/Unsupported file type/i);
    });
  });

  describe("file size limit", () => {
    it("returns 413 when file exceeds 10 MB", async () => {
      const bigBuf = Buffer.alloc(11 * 1024 * 1024, "x");
      const res = await request(app)
        .post("/api/upload/extract-text")
        .set(AUTH)
        .attach("file", bigBuf, { filename: "huge.txt", contentType: "text/plain" });

      expect(res.status).toBe(413);
      expect(res.body.error).toMatch(/too large/i);
    });
  });
});
