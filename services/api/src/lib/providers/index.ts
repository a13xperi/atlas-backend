/**
 * Unified LLM Provider Layer — Atlas's provider abstraction.
 *
 * Usage:
 *   import { complete, completeWith } from "../lib/providers";
 *
 *   // Let the router pick the best provider for the task
 *   const result = await complete({
 *     taskType: "research",
 *     messages: [{ role: "system", content: "..." }, { role: "user", content: "..." }],
 *     maxTokens: 1000,
 *     temperature: 0.3,
 *     jsonMode: true,
 *   });
 *
 *   // Or target a specific provider
 *   const result = await completeWith("anthropic", { messages: [...] });
 */

export type {
  ProviderId,
  TaskType,
  Message,
  CompletionRequest,
  CompletionResponse,
  ProviderConfig,
  Provider,
} from "./types";

export { routeCompletion as complete, completeWith, getPreferredProvider, listProviders } from "./router";
