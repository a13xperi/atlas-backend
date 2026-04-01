/**
 * Provider Router test suite
 * Tests: task-based routing, fallback chains, provider selection helpers
 * Mocks: individual provider adapters
 */

import type { Provider, CompletionResponse } from "../../../lib/providers/types";

// Build mock providers with controllable availability and behavior
function makeMockProvider(id: string, available: boolean): Provider & { completeMock: jest.Mock } {
  const completeMock = jest.fn();
  return {
    config: {
      id: id as any,
      defaultModel: `${id}-model`,
      available,
      inputCostPer1M: 1,
      outputCostPer1M: 1,
    },
    complete: completeMock,
    completeMock,
  };
}

const mockAnthropic = makeMockProvider("anthropic", true);
const mockOpenai = makeMockProvider("openai", true);
const mockGemini = makeMockProvider("gemini", true);
const mockGrok = makeMockProvider("grok", true);

jest.mock("../../../lib/providers/anthropic", () => ({
  anthropicProvider: mockAnthropic,
}));
jest.mock("../../../lib/providers/openai", () => ({
  openaiProvider: mockOpenai,
}));
jest.mock("../../../lib/providers/gemini", () => ({
  geminiProvider: mockGemini,
}));
jest.mock("../../../lib/providers/grok", () => ({
  grokProvider: mockGrok,
}));

import { routeCompletion, completeWith, getPreferredProvider, listProviders } from "../../../lib/providers/router";

const successResponse = (provider: string): CompletionResponse => ({
  content: `response from ${provider}`,
  provider: provider as any,
  model: `${provider}-model`,
  usage: { inputTokens: 10, outputTokens: 20 },
  latencyMs: 100,
});

const baseRequest = {
  messages: [
    { role: "system" as const, content: "You are helpful" },
    { role: "user" as const, content: "Hello" },
  ],
};

describe("routeCompletion", () => {
  beforeEach(() => {
    mockAnthropic.completeMock.mockReset();
    mockOpenai.completeMock.mockReset();
    mockGemini.completeMock.mockReset();
    mockGrok.completeMock.mockReset();
    mockAnthropic.config.available = true;
    mockOpenai.config.available = true;
    mockGemini.config.available = true;
    mockGrok.config.available = true;
  });

  it("routes tweet_generation to OpenAI as primary", async () => {
    mockOpenai.completeMock.mockResolvedValueOnce(successResponse("openai"));

    const result = await routeCompletion({ ...baseRequest, taskType: "tweet_generation" });
    expect(result.provider).toBe("openai");
    expect(mockOpenai.completeMock).toHaveBeenCalledTimes(1);
    expect(mockAnthropic.completeMock).not.toHaveBeenCalled();
  });

  it("routes research to Anthropic as primary", async () => {
    mockAnthropic.completeMock.mockResolvedValueOnce(successResponse("anthropic"));

    const result = await routeCompletion({ ...baseRequest, taskType: "research" });
    expect(result.provider).toBe("anthropic");
    expect(mockAnthropic.completeMock).toHaveBeenCalledTimes(1);
  });

  it("routes trending to Grok as primary", async () => {
    mockGrok.completeMock.mockResolvedValueOnce(successResponse("grok"));

    const result = await routeCompletion({ ...baseRequest, taskType: "trending" });
    expect(result.provider).toBe("grok");
  });

  it("routes image_concept to Gemini as primary", async () => {
    mockGemini.completeMock.mockResolvedValueOnce(successResponse("gemini"));

    const result = await routeCompletion({ ...baseRequest, taskType: "image_concept" });
    expect(result.provider).toBe("gemini");
  });

  it("defaults to general routing when taskType is omitted", async () => {
    mockOpenai.completeMock.mockResolvedValueOnce(successResponse("openai"));

    const result = await routeCompletion(baseRequest);
    expect(result.provider).toBe("openai");
  });

  it("falls back to next provider when primary fails", async () => {
    mockAnthropic.completeMock.mockRejectedValueOnce(new Error("Rate limited"));
    mockOpenai.completeMock.mockResolvedValueOnce(successResponse("openai"));

    const result = await routeCompletion({ ...baseRequest, taskType: "research" });
    expect(result.provider).toBe("openai");
    expect(mockAnthropic.completeMock).toHaveBeenCalledTimes(1);
    expect(mockOpenai.completeMock).toHaveBeenCalledTimes(1);
  });

  it("falls back through full chain until one succeeds", async () => {
    mockOpenai.completeMock.mockRejectedValueOnce(new Error("Timeout"));
    mockAnthropic.completeMock.mockRejectedValueOnce(new Error("500"));
    mockGemini.completeMock.mockResolvedValueOnce(successResponse("gemini"));

    const result = await routeCompletion({ ...baseRequest, taskType: "tweet_generation" });
    expect(result.provider).toBe("gemini");
  });

  it("throws when all providers in chain fail", async () => {
    mockOpenai.completeMock.mockRejectedValueOnce(new Error("fail1"));
    mockAnthropic.completeMock.mockRejectedValueOnce(new Error("fail2"));
    mockGemini.completeMock.mockRejectedValueOnce(new Error("fail3"));

    await expect(
      routeCompletion({ ...baseRequest, taskType: "tweet_generation" })
    ).rejects.toThrow("All providers failed");
  });

  it("skips unavailable providers", async () => {
    mockOpenai.config.available = false;
    mockAnthropic.completeMock.mockResolvedValueOnce(successResponse("anthropic"));

    const result = await routeCompletion({ ...baseRequest, taskType: "tweet_generation" });
    expect(result.provider).toBe("anthropic");
    expect(mockOpenai.completeMock).not.toHaveBeenCalled();
  });

  it("throws when no providers are available", async () => {
    mockOpenai.config.available = false;
    mockAnthropic.config.available = false;
    mockGemini.config.available = false;

    await expect(
      routeCompletion({ ...baseRequest, taskType: "tweet_generation" })
    ).rejects.toThrow("No providers available");
  });
});

