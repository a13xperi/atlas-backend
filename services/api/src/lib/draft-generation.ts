import type { TweetDraft } from "@prisma/client";
import { runGenerationPipeline, type PipelineResult } from "./pipeline";
import { prisma } from "./prisma";
import { withTimeout } from "./timeout";

type DraftSourceType =
  | "REPORT"
  | "ARTICLE"
  | "TWEET"
  | "TRENDING_TOPIC"
  | "VOICE_NOTE"
  | "MANUAL";

interface ExistingDraftLike {
  content: string;
  sourceType: DraftSourceType | null;
  sourceContent: string | null;
  blendId: string | null;
  feedback: string | null;
  version: number;
}

interface GenerateDraftFromSourceInput {
  userId: string;
  sourceContent: string;
  sourceType: DraftSourceType;
  blendId?: string;
  feedback?: string;
  replyAngle?: string;
  timeoutLabel?: string;
}

interface RegenerateDraftFromExistingInput {
  userId: string;
  existing: ExistingDraftLike;
  feedback?: string;
  timeoutLabel?: string;
}

interface RefineDraftFromExistingInput {
  userId: string;
  existing: ExistingDraftLike;
  instruction: string;
  timeoutLabel?: string;
}

interface RefineLatestDraftForUserInput {
  userId: string;
  instruction: string;
  timeoutLabel?: string;
}

export interface PersistedDraftGeneration {
  draft: TweetDraft;
  pipeline: PipelineResult;
}

const ROUTE_TIMEOUT_MS = 90_000;

export function normalizeGeneratedTweet(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= 280) return trimmed;
  return `${trimmed.slice(0, 277).trimEnd()}...`;
}

export async function generateDraftFromSource(
  input: GenerateDraftFromSourceInput,
): Promise<PersistedDraftGeneration> {
  const pipeline = await withTimeout(
    runGenerationPipeline({
      userId: input.userId,
      sourceContent: input.sourceContent,
      sourceType: input.sourceType,
      blendId: input.blendId,
      feedback: input.feedback,
      replyAngle: input.replyAngle,
    }),
    ROUTE_TIMEOUT_MS,
    input.timeoutLabel ?? "draft-generation",
  );

  const content = normalizeGeneratedTweet(pipeline.ctx.generatedContent ?? "");

  const draft = await prisma.tweetDraft.create({
    data: {
      userId: input.userId,
      content,
      sourceType: input.sourceType,
      sourceContent: input.sourceContent,
      blendId: input.blendId,
      confidence: pipeline.ctx.confidence,
      predictedEngagement: pipeline.ctx.predictedEngagement,
      version: 1,
      ...(input.feedback ? { feedback: input.feedback } : {}),
    },
  });

  await prisma.analyticsEvent.create({
    data: { userId: input.userId, type: "DRAFT_CREATED" },
  });

  pipeline.ctx.generatedContent = content;

  return { draft, pipeline };
}

export async function regenerateDraftFromExisting(
  input: RegenerateDraftFromExistingInput,
): Promise<PersistedDraftGeneration> {
  const pipeline = await withTimeout(
    runGenerationPipeline({
      userId: input.userId,
      sourceContent: input.existing.sourceContent ?? "",
      sourceType: input.existing.sourceType ?? "MANUAL",
      blendId: input.existing.blendId ?? undefined,
      feedback: input.feedback ?? input.existing.feedback ?? undefined,
    }),
    ROUTE_TIMEOUT_MS,
    input.timeoutLabel ?? "draft-regeneration",
  );

  const content = normalizeGeneratedTweet(pipeline.ctx.generatedContent ?? "");

  const draft = await prisma.tweetDraft.create({
    data: {
      userId: input.userId,
      content,
      sourceType: input.existing.sourceType,
      sourceContent: input.existing.sourceContent,
      blendId: input.existing.blendId,
      confidence: pipeline.ctx.confidence,
      predictedEngagement: pipeline.ctx.predictedEngagement,
      version: input.existing.version + 1,
      feedback: input.feedback ?? input.existing.feedback,
    },
  });

  await prisma.analyticsEvent.create({
    data: { userId: input.userId, type: "DRAFT_CREATED" },
  });

  if (input.feedback) {
    await prisma.analyticsEvent.create({
      data: { userId: input.userId, type: "FEEDBACK_GIVEN" },
    });
  }

  pipeline.ctx.generatedContent = content;

  return { draft, pipeline };
}

export async function refineDraftFromExisting(
  input: RefineDraftFromExistingInput,
): Promise<PersistedDraftGeneration> {
  const refinedSource = `Original draft: "${input.existing.content}"\n\nRefinement instruction: ${input.instruction}`;

  const pipeline = await withTimeout(
    runGenerationPipeline({
      userId: input.userId,
      sourceContent: refinedSource,
      sourceType: "MANUAL",
      blendId: input.existing.blendId ?? undefined,
      feedback: input.instruction,
    }),
    ROUTE_TIMEOUT_MS,
    input.timeoutLabel ?? "draft-refinement",
  );

  const content = normalizeGeneratedTweet(pipeline.ctx.generatedContent ?? "");

  const draft = await prisma.tweetDraft.create({
    data: {
      userId: input.userId,
      content,
      sourceType: input.existing.sourceType,
      sourceContent: input.existing.sourceContent,
      blendId: input.existing.blendId,
      confidence: pipeline.ctx.confidence,
      predictedEngagement: pipeline.ctx.predictedEngagement,
      version: input.existing.version + 1,
      feedback: input.instruction,
    },
  });

  await prisma.analyticsEvent.create({
    data: { userId: input.userId, type: "DRAFT_CREATED" },
  });
  await prisma.analyticsEvent.create({
    data: { userId: input.userId, type: "FEEDBACK_GIVEN" },
  });

  pipeline.ctx.generatedContent = content;

  return { draft, pipeline };
}

export async function refineLatestDraftForUser(
  input: RefineLatestDraftForUserInput,
): Promise<PersistedDraftGeneration> {
  const existing = await prisma.tweetDraft.findFirst({
    where: { userId: input.userId },
    orderBy: { createdAt: "desc" },
  });

  if (!existing) {
    throw new Error("Draft not found");
  }

  return refineDraftFromExisting({
    userId: input.userId,
    existing,
    instruction: input.instruction,
    timeoutLabel: input.timeoutLabel ?? "telegram-refine",
  });
}
