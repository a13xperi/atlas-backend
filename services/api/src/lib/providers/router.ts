/**
 * Provider Router — selects the best provider for each task.
 * Inspired by claw-code's api crate routing pattern.
 *
 * Routes by task type with automatic fallback chains.
 * If the preferred provider fails, tries the next one in the chain.
 */

import type { ProviderId, TaskType, CompletionRequest, CompletionResponse, Provider } from "./types";
import { anthropicProvider } from "./anthropic";
import { openaiProvider } from "./openai";
import { geminiProvider } from "./gemini";
import { grokProvider } from "./grok";

const providers: Record<ProviderId, Provider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  gemini: geminiProvider,
  grok: grokProvider,
};

/**
 * Task-to-provider routing table.
 * First available provider in the chain is used; others are fallbacks.
 *
 * Rationale:
 * - tweet_generation: OpenAI (proven path) → Anthropic → Gemini
 * - research: Anthropic (strong reasoning) → OpenAI → Gemini (cheapest)
 * - trending: Grok (real-time X data) → OpenAI → Anthropic
 * - image_concept: Gemini (multimodal native) → OpenAI → Anthropic
 * - general: OpenAI → Anthropic → Gemini
 */
const ROUTING_TABLE: Record<TaskType, ProviderId[]> = {
  tweet_generation: ["openai", "anthropic", "gemini"],
  research: ["anthropic", "openai", "gemini"],
  trending: ["grok", "openai", "anthropic"],
  image_concept: ["gemini", "openai", "anthropic"],
  general: ["openai", "anthropic", "gemini"],
};

function getAvailableChain(taskType: TaskType): Provider[] {
  const chain = ROUTING_TABLE[taskType] ?? ROUTING_TABLE.general;
  return chain
    .map((id) => providers[id])
    .filter((p) => p.config.available);
}

/**
 * Route a completion request to the best available provider.
 * Tries providers in order of preference for the task type.
 * Falls back to the next provider if one fails.
 */
export async function routeCompletion(request: CompletionRequest): Promise<CompletionResponse> {
  const taskType = request.taskType ?? "general";
  const chain = getAvailableChain(taskType);

  if (chain.length === 0) {
    throw new Error(`No providers available for task type: ${taskType}`);
  }

  let lastError: Error | undefined;

  for (const provider of chain) {
    try {
      return await provider.complete(request);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `[providers] ${provider.config.id} failed for ${taskType}: ${lastError.message}. Trying next...`
      );
    }
  }

  throw new Error(
    `All providers failed for ${taskType}. Last error: ${lastError?.message}`
  );
}

/**
 * Route to a specific provider by ID (bypass the routing table).
 * Useful when you explicitly need a particular provider.
 */
export async function completeWith(
  providerId: ProviderId,
  request: CompletionRequest
): Promise<CompletionResponse> {
  const provider = providers[providerId];
  if (!provider.config.available) {
    throw new Error(`Provider ${providerId} is not available (missing API key)`);
  }
  return provider.complete(request);
}

/**
 * Get the preferred provider for a task type without making a request.
 * Useful for checking availability before building requests.
 */
export function getPreferredProvider(taskType: TaskType): Provider | null {
  const chain = getAvailableChain(taskType);
  return chain[0] ?? null;
}

/**
 * List all available providers and their configs.
 */
export function listProviders(): Provider[] {
  return Object.values(providers).filter((p) => p.config.available);
}
