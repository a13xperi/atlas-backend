/**
 * Route test for POST /api/campaigns/generate-from-pdf.
 *
 * Mirrors the mock pattern used in routes/campaigns.test.ts + routes/upload.test.ts:
 *   - auth middleware is stubbed with a Bearer check
 *   - pdf-parse, prisma, supabase, logger, extractInsights, batchGenerateDrafts
 *     are all mocked so the test never hits the real generation pipeline
 *   - multer runs for real so we exercise the fileFilter + size limits
 */

import request from "supertest";
import express from "express";
import { campaignsPdfRouter } from "../../routes/campaigns-pdf";
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
  jest.fn().mockResolvedValue({
    text: "This is a mocked PDF with enough text content to pass the minimum-length check for insight extraction. It has multiple sentences and realistic prose.",
  }),
);

jest.mock("../../lib/content-extraction", () => ({
  extractInsights: jest.fn(),
}));

jest.mock("../../lib/batch-generate", () => ({
  batchGenerateDrafts: jest.fn(),
}));

import { extractInsights } from "../../lib/content-extraction";
import { batchGenerateDrafts } from "../../lib/batch-generate";

const mockExtractInsights = extractInsights as jest.Mock;
const mockBatchGenerateDrafts = batchGenerateDrafts as jest.Mock;

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);
app.use("/api/campaigns", campaignsPdfRouter);

// Surface multer errors (fileFilter cb(err), LIMIT_FILE_SIZE) to the test assertions
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
const ROUTE = "/api/campaigns/generate-from-pdf";

// Long sample text used across the happy-path + truncation tests. Above the
// 50-char floor that extractInsights enforces internally.
const SAMPLE_TEXT =
  "This is a long enough block of text to pass the 50-character minimum for insight extraction. " +
  "It contains several sentences to look like a report body.";

