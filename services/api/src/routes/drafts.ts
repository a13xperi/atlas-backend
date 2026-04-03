import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { parsePagination } from "../lib/pagination";
import { error, success } from "../lib/response";
import { authenticate, AuthRequest } from "../middleware/auth";
import { runGenerationPipeline } from "../lib/pipeline";
import { conductResearch, type ResearchResult } from "../lib/research";
import { logger } from "../lib/logger";
import { withTimeout, TimeoutError } from "../lib/timeout";

export const draftsRouter = Router();
draftsRouter.use(authenticate);

// --- AI Generation Endpoints (must be before /:id routes) ---

const generateSchema = z.object({
  sourceContent: z.string().min(1).max(10000),
  sourceType: z.enum(["REPORT", "ARTICLE", "TWEET", "TRENDING_TOPIC", "VOICE_NOTE", "MANUAL"]),
  blendId: z.string().optional(),
});

const regenerateSchema = z.object({
  feedback: z.string().max(1000).optional(),
});

const replySchema = z
  .object({
    tweetUrl: z.string().url().optional(),
    tweetText: z.string().trim().min(1).max(10000).optional(),
    angle: z.string().trim().min(1).max(1000).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.tweetUrl && !value.tweetText) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tweetUrl"],
        message: "tweetUrl or tweetText is required",
      });
    }
  });

const fromArticleSchema = z.object({
  articleUrl: z.string().url(),
  articleText: z.string().trim().min(1).max(10000).optional(),
});

const engagementSchema = z.object({
  likes: z.number().int().min(0),
  retweets: z.number().int().min(0),
  impressions: z.number().int().min(0),
});

const createDraftSchema = z.object({
  content: z.string().min(1),
  sourceType: z.enum(["REPORT", "ARTICLE", "TWEET", "TRENDING_TOPIC", "VOICE_NOTE", "MANUAL"]).optional(),
  sourceContent: z.string().optional(),
  blendId: z.string().optional(),
});

const updateDraftSchema = z.object({
  content: z.string().optional(),
  status: z.enum(["DRAFT", "APPROVED", "POSTED", "ARCHIVED"]).optional(),
  feedback: z.string().optional(),
});

type DraftWithTimestamps = {
  status: "DRAFT" | "APPROVED" | "POSTED" | "ARCHIVED";
  createdAt: Date;
  updatedAt: Date;
};

const DRAFT_EDIT_WINDOW_MS = 60_000;
const MAX_POST_LENGTH = 280;
const MAX_ARTICLE_CONTENT_LENGTH = 10_000;

function getLastAction(draft: DraftWithTimestamps): "draft" | "approved" | "posted" | "edited" {
  if (draft.status === "POSTED") return "posted";
  if (draft.status === "APPROVED") return "approved";

  const createdAt = new Date(draft.createdAt).getTime();
  const updatedAt = new Date(draft.updatedAt).getTime();

  if (updatedAt - createdAt > DRAFT_EDIT_WINDOW_MS) {
    return "edited";
  }

  return "draft";
}

function serializeDraft<T extends DraftWithTimestamps>(draft: T): T & { lastAction: ReturnType<typeof getLastAction> } {
  return {
    ...draft,
    lastAction: getLastAction(draft),
  };
}

const updateDraftStatusSchema = z.object({
  status: z
    .string()
    .transform((value) => value.toUpperCase())
    .pipe(z.enum(["DRAFT", "APPROVED", "POSTED", "ARCHIVED"])),
});

const SUPPORTED_TWEET_HOSTS = new Set([
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "x.com",
  "www.x.com",
  "mobile.x.com",
]);

