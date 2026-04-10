import { anthropicProvider } from "./providers/anthropic";
import { getAnthropicClient } from "./anthropic";
import type { Message } from "./providers/types";

interface StreamOracleResponseOptions {
  systemPrompt: string;
  messages: Message[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  onText: (delta: string, snapshot: string) => void;
}

interface StreamOracleResponseResult {
  text: string;
  model: string;
  requestId: string | null | undefined;
}

function extractTextFromContentBlocks(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

export async function streamOracleResponse(
  options: StreamOracleResponseOptions,
): Promise<StreamOracleResponseResult> {
  const client = getAnthropicClient();
  const model = anthropicProvider.config.defaultModel;

  const stream = client.messages.stream({
    model,
    system: options.systemPrompt,
    max_tokens: options.maxTokens ?? 700,
    temperature: options.temperature ?? 0.6,
    messages: options.messages.map((message) => ({
      role: message.role as "user" | "assistant",
      content: message.content,
    })),
  });

  if (options.signal) {
    if (options.signal.aborted) {
      stream.abort();
    } else {
      options.signal.addEventListener("abort", () => stream.abort(), { once: true });
    }
  }

  let text = "";

  stream.on("text", (delta, snapshot) => {
    text = snapshot;
    options.onText(delta, snapshot);
  });

  const finalMessage = await stream.finalMessage();
  const finalText = text || extractTextFromContentBlocks(finalMessage.content as Array<{ type: string; text?: string }>);

  return {
    text: finalText.trim(),
    model,
    requestId: stream.request_id,
  };
}
