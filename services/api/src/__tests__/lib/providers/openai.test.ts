/**
 * OpenAI provider adapter test suite
 * Tests: message passing, jsonMode, response parsing
 * Mocks: openai SDK
 */

const mockCreate = jest.fn();

jest.mock("openai", () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
});

process.env.OPENAI_API_KEY = "test-key";

import { openaiProvider } from "../../../lib/providers/openai";

describe("openaiProvider", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("has correct config", () => {
    expect(openaiProvider.config.id).toBe("openai");
    expect(openaiProvider.config.defaultModel).toBe("gpt-4o");
  });

  it("passes all messages including system role", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "response" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    await openaiProvider.complete({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "user" },
      ],
    });

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "user" },
    ]);
  });

  it("enables response_format when jsonMode is true", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"key":"value"}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    await openaiProvider.complete({
      messages: [{ role: "user", content: "respond in JSON" }],
      jsonMode: true,
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        response_format: { type: "json_object" },
      })
    );
  });

  it("does not set response_format when jsonMode is false/undefined", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "plain text" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    await openaiProvider.complete({
      messages: [{ role: "user", content: "test" }],
    });

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.response_format).toBeUndefined();
  });

  it("returns trimmed content", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "  response with whitespace  " } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const result = await openaiProvider.complete({
      messages: [{ role: "user", content: "test" }],
    });

    expect(result.content).toBe("response with whitespace");
  });

  it("returns empty string when no content", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: null } }],
      usage: { prompt_tokens: 5, completion_tokens: 0 },
    });

    const result = await openaiProvider.complete({
      messages: [{ role: "user", content: "test" }],
    });

    expect(result.content).toBe("");
  });

  it("includes usage stats", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });

    const result = await openaiProvider.complete({
      messages: [{ role: "user", content: "test" }],
    });

    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it("tracks latency and returns provider id", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const result = await openaiProvider.complete({
      messages: [{ role: "user", content: "test" }],
    });

    expect(result.provider).toBe("openai");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
