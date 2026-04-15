// pdf-parse is a native dep that tries to load a sample PDF from disk at
// require-time under certain conditions — mock it here so the unit tests
// never touch the real library.
jest.mock("pdf-parse", () =>
  jest.fn().mockImplementation(async () => ({ text: "  Mocked  PDF  text.\n\n\n\n\nWith blank lines.  " })),
);

import {
  countWords,
  extractTextFromUploadedFile,
  MAX_EXTRACT_TEXT_CHARS,
  normalizeExtractedText,
  SUPPORTED_UPLOAD_MIME_TYPES,
} from "../../lib/file-extract";

describe("normalizeExtractedText", () => {
  it("collapses CRLF line endings to LF", () => {
    expect(normalizeExtractedText("hello\r\nworld\r\n")).toBe("hello\nworld");
  });

  it("collapses 3+ newlines to a double newline", () => {
    expect(normalizeExtractedText("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("preserves a single blank line between paragraphs", () => {
    expect(normalizeExtractedText("a\n\nb")).toBe("a\n\nb");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeExtractedText("   hello   ")).toBe("hello");
  });

  it("handles a realistic PDF-extracted string", () => {
    const input = "\r\n\r\nTitle\r\n\r\n\r\n\r\nBody paragraph one.\r\n\r\n\r\n\r\nBody paragraph two.\r\n\r\n";
    expect(normalizeExtractedText(input)).toBe("Title\n\nBody paragraph one.\n\nBody paragraph two.");
  });
});

describe("countWords", () => {
  it("counts whitespace-separated tokens", () => {
    expect(countWords("hello world this is a test")).toBe(6);
  });

  it("ignores leading and trailing whitespace", () => {
    expect(countWords("   hello world   ")).toBe(2);
  });

  it("treats any whitespace run as one separator", () => {
    expect(countWords("one\ttwo\nthree    four")).toBe(4);
  });

  it("returns 0 for an empty or whitespace-only string", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("     \n\n  \t")).toBe(0);
  });
});

describe("extractTextFromUploadedFile", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("extracts text from a plain-text buffer and reports metadata", async () => {
    const buffer = Buffer.from("Hello, world.\n\n\n\nSecond paragraph here.", "utf-8");
    const result = await extractTextFromUploadedFile({
      buffer,
      originalname: "notes.txt",
      mimetype: "text/plain",
    });

    expect(result.text).toBe("Hello, world.\n\nSecond paragraph here.");
    // ["Hello,", "world.", "Second", "paragraph", "here."] — 5 tokens
    expect(result.wordCount).toBe(5);
    expect(result.truncated).toBe(false);
  });

  it("extracts text from a markdown buffer (mimetype)", async () => {
    const buffer = Buffer.from("# Heading\n\nBody.", "utf-8");
    const result = await extractTextFromUploadedFile({
      buffer,
      originalname: "doc.md",
      mimetype: "text/markdown",
    });
    expect(result.text).toBe("# Heading\n\nBody.");
    expect(result.wordCount).toBe(3);
  });

  it("extracts text from a .md file when mimetype is generic text/plain", async () => {
    const buffer = Buffer.from("notes here", "utf-8");
    const result = await extractTextFromUploadedFile({
      buffer,
      originalname: "inbox.md",
      mimetype: "text/plain",
    });
    expect(result.text).toBe("notes here");
  });

  it("delegates PDFs to pdf-parse and normalises the result", async () => {
    const buffer = Buffer.from("%PDF-1.4 fake");
    const result = await extractTextFromUploadedFile({
      buffer,
      originalname: "report.pdf",
      mimetype: "application/pdf",
    });
    // Mock returns "  Mocked  PDF  text.\n\n\n\n\nWith blank lines.  "
    // Normaliser collapses 5 newlines → 2 and trims.
    expect(result.text).toBe("Mocked  PDF  text.\n\nWith blank lines.");
    expect(result.wordCount).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
  });

  it("throws on an unsupported mime type", async () => {
    const buffer = Buffer.from("binary");
    await expect(
      extractTextFromUploadedFile({
        buffer,
        originalname: "photo.jpg",
        mimetype: "image/jpeg",
      }),
    ).rejects.toThrow(/Unsupported file type/);
  });

  it("truncates to MAX_EXTRACT_TEXT_CHARS and flags truncated=true", async () => {
    const huge = "x".repeat(MAX_EXTRACT_TEXT_CHARS + 5000);
    const result = await extractTextFromUploadedFile({
      buffer: Buffer.from(huge, "utf-8"),
      originalname: "wall-of-text.txt",
      mimetype: "text/plain",
    });
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(MAX_EXTRACT_TEXT_CHARS);
  });

  it("respects a caller-supplied maxChars override", async () => {
    const buffer = Buffer.from("x".repeat(200), "utf-8");
    const result = await extractTextFromUploadedFile(
      { buffer, originalname: "a.txt", mimetype: "text/plain" },
      { maxChars: 50 },
    );
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(50);
  });
});

describe("SUPPORTED_UPLOAD_MIME_TYPES", () => {
  it("includes all mime types the route fileFilter allowlists", () => {
    expect(SUPPORTED_UPLOAD_MIME_TYPES).toEqual(
      expect.arrayContaining([
        "application/pdf",
        "text/plain",
        "text/markdown",
        "text/x-markdown",
      ]),
    );
  });
});
