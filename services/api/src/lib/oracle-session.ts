import { Prisma } from "@prisma/client";
import { z } from "zod";
import { buildOracleSystemPrompt } from "./oracle-prompt";
import { prisma } from "./prisma";

export const oracleStoredMessageSchema = z.object({
  role: z.enum(["user", "oracle"]),
  content: z.string(),
  timestamp: z.string(),
});

export type OracleStoredMessage = z.infer<typeof oracleStoredMessageSchema>;

export const oracleContextInputSchema = z.object({
  currentPage: z.string().max(200).optional(),
  goals: z.array(z.string().max(200)).max(20).optional(),
}).catchall(z.unknown());

export type OracleSessionContext = z.infer<typeof oracleContextInputSchema>;

function asObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

export function parseOracleMessages(messages: Prisma.JsonValue[]): OracleStoredMessage[] {
  return messages.flatMap((message) => {
    const parsed = oracleStoredMessageSchema.safeParse(message);
    return parsed.success ? [parsed.data] : [];
  });
}

export function parseOracleContext(value: Prisma.JsonValue | null | undefined): OracleSessionContext {
  const parsed = oracleContextInputSchema.safeParse(asObject(value));
  return parsed.success ? parsed.data : {};
}

export function serializeOracleSession(session: {
  id: string;
  userId: string;
  messages: Prisma.JsonValue[];
  context: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: session.id,
    userId: session.userId,
    messages: parseOracleMessages(session.messages),
    context: parseOracleContext(session.context),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function truncate(value: string, max = 180): string {
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, max - 1)}…`;
}

export async function buildOracleSessionContext(
  userId: string,
  input: unknown,
  existing: OracleSessionContext = {},
): Promise<OracleSessionContext> {
  const contextInput = oracleContextInputSchema.parse(input ?? {});

  const [user, voiceProfile, recentDrafts, briefingPreference] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        handle: true,
        displayName: true,
        avatarUrl: true,
        onboardingTrack: true,
        xHandle: true,
      },
    }),
    prisma.voiceProfile.findUnique({
      where: { userId },
      select: {
        humor: true,
        formality: true,
        brevity: true,
        contrarianTone: true,
        directness: true,
        warmth: true,
        technicalDepth: true,
        confidence: true,
        evidenceOrientation: true,
        solutionOrientation: true,
        socialPosture: true,
        selfPromotionalIntensity: true,
        maturity: true,
        tweetsAnalyzed: true,
        updatedAt: true,
      },
    }),
    prisma.tweetDraft.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: {
        id: true,
        content: true,
        status: true,
        sourceType: true,
        updatedAt: true,
      },
    }),
    prisma.briefingPreference.findUnique({
      where: { userId },
      select: {
        topics: true,
        sources: true,
        channel: true,
      },
    }),
  ]);

  if (!user) {
    throw new Error("User not found");
  }

  const goals = contextInput.goals ?? existing.goals ?? briefingPreference?.topics ?? [];
  const currentPage = contextInput.currentPage ?? existing.currentPage;

  return {
    ...existing,
    ...contextInput,
    ...(currentPage ? { currentPage } : {}),
    goals,
    user: {
      id: user.id,
      handle: user.handle,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      onboardingTrack: user.onboardingTrack,
      xHandle: user.xHandle,
    },
    voiceProfile: voiceProfile
      ? {
          ...voiceProfile,
          updatedAt: voiceProfile.updatedAt.toISOString(),
        }
      : null,
    recentTweets: recentDrafts.map((draft) => ({
      id: draft.id,
      content: truncate(draft.content, 220),
      status: draft.status,
      sourceType: draft.sourceType,
      updatedAt: draft.updatedAt.toISOString(),
    })),
    briefing: briefingPreference
      ? {
          topics: briefingPreference.topics,
          sources: briefingPreference.sources,
          channel: briefingPreference.channel,
        }
      : null,
  };
}

function formatVoiceProfile(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "No voice profile is available yet.";
  }

  const profile = value as Record<string, unknown>;
  const parts = [
    `Humor ${profile.humor ?? "?"}/100`,
    `Formality ${profile.formality ?? "?"}/100`,
    `Brevity ${profile.brevity ?? "?"}/100`,
    `Contrarian ${profile.contrarianTone ?? "?"}/100`,
    `Directness ${profile.directness ?? "?"}/100`,
    `Warmth ${profile.warmth ?? "?"}/100`,
    `Technical depth ${profile.technicalDepth ?? "?"}/100`,
    `Confidence ${profile.confidence ?? "?"}/100`,
  ];

  return parts.join(", ");
}

function formatRecentTweets(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    return "No recent Atlas draft history is available.";
  }

  return value
    .slice(0, 3)
    .map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return `${index + 1}. Unknown draft`;
      }

      const draft = entry as Record<string, unknown>;
      return `${index + 1}. ${truncate(String(draft.content ?? ""), 140)}`;
    })
    .join("\n");
}

export function buildOracleCopilotSystemPrompt(context: OracleSessionContext): string {
  const userContext = context.user && typeof context.user === "object" && !Array.isArray(context.user)
    ? context.user as Record<string, unknown>
    : {};

  const goals = Array.isArray(context.goals) && context.goals.length > 0
    ? context.goals.join(", ")
    : "No explicit goals have been saved yet.";

  const page = context.currentPage ?? "Unknown page";

  return `${buildOracleSystemPrompt()}

You are now the persistent Oracle copilot inside Atlas. This chat follows the user across pages, so maintain continuity and remember prior turns from the session history.

Atlas context:
- Current page: ${page}
- Goals: ${goals}
- User: ${userContext.displayName ?? userContext.handle ?? "Unknown analyst"} (${userContext.handle ?? "no handle"})
- X handle: ${userContext.xHandle ?? "not connected"}
- Voice profile: ${formatVoiceProfile(context.voiceProfile)}
- Recent Atlas drafts:
${formatRecentTweets(context.recentTweets)}

Instructions:
- Use the saved voice profile and recent draft history to personalize advice.
- Speak like the Oracle, but be concrete about what the user should do next.
- Keep default responses concise unless the user explicitly asks for detail.
- If the user changes goals or page context mid-conversation, adapt immediately.`;
}