describe("completeWith", () => {
  beforeEach(() => {
    mockAnthropic.completeMock.mockReset();
    mockAnthropic.config.available = true;
  });

  it("targets a specific provider directly", async () => {
    mockAnthropic.completeMock.mockResolvedValueOnce(successResponse("anthropic"));

    const result = await completeWith("anthropic", baseRequest);
    expect(result.provider).toBe("anthropic");
  });

  it("throws when targeted provider is unavailable", async () => {
    mockAnthropic.config.available = false;

    await expect(completeWith("anthropic", baseRequest)).rejects.toThrow(
      "not available"
    );
  });
});

describe("getPreferredProvider", () => {
  beforeEach(() => {
    mockAnthropic.config.available = true;
    mockOpenai.config.available = true;
    mockGemini.config.available = true;
    mockGrok.config.available = true;
  });

  it("returns first available provider for task type", () => {
    const provider = getPreferredProvider("research");
    expect(provider?.config.id).toBe("anthropic");
  });

  it("skips unavailable and returns next", () => {
    mockAnthropic.config.available = false;
    const provider = getPreferredProvider("research");
    expect(provider?.config.id).toBe("openai");
  });

  it("returns null when no providers available", () => {
    mockOpenai.config.available = false;
    mockAnthropic.config.available = false;
    mockGemini.config.available = false;
    const provider = getPreferredProvider("tweet_generation");
    expect(provider).toBeNull();
  });
});

describe("listProviders", () => {
  it("returns only available providers", () => {
    mockAnthropic.config.available = true;
    mockOpenai.config.available = true;
    mockGemini.config.available = false;
    mockGrok.config.available = false;

    const providers = listProviders();
    expect(providers).toHaveLength(2);
    expect(providers.map((p) => p.config.id)).toEqual(
      expect.arrayContaining(["anthropic", "openai"])
    );
  });
});
