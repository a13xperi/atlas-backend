import { prisma } from "./prisma";
import { runGenerationPipeline } from "./pipeline";
import { logger } from "./logger";
import { normalizeGeneratedTweet } from "./draft-generation";
import type { Insight } from "./content-extraction";

export interface BatchDraft {
  id: string;
  content: string;
  angle: string;
  score: number;
  qualityScore: number;
  status: "DRAFT";
}

export interface BatchResult {
  drafts: BatchDraft[];
  campaign?: { id: string; title: string };
}

interface BatchOptions {
  userId: string;
  insights: Insight[];
  sourceContent: string;
  sourceType: string;
  sourceUrl?: string;
  tone?: string;
  createCampaign?: boolean;
  campaignTitle?: string;
  campaignDescription?: string;
}

function computeScore(confidence: number, predictedEngagement: number): number {
  const engagementFactor = Math.min(Math.max(predictedEngagement, 0) / 2500, 1);
  return Math.round((confidence * 0.7 + engagementFactor * 0.3) * 100) / 100;
}

function buildInsightSource(insight: Insight, sourceContent: string, index: number, total: number): string {
  return [
    `[Insight ${index + 1}/${total}: ${insight.title}]`,
    `Angle: ${insight.angle}`,
    `Summary: ${insight.summary}`,
    `Key quote: "${insight.keyQuote}"`,
    "",
    "Full source context (background only; prioritize the insight above):",
    sourceContent.slice(0, 10_000),
  ].join("\n");
}

function buildAngleInstruction(insight: Insight, tone?: string): string {
  const instructions = [
    `Focus on the "${insight.angle}" angle.`,
    `Center the tweet on this thesis: ${insight.summary}`,
  ];

  if (tone) {
    instructions.push(`Match a ${tone} tone while staying faithful to the user's voice profile.`);
  }

  return instructions.join(" ");
}

function defaultCampaignTitle(sourceType: string): string {
  const day = new Date().toISOString().split("T")[0];
  return `${sourceType} Campaign - ${day}`;
}

export async function batchGenerateDrafts(options: BatchOptions): Promise<BatchResult> {
  const {
    userId,
    insights,
    sourceContent,
    sourceType,
    sourceUrl,
    tone,
    createCampaign,
    campaignTitle,
    campaignDescription,
  } = options;

  let campaign: { id: string; title: string } | undefined;
  if (createCampaign) {
    const created = await prisma.campaign.create({
      data: {
        userId,
        name: campaignTitle || defaultCampaignTitle(sourceType),
        description:
          campaignDescription ||
          (sourceUrl
            ? `Generated from ${sourceUrl}`
            : `Batch generated from ${sourceType.toLowerCase()} content`),
      },
    });
    campaign = { id: created.id, title: created.name };
  }

  const drafts: BatchDraft[] = [];

  for (const [index, insight] of insights.entries()) {
    try {
      const result = await runGenerationPipeline({
        userId,
        sourceContent: buildInsightSource(insight, sourceContent, index, insights.length),
        sourceType,
        angleInstruction: buildAngleInstruction(insight, tone),
      });

      if (!result.ctx.generatedContent) {
        logger.warn({ insight: insight.title, index }, "Pipeline returned no content for insight");
        continue;
      }

      const normalizedContent = normalizeGeneratedTweet(result.ctx.generatedContent);
      const confidence = result.ctx.confidence ?? 0.5;
      const predictedEngagement = result.ctx.predictedEngagement ?? 1000;
      const score = computeScore(confidence, predictedEngagement);

      const draft = await prisma.tweetDraft.create({
        data: {
          userId,
          content: normalizedContent,
          sourceType: sourceType as any,
          sourceContent: buildInsightSource(insight, sourceContent, index, insights.length).slice(0, 50_000),
          confidence,
          predictedEngagement,
          campaignId: campaign?.id,
          sortOrder: campaign ? index + 1 : null,
          version: 1,
        },
      });

      await prisma.analyticsEvent.create({
        data: {
          userId,
          type: "DRAFT_CREATED",
          metadata: {
            batchGeneration: true,
            insightAngle: insight.angle,
            insightTitle: insight.title,
            campaignId: campaign?.id,
          },
        },
      });

      drafts.push({
        id: draft.id,
        content: draft.content,
        angle: insight.angle,
        score,
        qualityScore: Math.round(score * 1000) / 10,
        status: "DRAFT",
      });
    } catch (err: any) {
      logger.error(
        { insight: insight.title, index, err: err.message },
        "Failed to generate draft for insight",
      );
    }
  }

  if (drafts.length === 0) {
    if (campaign) {
      await prisma.campaign.delete({ where: { id: campaign.id } }).catch((err: any) => {
        logger.warn({ campaignId: campaign?.id, err: err.message }, "Failed to clean up empty campaign");
      });
    }
    throw new Error("Failed to generate any drafts from the provided insights");
  }

  return { drafts, campaign };
}
