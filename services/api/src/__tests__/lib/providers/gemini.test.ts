/**
 * Gemini provider adapter test suite
 * Tests: role mapping, system message prepend, response parsing
 * Mocks: @google/generative-ai SDK
 */

const mockGenerateContent = jest.fn();

jest.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({
      generateContent: mockGenerateContent,
    }),
  })),
}));

process.env.GOOGLE_AI_API_KEY = "test-key";

import { geminiProvider } from "../../../lib/providers/gemini";

describe("geminiProvider", () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
  });

  it("has correct config", () => {
    expect(geminiProvider.config.id).toBe("gemini");
  });

  it("maps assistant role to model for Gemini API", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => "response",
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      },
    });

    await geminiProvider.complete({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "how are you" },
      ],
    });

    const callArgs = mockGenerateContent.mock.calls[0][0];
    expect(callArgs.contents[0].role).toBe("user");
    expect(callArgs.contents[1].role).toBe("model");
    expect(callArgs.contents[2].role).toBe("user");
  });

  it("prepends system instructions to first user message", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => "response",
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      },
    });

    await geminiProvider.complete({
      messages: [
        { role: "system", content: "Be concise" },
        { role: "user", content: "What is BTC?" },
      ],
    });

    const callArgs = mockGenerateContent.mock.calls[0][0];
    expect(callArgs.contents).toHaveLength(1);
    const firstParts = callArgs.contents[0].parts;
    expect(firstParts[0].text).toContain("Be concise");
    expect(firstParts[1].text).toBe("What is BTC?");
  });

  it("returns content from response text", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => "Bitcoin is a cryptocurrency",
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8 },
      },
    });

    const result = await geminiProvider.complete({
      messages: [{ role: "user", content: "What is BTC?" }],
    });

    expect(result.content).toBe("Bitcoin is a cryptocurrency");
    expect(result.provider).toBe("gemini");
  });

  it("includes usage stats from usageMetadata", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => "ok",
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
      },
    });

    const result = await geminiProvider.complete({
      messages: [{ role: "user", content: "test" }],
    });

    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it("handles missing usageMetadata gracefully", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => "ok",
        usageMetadata: null,
      },
    });

    const result = await geminiProvider.complete({
      messages: [{ role: "user", content: "test" }],
    });

    expect(result.usage).toBeUndefined();
  });

  it("passes maxTokens in generationConfig", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => "ok",
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      },
    });

    await geminiProvider.complete({
      messages: [{ role: "user", content: "test" }],
      maxTokens: 500,
      temperature: 0.7,
    });

    const callArgs = mockGenerateContent.mock.calls[0][0];
    expect(callArgs.generationConfig.maxOutputTokens).toBe(500);
    expect(callArgs.generationConfig.temperature).toBe(0.7);
  });
});
