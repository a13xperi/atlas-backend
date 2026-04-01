import OpenAI from "openai";
import type { Provider, ProviderConfig, CompletionRequest, CompletionResponse } from "./types";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.XAI_API_KEY,
      baseURL: "https://api.x.ai/v1",
    });
  }
  return client;
}

const config: ProviderConfig = {
  id: "grok",
  defaultModel: "grok-3",
  available: !!process.env.XAI_API_KEY,
  inputCostPer1M: 3.0,
  outputCostPer1M: 15.0,
};

export const grokProvider: Provider = {
  config,

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const ai = getClient();
    const start = Date.now();

    const response = await ai.chat.completions.create({
      model: config.defaultModel,
      max_tokens: request.maxTokens ?? 1024,
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    const content = response.choices[0]?.message?.content?.trim() ?? "";

    return {
      content,
      provider: "grok",
      model: config.defaultModel,
      usage: response.usage
        ? {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens ?? 0,
          }
        : undefined,
      latencyMs: Date.now() - start,
    };
  },
};
