/**
 * Batch Generate — Generate multiple tweet drafts from extracted insights.
 *
 * For each insight, runs the generation pipeline to produce a tweet draft
 * in the user's voice. Optionally groups all drafts into a Campaign.
 */

import { prisma } from "./prisma";
import { runGenerationPipeline } from "./pipeline";
import { logger } from "./logger";
import type { Insight } from "./content-extraction";

export interface BatchDraft {
  id: string;
  content: string;
  angle: string;
  qualityScore: number;
}

export interface BatchResult {
  drafts: BatchDraft[];
  campaign?: { id: string; title: string };
}

interface BatchOptions {
  userId: string;
  insights: Insight[];
  sourceContent: string;
  sourceType: "REPORT" | "ARTICLE";
  sourceUrl?: string;
  voiceProfileId?: string;
  createCampaign?: boolean;
  campaignTitle?: string;
}

/**
 * Generate a tweet draft for each insight, optionally grouped into a campaign.
 */
export async function batchGenerateDrafts(options: BatchOptions): Promise<BatchResult> {
  const {
    userId,
    insights,
    sourceContent,
    sourceType,
    sourceUrl,
    createCampaign,
    campaignTitle,
  } = options;

  // Create campaign first if requested
  let campaign: { id: string; title: string } | undefined;
  if (createCampaign) {
    const title = campaignTitle || `${sourceType} Campaign — ${new Date().toISOString().split("T")[0]}`;
    const created = await prisma.campaign.create({
      data: {
        userId,
        name: title,
        description: sourceUrl
          ? `Generated from ${sourceUrl}`
          : `Batch generated from ${sourceType.toLowerCase()} content`,
      },
    });
    campaign = { id: created.id, title: created.name };
  }

  // Generate a draft for each insight in sequence (to respect rate limits)
  const drafts: BatchDraft[] = [];

  for (let i = 0; i < insights.length; i++) {
    const insight = insights[i];

    try {
      // Build insight-specific source content with angle instruction
      const insightSource = [
        `[Insight ${i + 1}/${insights.length}: ${insight.title}]`,
        `Angle: ${insight.angle}`,
        `Summary: ${insight.summary}`,
        `Key quote: "${insight.keyQuote}"`,
        "",
        "Full source context (use for background, but tweet should focus on the insight above):",
        sourceContent.slice(0, 10_000),
      ].join("\n");

      const result = await runGenerationPipeline({
        userId,
        sourceContent: insightSource,
        sourceType,
        angleInstruction: `Focus on the "${insight.angle}" angle. The tweet should center on: ${insight.summary}`,
      });

      const generatedContent = result.ctx.generatedContent;
      if (!generatedContent) {
        logger.warn({ insight: insight.title, index: i }, "Pipeline returned no content for insight");
        continue;
      }

      // Compute a quality score from confidence and engagement
      const confidence = result.ctx.confidence ?? 0.5;
      const engagement = result.ctx.predictedEngagement ?? 1000;
      const qualityScore = Math.round((confidence * 50 + Math.min(engagement / 200, 50)) * 10) / 10;

      // Save draft to DB
      const draft = await prisma.tweetDraft.create({
        data: {
          userId,
          content: generatedContent,
          sourceType,
          sourceContent: insightSource.slice(0, 50_000),
          confidence,
          predictedEngagement: engagement,
          voiceDimensionsSnapshot: result.ctx.finalVoiceDimensions
            ? (result.ctx.finalVoiceDimensions as any)
            : undefined,
          campaignId: campaign?.id,
          sortOrder: i + 1,
          version: 1,
        },
      });

      // Log analytics event
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
        qualityScore,
      });
    } catch (err: any) {
      logger.error(
        { insight: insight.title, index: i, err: err.message },
        "Failed to generate draft for insight",
      );
      // Continue with remaining insights — partial success is better than full failure
    }
  }

  if (drafts.length === 0) {
    throw new Error("Failed to generate any drafts from the provided insights");
  }

  return { drafts, campaign };
}
