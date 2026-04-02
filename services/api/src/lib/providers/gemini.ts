import { GoogleGenerativeAI } from "@google/generative-ai";
import { config as envConfig } from "../config";
import type { Provider, ProviderConfig, CompletionRequest, CompletionResponse } from "./types";

let client: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI {
  if (!client) {
    client = new GoogleGenerativeAI(envConfig.GOOGLE_AI_API_KEY!);
  }
  return client;
}

const config: ProviderConfig = {
  id: "gemini",
  defaultModel: envConfig.GEMINI_MODEL,
  available: !!envConfig.GOOGLE_AI_API_KEY,
  inputCostPer1M: 0.15,
  outputCostPer1M: 0.60,
};

export const geminiProvider: Provider = {
  config,

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const ai = getClient();
    const start = Date.now();

    const model = ai.getGenerativeModel({ model: config.defaultModel });

    // Gemini uses a different message format — combine system + user into contents
    const systemMessage = request.messages.find((m) => m.role === "system");
    const userMessages = request.messages.filter((m) => m.role !== "system");

    const contents = userMessages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    // Prepend system instructions to first user message if present
    if (systemMessage && contents.length > 0 && contents[0].role === "user") {
      contents[0].parts.unshift({
        text: `[System Instructions]\n${systemMessage.content}\n\n[User Message]\n`,
      });
    }

    const result = await model.generateContent({
      contents,
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? 1024,
        ...(request.temperature !== undefined && { temperature: request.temperature }),
      },
    });

    const content = result.response.text();

    return {
      content,
      provider: "gemini",
      model: config.defaultModel,
      usage: result.response.usageMetadata
        ? {
            inputTokens: result.response.usageMetadata.promptTokenCount ?? 0,
            outputTokens: result.response.usageMetadata.candidatesTokenCount ?? 0,
          }
        : undefined,
      latencyMs: Date.now() - start,
    };
  },
};