describe("POST /api/campaigns/generate-from-pdf", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("authentication", () => {
    it("returns 401 without auth header", async () => {
      const res = await request(app)
        .post(ROUTE)
        .attach("file", Buffer.from(SAMPLE_TEXT, "utf-8"), {
          filename: "notes.txt",
          contentType: "text/plain",
        });
      expect(res.status).toBe(401);
    });
  });

  describe("file validation", () => {
    it("returns 400 when no file is attached", async () => {
      const res = await request(app).post(ROUTE).set(AUTH).send();
      expect(res.status).toBe(400);
      expect(res.body.error).toBeTruthy();
    });

    it("returns 415 for an unsupported mime type", async () => {
      const res = await request(app)
        .post(ROUTE)
        .set(AUTH)
        .attach("file", Buffer.from("fake"), {
          filename: "photo.jpg",
          contentType: "image/jpeg",
        });
      expect(res.status).toBe(415);
      expect(res.body.error).toMatch(/Unsupported file type/i);
    });

    it("returns 413 when the file exceeds 10 MB", async () => {
      const big = Buffer.alloc(11 * 1024 * 1024, "x");
      const res = await request(app)
        .post(ROUTE)
        .set(AUTH)
        .attach("file", big, { filename: "huge.txt", contentType: "text/plain" });
      expect(res.status).toBe(413);
      expect(res.body.error).toMatch(/too large/i);
    });

    it("returns 422 when the extracted text is too short for insight extraction", async () => {
      const res = await request(app)
        .post(ROUTE)
        .set(AUTH)
        .attach("file", Buffer.from("too short"), {
          filename: "short.txt",
          contentType: "text/plain",
        });

      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/too little text/i);
      // Pipeline mocks should NOT have been called — we bailed before them.
      expect(mockExtractInsights).not.toHaveBeenCalled();
      expect(mockBatchGenerateDrafts).not.toHaveBeenCalled();
    });
  });

  describe("body validation", () => {
    it("returns 400 when angles is out of range", async () => {
      const res = await request(app)
        .post(ROUTE)
        .set(AUTH)
        .field("angles", "42")
        .attach("file", Buffer.from(SAMPLE_TEXT, "utf-8"), {
          filename: "notes.txt",
          contentType: "text/plain",
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid request/i);
      expect(mockExtractInsights).not.toHaveBeenCalled();
    });

    it("returns 400 when tone is an empty string", async () => {
      const res = await request(app)
        .post(ROUTE)
        .set(AUTH)
        .field("tone", "")
        .attach("file", Buffer.from(SAMPLE_TEXT, "utf-8"), {
          filename: "notes.txt",
          contentType: "text/plain",
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid request/i);
    });
  });

  describe("happy path — text upload", () => {
    beforeEach(() => {
      mockExtractInsights.mockResolvedValueOnce([
        {
          title: "Dominance is back",
          summary: "BTC is reclaiming attention from alts.",
          keyQuote: "BTC dominance hit 58%.",
          angle: "data highlight",
        },
        {
          title: "Liquidity rotation",
          summary: "Capital is flowing into majors.",
          keyQuote: "Stablecoin flows to BTC doubled.",
          angle: "prediction",
        },
      ]);
      mockBatchGenerateDrafts.mockResolvedValueOnce({
        campaign: { id: "campaign-42", title: "notes.txt Campaign" },
        drafts: [
          {
            id: "draft-1",
            content: "BTC dominance is doing the talking again.",
            angle: "data highlight",
            score: 0.87,
            qualityScore: 87,
            status: "DRAFT",
          },
          {
            id: "draft-2",
            content: "Capital rotation is underway — watch the majors.",
            angle: "prediction",
            score: 0.78,
            qualityScore: 78,
            status: "DRAFT",
          },
        ],
      });
    });

    it("returns 201 with the new campaign id and drafts", async () => {
      const res = await request(app)
        .post(ROUTE)
        .set(AUTH)
        .field("angles", "2")
        .field("tone", "sharp")
        .attach("file", Buffer.from(SAMPLE_TEXT, "utf-8"), {
          filename: "notes.txt",
          contentType: "text/plain",
        });

      expect(res.status).toBe(201);
      const data = expectSuccessResponse<any>(res.body);
      expect(data.campaignId).toBe("campaign-42");
      expect(data.filename).toBe("notes.txt");
      expect(data.mimeType).toBe("text/plain");
      expect(data.truncated).toBe(false);
      expect(data.wordCount).toBeGreaterThan(0);
      expect(data.drafts).toHaveLength(2);
      expect(data.drafts[0]).toEqual({
        id: "draft-1",
        content: "BTC dominance is doing the talking again.",
        angle: "data highlight",
        score: 0.87,
      });
    });

    it("forwards the coerced angles + tone down to the pipeline", async () => {
      await request(app)
        .post(ROUTE)
        .set(AUTH)
        .field("angles", "2")
        .field("tone", "sharp")
        .attach("file", Buffer.from(SAMPLE_TEXT, "utf-8"), {
          filename: "notes.txt",
          contentType: "text/plain",
        });

      expect(mockExtractInsights).toHaveBeenCalledWith(expect.any(String), { limit: 2 });
      expect(mockBatchGenerateDrafts).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-123",
          tone: "sharp",
          sourceType: "REPORT",
          createCampaign: true,
          // Default campaign title derives from the upload filename
          campaignTitle: "notes.txt Campaign",
        }),
      );
    });

    it("honours an explicit campaign name override from the form body", async () => {
      await request(app)
        .post(ROUTE)
        .set(AUTH)
        .field("angles", "2")
        .field("name", "BTC Q2 Thesis")
        .attach("file", Buffer.from(SAMPLE_TEXT, "utf-8"), {
          filename: "btc-q2.pdf",
          contentType: "application/pdf",
        });

      const args = mockBatchGenerateDrafts.mock.calls[0][0];
      expect(args.campaignTitle).toBe("BTC Q2 Thesis");
    });
  });

  describe("happy path — PDF upload", () => {
    it("returns 201 when uploading a PDF (pdf-parse is mocked with long text)", async () => {
      mockExtractInsights.mockResolvedValueOnce([
        {
          title: "Insight A",
          summary: "Summary A.",
          keyQuote: "Quote A.",
          angle: "explainer",
        },
      ]);
      mockBatchGenerateDrafts.mockResolvedValueOnce({
        campaign: { id: "campaign-pdf", title: "report.pdf Campaign" },
        drafts: [
          {
            id: "draft-pdf-1",
            content: "Tweet content.",
            angle: "explainer",
            score: 0.65,
            qualityScore: 65,
            status: "DRAFT",
          },
        ],
      });

      const res = await request(app)
        .post(ROUTE)
        .set(AUTH)
        .attach("file", Buffer.from("%PDF-1.4 fake"), {
          filename: "report.pdf",
          contentType: "application/pdf",
        });

      expect(res.status).toBe(201);
      const data = expectSuccessResponse<any>(res.body);
      expect(data.campaignId).toBe("campaign-pdf");
      expect(data.mimeType).toBe("application/pdf");
      expect(data.drafts).toHaveLength(1);
    });
  });

  describe("pipeline failures", () => {
    it("returns 502 when batchGenerateDrafts throws 'Failed to generate any drafts'", async () => {
      mockExtractInsights.mockResolvedValueOnce([
        { title: "t", summary: "s", keyQuote: "q", angle: "explainer" },
      ]);
      mockBatchGenerateDrafts.mockRejectedValueOnce(
        new Error("Failed to generate any drafts from the provided insights"),
      );

      const res = await request(app)
        .post(ROUTE)
        .set(AUTH)
        .attach("file", Buffer.from(SAMPLE_TEXT, "utf-8"), {
          filename: "notes.txt",
          contentType: "text/plain",
        });

      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/Failed to generate any drafts/i);
    });

    it("returns 422 when extractInsights throws 'Content too short'", async () => {
      mockExtractInsights.mockRejectedValueOnce(
        new Error("Content too short for insight extraction (minimum 50 characters)"),
      );

      const res = await request(app)
        .post(ROUTE)
        .set(AUTH)
        .attach("file", Buffer.from(SAMPLE_TEXT, "utf-8"), {
          filename: "notes.txt",
          contentType: "text/plain",
        });

      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/Content too short/i);
    });

    it("returns 400 when the voice profile is missing", async () => {
      mockExtractInsights.mockResolvedValueOnce([
        { title: "t", summary: "s", keyQuote: "q", angle: "explainer" },
      ]);
      mockBatchGenerateDrafts.mockRejectedValueOnce(new Error("Voice profile not found"));

      const res = await request(app)
        .post(ROUTE)
        .set(AUTH)
        .attach("file", Buffer.from(SAMPLE_TEXT, "utf-8"), {
          filename: "notes.txt",
          contentType: "text/plain",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Voice profile not found/i);
    });
  });
});
