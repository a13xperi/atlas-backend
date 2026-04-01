/**
 * Grok provider adapter test suite
 * Tests: custom baseURL, XAI_API_KEY, OpenAI-compatible API
 * Mocks: openai SDK (Grok uses OpenAI-compatible client)
 */

const mockCreate = jest.fn();
let capturedConfig: any = null;

jest.mock("openai", () => {
  return jest.fn().mockImplementation((config: any) => {
    capturedConfig = config;
    return {
      chat: { completions: { create: mockCreate } },
    };
  });
});

process.env.XAI_API_KEY = "test-xai-key";

import { grokProvider } from "../../../lib/providers/grok";

describe("grokProvider", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("has correct config", () => {
    expect(grokProvider.config.id).toBe("grok");
    expect(grokProvider.config.defaultModel).toBe("grok-3");
  });

  it("initializes OpenAI client with X.AI base URL", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "response" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    await grokProvider.complete({
      messages: [{ role: "user", content: "test" }],
    });

    expect(capturedConfig.baseURL).toBe("https://api.x.ai/v1");
    expect(capturedConfig.apiKey).toBe("test-xai-key");
  });

  it("passes messages through like OpenAI-compatible API", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "trending data" } }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    });

    await grokProvider.complete({
      messages: [
        { role: "system", content: "Analyze trends" },
        { role: "user", content: "What's trending?" },
      ],
    });

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages).toEqual([
      { role: "system", content: "Analyze trends" },
      { role: "user", content: "What's trending?" },
    ]);
    expect(callArgs.model).toBe("grok-3");
  });

  it("returns trimmed content and provider id", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "  BTC is trending  " } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const result = await grokProvider.complete({
      messages: [{ role: "user", content: "test" }],
    });

    expect(result.content).toBe("BTC is trending");
    expect(result.provider).toBe("grok");
  });

  it("includes usage stats", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 50, completion_tokens: 25 },
    });

    const result = await grokProvider.complete({
      messages: [{ role: "user", content: "test" }],
    });

    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 25 });
  });
});
