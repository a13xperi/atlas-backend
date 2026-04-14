/**
 * Unified LLM Provider types — inspired by claw-code's api crate Provider trait.
 * All providers implement the same interface; the router selects the best one per task.
 */

export type ProviderId = "anthropic" | "openai" | "gemini" | "grok";

export type TaskType =
  | "tweet_generation"
  | "research"
  | "trending"
  | "image_concept"
  | "oracle_smart"
  | "oracle_fast"
  | "oracle_agent"
  | "general";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Anthropic-compatible tool definition for function calling. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

/** A tool call returned by the model. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface CompletionRequest {
  messages: Message[];
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  /** Which task this is for — used by the router to pick the best provider */
  taskType?: TaskType;
  /** Override the provider's default model */
  model?: string;
  /** Tool definitions for function calling (Anthropic tool_use). */
  tools?: ToolDefinition[];
  /** How the model should choose tools. Default: auto when tools are provided. */
  tool_choice?: { type: "auto" } | { type: "any" } | { type: "tool"; name: string };
}

export interface CompletionResponse {
  content: string;
  provider: ProviderId;
  model: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  latencyMs: number;
  /** Tool calls returned by the model (when tools were provided). */
  toolCalls?: ToolCall[];
}

export interface ProviderConfig {
  id: ProviderId;
  /** Default model for this provider */
  defaultModel: string;
  /** Whether this provider is available (has API key configured) */
  available: boolean;
  /** Cost per 1M input tokens (USD) — for routing decisions */
  inputCostPer1M: number;
  /** Cost per 1M output tokens (USD) */
  outputCostPer1M: number;
}

export interface Provider {
  readonly config: ProviderConfig;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  stream?(request: CompletionRequest): AsyncGenerator<string, void, unknown>;
}
