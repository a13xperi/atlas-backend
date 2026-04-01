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
  | "general";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  messages: Message[];
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  /** Which task this is for — used by the router to pick the best provider */
  taskType?: TaskType;
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
}