function extractTweetId(tweetUrl: string): string | null {
  try {
    const url = new URL(tweetUrl);
    if (!SUPPORTED_TWEET_HOSTS.has(url.hostname.toLowerCase())) {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    const statusIndex = segments.findIndex((segment) => segment === "status" || segment === "statuses");
    const tweetId = statusIndex >= 0 ? segments[statusIndex + 1] : undefined;

    return tweetId && /^\d+$/.test(tweetId) ? tweetId : null;
  } catch {
    return null;
  }
}

async function fetchTweetText(tweetId: string): Promise<string | null> {
  const bearerToken = process.env.TWITTER_BEARER_TOKEN;
  if (!bearerToken) {
    throw new Error("TWITTER_BEARER_TOKEN not configured");
  }

  const params = new URLSearchParams({
    "tweet.fields": "text",
  });

  const response = await fetch(`https://api.twitter.com/2/tweets/${tweetId}?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Twitter API ${response.status}: ${body}`);
  }

  const data = (await response.json()) as { data?: { text?: string } };
  return data.data?.text?.trim() || null;
}

function buildReplyInstructions(angle?: string): string {
  const instructions = [
    "Reply instructions:",
    "- Write a direct reply to the source tweet, not a standalone tweet or quote-tweet.",
    "- Make the response contextual by engaging the original claim or implication.",
    "- Do not simply restate the source tweet verbatim.",
    "- Keep the response within 280 characters.",
  ];

  if (angle) {
    instructions.push(`- Emphasize this angle: ${angle}`);
  }

  return instructions.join("\n");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function extractArticleText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ARTICLE_CONTENT_LENGTH);
}

async function fetchArticleText(articleUrl: string): Promise<string> {
  const response = await fetch(articleUrl);

  if (!response.ok) {
    throw new Error(`Failed to fetch article (${response.status})`);
  }

  const rawContent = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const articleText = contentType.includes("html")
    ? extractArticleText(rawContent)
    : rawContent.replace(/\s+/g, " ").trim().slice(0, MAX_ARTICLE_CONTENT_LENGTH);

  if (!articleText) {
    throw new Error("Failed to extract article text");
  }

  return articleText;
}

function buildArticleContext(articleUrl: string, research: ResearchResult): string {
  return [
    `Source URL: ${articleUrl}`,
    `Summary: ${research.summary}`,
    research.keyFacts.length > 0 ? `Key facts: ${research.keyFacts.join("; ")}` : undefined,
    `Sentiment: ${research.sentiment}`,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_ARTICLE_CONTENT_LENGTH);
}

