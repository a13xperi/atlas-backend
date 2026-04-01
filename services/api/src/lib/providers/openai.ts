import OpenAI from "openai";
import type { Provider, ProviderConfig, CompletionRequest, CompletionResponse } from "./types";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI();
  }
  return client;
}

const config: ProviderConfig = {
  id: "openai",
  defaultModel: "gpt-4o",
  available: !!process.env.OPENAI_API_KEY,
  inputCostPer1M: 2.5,
  outputCostPer1M: 10.0,
};

export const openaiProvider: Provider = {
  config,

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const ai = getClient();
    const start = Date.now();

    const response = await ai.chat.completions.create({
      model: config.defaultModel,
      max_tokens: request.maxTokens ?? 1024,
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(request.jsonMode && { response_format: { type: "json_object" as const } }),
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    const content = response.choices[0]?.message?.content?.trim() ?? "";

    return {
      content,
      provider: "openai",
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
