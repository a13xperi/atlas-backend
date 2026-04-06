import Anthropic from "@anthropic-ai/sdk";
import { config as envConfig } from "../config";
import type { Provider, ProviderConfig, CompletionRequest, CompletionResponse, ToolCall } from "./types";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ timeout: 20_000, maxRetries: 0 });
  }
  return client;
}

const config: ProviderConfig = {
  id: "anthropic",
  defaultModel: "claude-sonnet-4-20250514",
  available: !!envConfig.ANTHROPIC_API_KEY,
  inputCostPer1M: 3.0,
  outputCostPer1M: 15.0,
};

export const anthropicProvider: Provider = {
  config,

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const ai = getClient();
    const start = Date.now();

    // Anthropic requires system message separate from messages array
    const systemMessage = request.messages.find((m) => m.role === "system");
    const nonSystemMessages = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const modelToUse = request.model ?? config.defaultModel;

    const response = await ai.messages.create({
      model: modelToUse,
      max_tokens: request.maxTokens ?? 1024,
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(systemMessage && { system: systemMessage.content }),
      messages: nonSystemMessages,
      ...(request.tools && { tools: request.tools }),
      ...(request.tool_choice && { tool_choice: request.tool_choice }),
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const content = textBlock?.text ?? "";

    // Parse tool_use blocks if present
    const toolCalls: ToolCall[] = response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }));

    return {
      content,
      provider: "anthropic",
      model: modelToUse,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      latencyMs: Date.now() - start,
      ...(toolCalls.length > 0 && { toolCalls }),
    };
  },
};
