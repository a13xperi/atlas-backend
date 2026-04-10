/**
 * OpenClaw Router — profile-based LLM routing for Atlas Oracle.
 *
 * Mirrors the OpenClaw RouterEngine pattern (see ../../../../../openclaw/src/router)
 * but implemented locally on top of this backend's `routeCompletion` infra so the
 * atlas-backend service doesn't need to pull OpenClaw as a runtime dependency
 * (OpenClaw is ESM-only; this service is CJS).
 *
 * Profiles
 * --------
 *   smart — calibration, analysis, multi-sentence commentary, planning.
 *           Higher token budget, slightly lower temperature. Routed through
 *           oracle_smart in the underlying provider chain.
 *
 *   fast  — quick conversational replies, nudges, tooltips.
 *           Small token budget, higher temperature for natural cadence.
 *           Routed through oracle_fast in the underlying provider chain.
 *
 * Shape
 * -----
 *   runOracleCompletion({ profile, systemPrompt, userMessage, history? }) →
 *     { reply, model, tokens, provider, latencyMs }
 *
 * The returned `tokens` field is the sum of input + output tokens reported by
 * the underlying provider (0 when the provider does not surface usage).
 */

import { routeCompletion } from "./providers/router";
import type {
  CompletionRequest,
  CompletionResponse,
  Message,
  TaskType,
} from "./providers/types";
import { withTimeout } from "./timeout";

export type OracleProfile = "smart" | "fast";

export interface OracleCompletionOptions {
  /** Routing profile — smart (calibration/analysis) or fast (quick chat). */
  profile: OracleProfile;
  /** System prompt — personality + task framing. */
  systemPrompt: string;
  /** The current user message the Oracle should respond to. */
  userMessage: string;
  /**
   * Optional prior conversation turns (oldest → newest). Caller is responsible
   * for trimming history to a reasonable window.
   */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** Override the profile's default max tokens. */
  maxTokens?: number;
  /** Override the profile's default temperature. */
  temperature?: number;
  /** Overall cap for the underlying provider chain (ms). Defaults to 10s. */
  timeoutMs?: number;
  /** Label for timeout / log correlation. Defaults to "oracle-openclaw". */
  label?: string;
}

export interface OracleCompletionResult {
  reply: string;
  model: string;
  provider: string;
  tokens: number;
  latencyMs: number;
}

interface ProfileConfig {
  taskType: TaskType;
  maxTokens: number;
  temperature: number;
}

const PROFILE_CONFIG: Record<OracleProfile, ProfileConfig> = {
  smart: {
    taskType: "oracle_smart",
    maxTokens: 600,
    temperature: 0.7,
  },
  fast: {
    taskType: "oracle_fast",
    maxTokens: 180,
    temperature: 0.8,
  },
};

/**
 * Execute an Oracle completion through the OpenClaw-style profile router.
 *
 * Internally delegates to `routeCompletion` (the shared provider fallback
 * chain) so every profile automatically benefits from multi-provider failover.
 */
export async function runOracleCompletion(
  options: OracleCompletionOptions,
): Promise<OracleCompletionResult> {
  const profile = PROFILE_CONFIG[options.profile];

  const messages: Message[] = [
    { role: "system", content: options.systemPrompt },
    ...(options.history ?? []).map<Message>((turn) => ({
      role: turn.role,
      content: turn.content,
    })),
    { role: "user", content: options.userMessage },
  ];

  const request: CompletionRequest = {
    taskType: profile.taskType,
    maxTokens: options.maxTokens ?? profile.maxTokens,
    temperature: options.temperature ?? profile.temperature,
    messages,
  };

  const response: CompletionResponse = await withTimeout(
    routeCompletion(request),
    options.timeoutMs ?? 10_000,
    options.label ?? "oracle-openclaw",
  );

  const reply = response.content.trim();
  const usage = response.usage;
  const tokens = usage ? usage.inputTokens + usage.outputTokens : 0;

  return {
    reply,
    model: response.model,
    provider: response.provider,
    tokens,
    latencyMs: response.latencyMs,
  };
}

/**
 * Pick the right profile given a phase hint from the caller.
 *
 * `phase` is a free-form string from the frontend describing what the Oracle
 * is helping with. Calibration/analysis/planning phases prefer the smart
 * profile; everything else defaults to fast for snappy conversation.
 */
export function resolveProfileForPhase(phase?: string | null): OracleProfile {
  if (!phase) return "fast";
  const p = phase.toLowerCase();
  if (
    p.includes("calibrat") ||
    p.includes("analy") ||
    p.includes("plan") ||
    p.includes("blend") ||
    p.includes("research") ||
    p.includes("smart")
  ) {
    return "smart";
  }
  return "fast";
}
