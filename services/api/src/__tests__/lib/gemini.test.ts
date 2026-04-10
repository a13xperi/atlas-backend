const mockConfig: {
  GOOGLE_AI_API_KEY?: string;
  GEMINI_MODEL: string;
  GEMINI_IMAGE_MODEL?: string;
} = {
  GOOGLE_AI_API_KEY: "test-key",
  GEMINI_MODEL: "gemini-2.5-flash",
  GEMINI_IMAGE_MODEL: undefined,
};

const mockGenerateContent = jest.fn();
const mockGetGenerativeModel = jest.fn(() => ({
  generateContent: mockGenerateContent,
}));
const mockGoogleGenerativeAI = jest.fn(() => ({
  getGenerativeModel: mockGetGenerativeModel,
}));

jest.mock("../../lib/config", () => ({
  get config() {
    return mockConfig;
  },
}));

jest.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: mockGoogleGenerativeAI,
}));

import { generateImage, generateVisualConcept } from "../../lib/gemini";

describe("gemini image helpers", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.GOOGLE_AI_API_KEY = "test-key";
    mockConfig.GEMINI_MODEL = "gemini-2.5-flash";
    mockConfig.GEMINI_IMAGE_MODEL = undefined;
    global.fetch = jest.fn() as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("parses inline image data from Gemini responses", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{ inlineData: { data: "ZmFrZS1pbWFnZQ==", mimeType: "image/png" } }],
          },
        }],
      }),
    });

    const result = await generateImage({
      content: "BTC is mooning",
      style: "quote_card",
      aspectRatio: "4:5",
    });

    expect(result).toEqual(expect.objectContaining({
      imageData: "ZmFrZS1pbWFnZQ==",
      mimeType: "image/png",
    }));

    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toContain("/models/gemini-2.5-flash-image:generateContent");

    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.generationConfig.responseModalities).toEqual(["Image"]);
    expect(body.generationConfig.imageConfig.aspectRatio).toBe("4:5");
  });

  it("falls back to the current image model when GEMINI_MODEL points at a deprecated 2.0 image model", async () => {
    mockConfig.GEMINI_MODEL = "gemini-2.0-flash-exp-image-generation";
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{ inlineData: { data: "ZmFrZS1pbWFnZQ==", mimeType: "image/png" } }],
          },
        }],
      }),
    });

    await generateImage({
      content: "BTC is mooning",
      style: "thumbnail",
    });

    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain("/models/gemini-2.5-flash-image:generateContent");
  });

  it("uses GEMINI_IMAGE_MODEL when explicitly configured", async () => {
    mockConfig.GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image-preview";
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{ inlineData: { data: "ZmFrZS1pbWFnZQ==", mimeType: "image/png" } }],
          },
        }],
      }),
    });

    await generateImage({
      content: "BTC is mooning",
      style: "thumbnail",
    });

    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain("/models/gemini-3.1-flash-image-preview:generateContent");
  });

  it("throws a useful error when Gemini returns text instead of an image", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{ text: "I can only describe the image." }],
          },
        }],
      }),
    });

    await expect(generateImage({
      content: "BTC is mooning",
      style: "quote_card",
    })).rejects.toThrow("Gemini image model returned text instead of an image");
  });

  it("uses a text model fallback for structured concept generation", async () => {
    mockConfig.GEMINI_MODEL = "gemini-2.0-flash-exp-image-generation";
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify({
          concept: "A bold crypto visual",
          colorScheme: ["#4ecdc4", "#1a1a2e", "#2d3748"],
          layout: "centered-quote",
          elements: ["headline frame"],
        }),
      },
    });

    const result = await generateVisualConcept("BTC is mooning", "quote_card");

    expect(mockGetGenerativeModel).toHaveBeenCalledWith({ model: "gemini-2.5-flash" });
    expect(result.concept).toBe("A bold crypto visual");
  });
});
