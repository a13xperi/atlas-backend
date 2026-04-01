/**
 * Anthropic provider adapter test suite
 * Tests: system message separation, message mapping, response parsing
 * Mocks: @anthropic-ai/sdk
 */

const mockCreate = jest.fn();

jest.mock("@anthropic-ai/sdk", () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }));
});

process.env.ANTHROPIC_API_KEY = "test-key";

import { anthropicProvider } from "../../../lib/providers/anthropic";

describe("anthropicProvider", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("has correct config", () => {
    expect(anthropicProvider.config.id).toBe("anthropic");
    expect(anthropicProvider.config.defaultModel).toContain("claude");
  });

  it("sends system message separately from messages array", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Hello!" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await anthropicProvider.complete({
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hi" },
      ],
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        system: "You are helpful",
        messages: [{ role: "user", content: "Hi" }],
      })
    );
  });

  it("filters system messages from the messages array", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "response" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await anthropicProvider.complete({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "user msg" },
        { role: "assistant", content: "assistant msg" },
      ],
    });

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages).toEqual([
      { role: "user", content: "user msg" },
      { role: "assistant", content: "assistant msg" },
    ]);
  });

  it("returns content from text block", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "The answer is 42" }],
      usage: { input_tokens: 10, output_tokens: 8 },
    });

    const result = await anthropicProvider.complete({
      messages: [{ role: "user", content: "What is the meaning of life?" }],
    });

    expect(result.content).toBe("The answer is 42");
    expect(result.provider).toBe("anthropic");
  });

  it("returns empty string when no text block found", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [],
      usage: { input_tokens: 5, output_tokens: 0 },
    });

    const result = await anthropicProvider.complete({
      messages: [{ role: "user", content: "test" }],
    });

    expect(result.content).toBe("");
  });

  it("includes usage stats", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const result = await anthropicProvider.complete({
      messages: [{ role: "user", content: "test" }],
    });

    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it("tracks latency", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const result = await anthropicProvider.complete({
      messages: [{ role: "user", content: "test" }],
    });

    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("passes maxTokens and temperature", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await anthropicProvider.complete({
      messages: [{ role: "user", content: "test" }],
      maxTokens: 500,
      temperature: 0.3,
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: 500,
        temperature: 0.3,
      })
    );
  });
});