function shortenSourceUrl(articleUrl: string): string {
  const url = new URL(articleUrl);
  url.search = "";
  url.hash = "";

  const normalized = url.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function finalizeArticleDraft(content: string, sourceUrl: string): string {
  const normalizedContent = content.replace(/\s+/g, " ").trim();
  const withoutTrailingSource = normalizedContent.endsWith(sourceUrl)
    ? normalizedContent.slice(0, -sourceUrl.length).trim()
    : normalizedContent;
  const separator = withoutTrailingSource ? " " : "";
  const maxContentLength = Math.max(MAX_POST_LENGTH - sourceUrl.length - separator.length, 0);

  let trimmedContent = withoutTrailingSource;
  if (trimmedContent.length > maxContentLength) {
    trimmedContent =
      maxContentLength > 1
        ? `${trimmedContent.slice(0, maxContentLength - 1).trimEnd()}…`
        : "";
  }

  return `${trimmedContent}${separator}${sourceUrl}`.trim();
}

// Generate a tweet from source content using AI
draftsRouter.post("/generate", async (req: AuthRequest, res) => {
  try {
    const body = generateSchema.parse(req.body);

    // Run generation pipeline with 90s route-level timeout (Railway limit is 120s)
    const result = await withTimeout(
      runGenerationPipeline({
        userId: req.userId!,
        sourceContent: body.sourceContent,
        sourceType: body.sourceType,
        blendId: body.blendId,
      }),
      90_000,
      "generate-pipeline",
    );

    // Save as draft
    const draft = await prisma.tweetDraft.create({
      data: {
        userId: req.userId!,
        content: result.ctx.generatedContent!,
        sourceType: body.sourceType,
        sourceContent: body.sourceContent,
        blendId: body.blendId,
        confidence: result.ctx.confidence,
        predictedEngagement: result.ctx.predictedEngagement,
        version: 1,
      },
    });

    // Log analytics
    await prisma.analyticsEvent.create({
      data: { userId: req.userId!, type: "DRAFT_CREATED" },
    });

    res.json(success({ draft: serializeDraft(draft) }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    if (err instanceof TimeoutError) {
      logger.warn({ err: err.message }, "Generate timed out");
      return res.status(504).json(error("Generation timed out — please try again", 504));
    }
    // fetchVoice step throws with this message when profile missing
    if (err.message?.includes("Voice profile not found")) {
      return res.status(400).json(error(err.message, 400));
    }
    logger.error({ err: err.message }, "Generate failed");
    res.status(502).json(error("AI generation failed", 502));
  }
});

draftsRouter.post("/from-article", async (req: AuthRequest, res) => {
  try {
    const body = fromArticleSchema.parse(req.body);

    const result = await withTimeout(
      (async () => {
        const sourceUrl = shortenSourceUrl(body.articleUrl);
        const sourceContent = body.articleText
          ? body.articleText
          : buildArticleContext(
              body.articleUrl,
              await conductResearch({
                query: await fetchArticleText(body.articleUrl),
                context: "ARTICLE",
              }),
            );

        const generation = await runGenerationPipeline({
          userId: req.userId!,
          sourceContent,
          sourceType: "ARTICLE",
        });

        const draft = finalizeArticleDraft(generation.ctx.generatedContent || "", sourceUrl);
        if (!draft) {
          throw new Error("Generated draft was empty");
        }

        return {
          draft,
          sourceUrl,
          characterCount: draft.length,
        };
      })(),
      90_000,
      "from-article-generation",
    );

    res.json(success(result));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    if (err instanceof TimeoutError) {
      logger.warn({ err: err.message }, "Article generation timed out");
      return res.status(504).json(error("Generation timed out — please try again", 504));
    }
    if (err.message?.includes("Voice profile not found")) {
      return res.status(400).json(error(err.message, 400));
    }
    logger.error({ err: err.message }, "Article generation failed");
    res.status(502).json(error("Article generation failed", 502));
  }
});

draftsRouter.post("/reply", async (req: AuthRequest, res) => {
  try {
    const body = replySchema.parse(req.body);

    let originalTweet = body.tweetText;

    if (body.tweetUrl) {
      const tweetId = extractTweetId(body.tweetUrl);

      if (!tweetId) {
        if (!originalTweet) {
          return res.status(400).json(error("Invalid tweet URL", 400));
        }

        logger.warn({ tweetUrl: body.tweetUrl }, "Invalid tweet URL, using fallback tweetText");
      } else {
        try {
          const fetchedTweet = await fetchTweetText(tweetId);
          if (fetchedTweet) {
            originalTweet = fetchedTweet;
          }
        } catch (err: any) {
          logger.warn({ err: err.message, tweetId }, "Failed to fetch tweet, using fallback if provided");
        }
      }
    }

    if (!originalTweet) {
      return res
        .status(502)
        .json(error("Failed to fetch tweet content — provide tweetText as fallback", 502));
    }

    const result = await withTimeout(
      runGenerationPipeline({
        userId: req.userId!,
        sourceContent: originalTweet,
        sourceType: "TWEET",
        feedback: buildReplyInstructions(body.angle),
      }),
      90_000,
      "reply-pipeline",
    );

    const reply = result.ctx.generatedContent!;

    res.json(
      success({
        reply,
        originalTweet,
        characterCount: reply.length,
      }),
    );
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    if (err instanceof TimeoutError) {
      logger.warn({ err: err.message }, "Reply generation timed out");
      return res.status(504).json(error("Generation timed out — please try again", 504));
    }
    if (err.message?.includes("Voice profile not found")) {
      return res.status(400).json(error(err.message, 400));
    }
    logger.error({ err: err.message }, "Reply generation failed");
    res.status(502).json(error("AI reply generation failed", 502));
  }
});

// Regenerate a draft with optional feedback
draftsRouter.post("/:id/regenerate", async (req: AuthRequest, res) => {
  try {
    const body = regenerateSchema.parse(req.body);

    // Fetch the existing draft
    const existing = await prisma.tweetDraft.findFirst({
      where: { id: req.params.id as string, userId: req.userId },
    });
    if (!existing) return res.status(404).json(error("Draft not found", 404));
    if (!existing.sourceContent) {
      return res.status(400).json(error("Cannot regenerate a manual draft without source content", 400));
    }

    // Run generation pipeline with 90s route-level timeout
    const result = await withTimeout(
      runGenerationPipeline({
        userId: req.userId!,
        sourceContent: existing.sourceContent,
        sourceType: existing.sourceType || "MANUAL",
        blendId: existing.blendId || undefined,
        feedback: body.feedback || existing.feedback || undefined,
      }),
      90_000,
      "regenerate-pipeline",
    );

    // Create new draft (preserves version history)
    const draft = await prisma.tweetDraft.create({
      data: {
        userId: req.userId!,
        content: result.ctx.generatedContent!,
        sourceType: existing.sourceType,
        sourceContent: existing.sourceContent,
        blendId: existing.blendId,
        confidence: result.ctx.confidence,
        predictedEngagement: result.ctx.predictedEngagement,
        version: existing.version + 1,
        feedback: body.feedback || existing.feedback,
      },
    });

    // Log analytics
    await prisma.analyticsEvent.create({
      data: { userId: req.userId!, type: "DRAFT_CREATED" },
    });
    if (body.feedback) {
      await prisma.analyticsEvent.create({
        data: { userId: req.userId!, type: "FEEDBACK_GIVEN" },
      });
    }

    res.json(success({ draft: serializeDraft(draft) }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    if (err instanceof TimeoutError) {
      logger.warn({ err: err.message }, "Regenerate timed out");
      return res.status(504).json(error("Generation timed out — please try again", 504));
    }
    if (err.message?.includes("Voice profile not found")) {
      return res.status(400).json(error(err.message, 400));
    }
    logger.error({ err: err.message }, "Regenerate failed");
    res.status(502).json(error("AI generation failed", 502));
  }
});

// Refine a draft with a natural-language instruction
const refineSchema = z.object({
  instruction: z.string().min(1).max(2000),
});

draftsRouter.post("/:id/refine", async (req: AuthRequest, res) => {
  try {
    const body = refineSchema.parse(req.body);

    const existing = await prisma.tweetDraft.findFirst({
      where: { id: req.params.id as string, userId: req.userId },
    });
    if (!existing) return res.status(404).json(error("Draft not found", 404));

    // Run generation pipeline with 90s route-level timeout
    const result = await withTimeout(
      runGenerationPipeline({
        userId: req.userId!,
        sourceContent: existing.sourceContent || existing.content,
        sourceType: existing.sourceType || "MANUAL",
        blendId: existing.blendId || undefined,
        feedback: body.instruction,
      }),
      90_000,
      "refine-pipeline",
    );

    // Update the draft in-place with refined content
    const draft = await prisma.tweetDraft.update({
      where: { id: existing.id },
      data: {
        content: result.ctx.generatedContent!,
        confidence: result.ctx.confidence,
        predictedEngagement: result.ctx.predictedEngagement,
        version: existing.version + 1,
        feedback: body.instruction,
      },
    });

    // Log analytics
    await prisma.analyticsEvent.create({
      data: { userId: req.userId!, type: "VOICE_REFINEMENT" },
    });

    res.json(success({ draft: serializeDraft(draft) }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    if (err instanceof TimeoutError) {
      logger.warn({ err: err.message }, "Refine timed out");
      return res.status(504).json(error("Generation timed out — please try again", 504));
    }
    if (err.message?.includes("Voice profile not found")) {
      return res.status(400).json(error(err.message, 400));
    }
    logger.error({ err: err.message }, "Refine failed");
    res.status(502).json(error("AI refinement failed", 502));
  }
});

// --- Standard CRUD Endpoints ---

// List drafts
draftsRouter.get("/", async (req: AuthRequest, res) => {
  try {
    const { status } = req.query;
    const { take, skip } = parsePagination(req.query, { limit: 20, offset: 0 });

    const drafts = await prisma.tweetDraft.findMany({
      where: {
        userId: req.userId,
        ...(status && { status: status as any }),
      },
      orderBy: { createdAt: "desc" },
      take,
      skip,
    });

    res.json(success({ drafts: drafts.map(serializeDraft) }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to load drafts");
    res.status(500).json(error("Failed to load drafts", 500, { message: err.message }));
  }
});

// Draft stats
draftsRouter.get("/stats", async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;

    const [total, drafts, approved, posted, archived] = await Promise.all([
      prisma.tweetDraft.count({ where: { userId } }),
      prisma.tweetDraft.count({ where: { userId, status: "DRAFT" } }),
      prisma.tweetDraft.count({ where: { userId, status: "APPROVED" } }),
      prisma.tweetDraft.count({ where: { userId, status: "POSTED" } }),
      prisma.tweetDraft.count({ where: { userId, status: "ARCHIVED" } }),
    ]);

    res.json(success({ total, drafts, approved, posted, archived }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to load draft stats");
    res.status(500).json(error("Failed to load draft stats", 500, { message: err.message }));
  }
});

// List recent draft history
draftsRouter.get("/history", async (req: AuthRequest, res) => {
  try {
    const drafts = await prisma.tweetDraft.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        content: true,
        status: true,
        createdAt: true,
      },
    });

    res.json(
      success({
        drafts: drafts.map((draft) => ({
          ...draft,
          characterCount: draft.content.length,
        })),
      }),
    );
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to load draft history");
    res.status(500).json(error("Failed to load draft history", 500, { message: err.message }));
  }
});

// List team drafts (APPROVED + POSTED) — MANAGER/ADMIN only
draftsRouter.get("/team", async (req: AuthRequest, res) => {
  try {
    const { take, skip } = parsePagination(req.query, { limit: 50, offset: 0 });

    const requestingUser = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { role: true },
    });
    if (!requestingUser || requestingUser.role === "ANALYST") {
      return res.status(403).json(error("Manager or Admin role required", 403));
    }

    const drafts = await prisma.tweetDraft.findMany({
      where: { status: { in: ["APPROVED", "POSTED"] } },
      orderBy: { updatedAt: "desc" },
      take,
      skip,
      include: {
        user: { select: { handle: true, displayName: true, avatarUrl: true } },
      },
    });

    // Resolve blend names in one query
    const blendIds = [...new Set(drafts.map((d) => d.blendId).filter(Boolean))] as string[];
    const blends = blendIds.length
      ? await prisma.savedBlend.findMany({
          where: { id: { in: blendIds } },
          select: { id: true, name: true },
        })
      : [];
    const blendMap = Object.fromEntries(blends.map((b) => [b.id, b.name]));

    const result = drafts.map((d) =>
      serializeDraft({
        ...d,
        blendName: d.blendId ? (blendMap[d.blendId] ?? null) : null,
      })
    );

    res.json(success({ drafts: result, total: result.length }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to load team drafts");
    res.status(500).json(error("Failed to load team drafts", 500, { message: err.message }));
  }
});

// Get single draft
draftsRouter.get("/:id", async (req: AuthRequest, res) => {
  try {
    const draft = await prisma.tweetDraft.findFirst({
      where: { id: req.params.id as string, userId: req.userId },
    });
    if (!draft) return res.status(404).json(error("Draft not found", 404));
    res.json(success({ draft: serializeDraft(draft) }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to get draft");
    res.status(500).json(error("Failed to get draft", 500, { message: err.message }));
  }
});

// Create draft (manual or from content source)
draftsRouter.post("/", async (req: AuthRequest, res) => {
  try {
    const body = createDraftSchema.parse(req.body);
    const { content, sourceType, sourceContent, blendId } = body;

    const draft = await prisma.tweetDraft.create({
      data: {
        userId: req.userId!,
        content,
        sourceType,
        sourceContent,
        blendId,
      },
    });

    await prisma.analyticsEvent.create({
      data: { userId: req.userId!, type: "DRAFT_CREATED" },
    });

    res.json(success({ draft: serializeDraft(draft) }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    logger.error({ err: err.message }, "Failed to create draft");
    res.status(500).json(error("Failed to create draft", 500, { message: err.message }));
  }
});

// Update draft (edit content, submit feedback, change status)
draftsRouter.patch("/:id", async (req: AuthRequest, res) => {
  try {
    const { content, status, feedback } = updateDraftSchema.parse(req.body);

    const existing = await prisma.tweetDraft.findFirst({
      where: { id: req.params.id as string, userId: req.userId },
    });
    if (!existing) return res.status(404).json(error("Draft not found", 404));

    const draft = await prisma.tweetDraft.update({
      where: { id: req.params.id as string },
      data: {
        ...(content && { content }),
        ...(status && { status }),
        ...(feedback && { feedback }),
      },
    });

    if (feedback) {
      await prisma.analyticsEvent.create({
        data: { userId: req.userId!, type: "FEEDBACK_GIVEN" },
      });
    }

    if (status === "POSTED") {
      await prisma.analyticsEvent.create({
        data: { userId: req.userId!, type: "DRAFT_POSTED" },
      });
    }

    res.json(success({ draft: serializeDraft(draft) }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    logger.error({ err: err.message }, "Failed to update draft");
    res.status(500).json(error("Failed to update draft", 500, { message: err.message }));
  }
});

// Update draft status only
draftsRouter.patch("/:id/status", async (req: AuthRequest, res) => {
  try {
    const { status } = updateDraftStatusSchema.parse(req.body);

    const existing = await prisma.tweetDraft.findFirst({
      where: { id: req.params.id as string, userId: req.userId },
    });
    if (!existing) return res.status(404).json(error("Draft not found", 404));

    const draft = await prisma.tweetDraft.update({
      where: { id: req.params.id as string },
      data: { status },
    });

    if (status === "POSTED") {
      await prisma.analyticsEvent.create({
        data: { userId: req.userId!, type: "DRAFT_POSTED" },
      });
    }

    res.json(success({ draft: serializeDraft(draft) }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    logger.error({ err: err.message }, "Failed to update draft status");
    res.status(500).json(error("Failed to update draft status", 500, { message: err.message }));
  }
});

// Delete draft
draftsRouter.delete("/:id", async (req: AuthRequest, res) => {
  try {
    const existing = await prisma.tweetDraft.findFirst({
      where: { id: req.params.id as string, userId: req.userId },
    });
    if (!existing) return res.status(404).json(error("Draft not found", 404));

    await prisma.tweetDraft.delete({ where: { id: req.params.id as string } });
    res.json(success({ success: true }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to delete draft");
    res.status(500).json(error("Failed to delete draft", 500, { message: err.message }));
  }
});

// Record actual engagement metrics (post-publish feedback loop)
draftsRouter.post("/:id/engagement", async (req: AuthRequest, res) => {
  try {
    const body = engagementSchema.parse(req.body);

    const draft = await prisma.tweetDraft.findFirst({
      where: { id: req.params.id as string, userId: req.userId },
    });
    if (!draft) return res.status(404).json(error("Draft not found", 404));

    if (draft.status !== "POSTED") {
      return res.status(400).json(error("Can only record engagement on posted drafts", 400));
    }

    const updated = await prisma.tweetDraft.update({
      where: { id: draft.id },
      data: {
        actualEngagement: body.impressions,
        engagementMetrics: {
          likes: body.likes,
          retweets: body.retweets,
          impressions: body.impressions,
        },
      },
    });

    await prisma.analyticsEvent.create({
      data: {
        userId: req.userId!,
        type: "ENGAGEMENT_RECORDED",
        value: body.impressions,
        metadata: {
          draftId: draft.id,
          likes: body.likes,
          retweets: body.retweets,
          impressions: body.impressions,
        },
      },
    });

    res.json(success({ draft: serializeDraft(updated) }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to record engagement", 500));
  }
});
