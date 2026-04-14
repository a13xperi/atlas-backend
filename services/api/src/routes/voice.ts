import { Router } from "express";
import { z } from "zod";
import { VoiceMaturity } from "@prisma/client";
import { parsePagination } from "../lib/pagination";
import { prisma } from "../lib/prisma";
import { withSafeReferenceVoice } from "../lib/reference-accounts";
import { error, success } from "../lib/response";
import { authenticate, AuthRequest } from "../middleware/auth";
import { fetchTweetsByHandle } from "../lib/twitter";
import { calibrateFromTweets, type CalibrationResult } from "../lib/calibrate";
import { getVoiceInsights } from "../lib/voice-insights";
import { blendVoices } from "../lib/voice-blend";
import { logger } from "../lib/logger";

// Public router — no auth required
export const referenceAccountsRouter = Router();

referenceAccountsRouter.get("/reference-accounts", async (_req, res) => {
  try {
    const accounts = await prisma.referenceVoice.findMany({
      where: { isGlobal: true, isActive: true },
      include: { voiceProfile: true },
      orderBy: [{ category: "asc" }, { name: "asc" }],
    });
    res.json(success({ accounts: accounts.map(formatReferenceAccount) }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to load reference accounts");
    res.status(500).json(error("Failed to load reference accounts"));
  }
});

const referenceAccountSeedSchema = z.object({
  handle: z.string().min(1).max(50),
});

referenceAccountsRouter.post("/reference-accounts/seed", async (req, res) => {
  try {
    const body = referenceAccountSeedSchema.parse(req.body);
    const normalizedHandle = normalizeReferenceHandle(body.handle);
    const { user: twitterUser, tweets } = await fetchTweetsByHandle(normalizedHandle, 30);

    if (tweets.length === 0) {
      return res.status(400).json(error(`No tweets found for @${normalizedHandle}`));
    }

    const calibration = await calibrateFromTweets(tweets.map((tweet) => tweet.text));
    const sampleTweets = tweets.slice(0, 5).map((tweet) => tweet.text);

    const existingAccount = await prisma.referenceVoice.findFirst({
      where: {
        isGlobal: true,
        OR: [{ handle: normalizedHandle }, { handle: `@${normalizedHandle}` }],
      },
    });

    const account = existingAccount
      ? await prisma.referenceVoice.update({
          where: { id: existingAccount.id },
          data: {
            name: twitterUser.name,
            handle: normalizedHandle,
            avatarUrl: twitterUser.profile_image_url ?? null,
            isGlobal: true,
            isActive: true,
          },
        })
      : await prisma.referenceVoice.create({
          data: {
            name: twitterUser.name,
            handle: normalizedHandle,
            avatarUrl: twitterUser.profile_image_url ?? null,
            isGlobal: true,
            isActive: true,
          },
        });

    const voiceProfile = await prisma.referenceVoiceProfile.upsert({
      where: { referenceVoiceId: account.id },
      update: buildReferenceVoiceProfileData(calibration, sampleTweets),
      create: {
        referenceVoiceId: account.id,
        ...buildReferenceVoiceProfileData(calibration, sampleTweets),
      },
    });

    res.json(success(formatReferenceAccount({ ...account, voiceProfile })));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }

    logger.error({ err: err.message }, "Failed to seed reference account");
    res.status(502).json(error("Failed to seed reference account"));
  }
});

export const voiceRouter = Router();
voiceRouter.use(authenticate);

const profileSchema = z.object({
  humor: z.number().min(0).max(100).optional(),
  formality: z.number().min(0).max(100).optional(),
  brevity: z.number().min(0).max(100).optional(),
  contrarianTone: z.number().min(0).max(100).optional(),
  directness: z.number().min(0).max(100).optional(),
  warmth: z.number().min(0).max(100).optional(),
  technicalDepth: z.number().min(0).max(100).optional(),
  confidence: z.number().min(0).max(100).optional(),
  evidenceOrientation: z.number().min(0).max(100).optional(),
  solutionOrientation: z.number().min(0).max(100).optional(),
  socialPosture: z.number().min(0).max(100).optional(),
  selfPromotionalIntensity: z.number().min(0).max(100).optional(),
});

type ProfileInput = z.infer<typeof profileSchema>;

function buildVoiceProfileData(body: ProfileInput) {
  return {
    ...(body.humor !== undefined && { humor: body.humor }),
    ...(body.formality !== undefined && { formality: body.formality }),
    ...(body.brevity !== undefined && { brevity: body.brevity }),
    ...(body.contrarianTone !== undefined && { contrarianTone: body.contrarianTone }),
    ...(body.directness !== undefined && { directness: body.directness }),
    ...(body.warmth !== undefined && { warmth: body.warmth }),
    ...(body.technicalDepth !== undefined && { technicalDepth: body.technicalDepth }),
    ...(body.confidence !== undefined && { confidence: body.confidence }),
    ...(body.evidenceOrientation !== undefined && { evidenceOrientation: body.evidenceOrientation }),
    ...(body.solutionOrientation !== undefined && { solutionOrientation: body.solutionOrientation }),
    ...(body.socialPosture !== undefined && { socialPosture: body.socialPosture }),
    ...(body.selfPromotionalIntensity !== undefined && {
      selfPromotionalIntensity: body.selfPromotionalIntensity,
    }),
  };
}

function normalizeReferenceHandle(handle: string) {
  return handle.replace(/^@/, "").trim().toLowerCase();
}

function resolveVoiceMaturity(tweetsAnalyzed: number) {
  if (tweetsAnalyzed >= 100) return VoiceMaturity.ADVANCED;
  if (tweetsAnalyzed >= 20) return VoiceMaturity.INTERMEDIATE;
  return VoiceMaturity.BEGINNER;
}

function buildCalibrationDimensions(calibration: CalibrationResult) {
  return {
    humor: calibration.humor,
    formality: calibration.formality,
    brevity: calibration.brevity,
    contrarianTone: calibration.contrarianTone,
    directness: calibration.directness,
    warmth: calibration.warmth,
    technicalDepth: calibration.technicalDepth,
    confidence: calibration.confidence,
    evidenceOrientation: calibration.evidenceOrientation,
    solutionOrientation: calibration.solutionOrientation,
    socialPosture: calibration.socialPosture,
    selfPromotionalIntensity: calibration.selfPromotionalIntensity,
  };
}

function buildVoiceProfileUpdate(calibration: CalibrationResult) {
  return {
    ...buildCalibrationDimensions(calibration),
    tweetsAnalyzed: calibration.tweetsAnalyzed,
    maturity: resolveVoiceMaturity(calibration.tweetsAnalyzed),
    // Persist the natural language voice summary so the tweet prompt can inject it
    analysis: calibration.analysis,
  };
}

function buildReferenceVoiceProfileData(
  calibration: CalibrationResult,
  sampleTweets: string[],
) {
  return {
    ...buildCalibrationDimensions(calibration),
    calibrationConfidence: calibration.calibrationConfidence,
    analysis: calibration.analysis,
    tweetsAnalyzed: calibration.tweetsAnalyzed,
    sampleTweets,
  };
}

type ReferenceVoiceProfileSnapshot = {
  humor: number;
  formality: number;
  brevity: number;
  contrarianTone: number;
  directness: number;
  warmth: number;
  technicalDepth: number;
  confidence: number;
  evidenceOrientation: number;
  solutionOrientation: number;
  socialPosture: number;
  selfPromotionalIntensity: number;
  calibrationConfidence: number | null;
  analysis: string | null;
  tweetsAnalyzed: number;
  sampleTweets: string[];
};

function formatReferenceVoiceProfile(profile: ReferenceVoiceProfileSnapshot | null) {
  if (!profile) {
    return null;
  }

  return {
    humor: profile.humor,
    formality: profile.formality,
    brevity: profile.brevity,
    contrarianTone: profile.contrarianTone,
    directness: profile.directness,
    warmth: profile.warmth,
    technicalDepth: profile.technicalDepth,
    confidence: profile.confidence,
    evidenceOrientation: profile.evidenceOrientation,
    solutionOrientation: profile.solutionOrientation,
    socialPosture: profile.socialPosture,
    selfPromotionalIntensity: profile.selfPromotionalIntensity,
    calibrationConfidence: profile.calibrationConfidence,
    analysis: profile.analysis,
    tweetsAnalyzed: profile.tweetsAnalyzed,
  };
}

function formatReferenceAccount(account: {
  id: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  category: string | null;
  voiceProfile: ReferenceVoiceProfileSnapshot | null;
}) {
  return {
    id: account.id,
    handle: account.handle ?? undefined,
    displayName: account.name,
    name: account.name,
    avatarUrl: account.avatarUrl ?? undefined,
    category: account.category ?? undefined,
    voiceProfile: formatReferenceVoiceProfile(account.voiceProfile),
    sampleTweets: account.voiceProfile?.sampleTweets ?? [],
  };
}

const referenceSchema = z.object({
  name: z.string().min(1),
  handle: z.string().optional(),
  avatarUrl: z.string().optional(),
});

const blendVoiceSchema = z.union([
  z.object({
    referenceId: z.string().min(1),
    weight: z.number().min(0).max(100),
  }),
  z.object({
    label: z.string().min(1),
    percentage: z.number().min(0).max(100),
    referenceVoiceId: z.string().min(1).optional(),
  }),
]).transform((voice) => {
  if ("label" in voice) {
    const legacyVoice = voice as {
      label: string;
      percentage: number;
      referenceVoiceId?: string;
    };

    return {
      label: legacyVoice.label,
      percentage: legacyVoice.percentage,
      referenceVoiceId: legacyVoice.referenceVoiceId,
    };
  }

  const weightedVoice = voice as {
    referenceId: string;
    weight: number;
  };

  return {
    label: weightedVoice.referenceId,
    percentage: weightedVoice.weight,
    referenceVoiceId: weightedVoice.referenceId,
  };
});

const blendSchema = z.object({
  name: z.string().min(1),
  voices: z.array(blendVoiceSchema).min(1),
});

const updateBlendVoiceSchema = z.object({
  label: z.string().min(1).optional(),
  percentage: z.number().min(0).max(100).optional(),
  referenceVoiceId: z.string().min(1).nullable().optional(),
});

// Get voice profile
voiceRouter.get("/profile", async (req: AuthRequest, res) => {
  try {
    const profile = await prisma.voiceProfile.findUnique({
      where: { userId: req.userId },
    });
    if (!profile) return res.status(404).json(error("Voice profile not found"));
    res.json(success({ profile }));
  } catch (err: any) {
    res.status(500).json(error("Failed to load voice profile"));
  }
});

// Get voice profile via collection endpoint
voiceRouter.get("/profiles", async (req: AuthRequest, res) => {
  try {
    const profile = await prisma.voiceProfile.findUnique({
      where: { userId: req.userId },
    });
    if (!profile) return res.status(404).json(error("Voice profile not found"));
    res.json(success({ profile }));
  } catch (err: any) {
    res.status(500).json(error("Failed to load voice profile"));
  }
});

// Create or replace the current user's voice profile dimensions
voiceRouter.post("/profiles", async (req: AuthRequest, res) => {
  try {
    const body = profileSchema.parse(req.body);
    const data = buildVoiceProfileData(body);

    const profile = await prisma.voiceProfile.upsert({
      where: { userId: req.userId },
      update: data,
      create: {
        userId: req.userId!,
        ...data,
      },
    });

    res.json(success({ profile }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to save voice profile"));
  }
});

// Update voice dimensions
voiceRouter.patch("/profile", async (req: AuthRequest, res) => {
  try {
    const body = profileSchema.parse(req.body);

    const profile = await prisma.voiceProfile.update({
      where: { userId: req.userId },
      data: buildVoiceProfileData(body),
    });

    res.json(success({ profile }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to update voice profile"));
  }
});

// Update voice dimensions by profile ID
voiceRouter.patch("/profiles/:id", async (req: AuthRequest, res) => {
  try {
    const profileId = req.params.id as string;
    const body = profileSchema.parse(req.body);

    const existingProfile = await prisma.voiceProfile.findFirst({
      where: { id: profileId, userId: req.userId },
    });
    if (!existingProfile) return res.status(404).json(error("Voice profile not found"));

    const profile = await prisma.voiceProfile.update({
      where: { id: profileId },
      data: buildVoiceProfileData(body),
    });

    res.json(success({ profile }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to update voice profile"));
  }
});

// List reference voices
voiceRouter.get("/references", async (req: AuthRequest, res) => {
  try {
    const { take, skip } = parsePagination(req.query, { limit: 20, offset: 0 });

    const voices = await prisma.referenceVoice.findMany({
      where: { userId: req.userId, isActive: true },
      take,
      skip,
    });
    res.json(success({ voices }));
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to load reference voices");
    res.status(500).json(error("Failed to load reference voices", 500, { message: err.message }));
  }
});

// Add reference voice
voiceRouter.post("/references", async (req: AuthRequest, res) => {
  try {
    const body = referenceSchema.parse(req.body);

    const voice = await prisma.referenceVoice.create({
      data: { userId: req.userId!, name: body.name, handle: body.handle, avatarUrl: body.avatarUrl },
    });
    res.json(success({ voice }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      if (req.body?.name === undefined) {
        return res.status(400).json(error("Name is required"));
      }
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to create reference voice"));
  }
});

// List saved blends
voiceRouter.get("/blends", async (req: AuthRequest, res) => {
  try {
    const { take, skip } = parsePagination(req.query, { limit: 20, offset: 0 });

    const [user, blends] = await Promise.all([
      prisma.user.findUnique({
        where: { id: req.userId },
        select: { id: true, displayName: true, handle: true, avatarUrl: true },
      }),
      prisma.savedBlend.findMany({
        where: { userId: req.userId },
        take,
        skip,
        include: { voices: { include: { referenceVoice: true } } },
      }),
    ]);

    const fallbackUser = user ?? {
      id: req.userId!,
      displayName: null,
      handle: null,
      avatarUrl: null,
    };

    res.json(
      success({
        blends: blends.map((blend) => ({
          ...blend,
          voices: blend.voices.map((voice) => withSafeReferenceVoice(voice, fallbackUser)),
        })),
      }),
    );
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to load blends");
    res.status(500).json(error("Failed to load blends", 500, { message: err.message }));
  }
});

// Create blend
voiceRouter.post("/blends", async (req: AuthRequest, res) => {
  try {
    const body = blendSchema.parse(req.body);

    const blend = await prisma.savedBlend.create({
      data: {
        userId: req.userId!,
        name: body.name,
        voices: {
          create: body.voices.map((voice) => ({
            label: voice.label,
            percentage: voice.percentage,
            referenceVoiceId: voice.referenceVoiceId,
          })),
        },
      },
      include: { voices: true },
    });

    res.json(success({ blend }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to create blend"));
  }
});

// Update a voice in a blend
voiceRouter.patch("/blends/:blendId/voices/:voiceId", async (req: AuthRequest, res) => {
  try {
    const blendId = req.params.blendId as string;
    const voiceId = req.params.voiceId as string;
    const body = updateBlendVoiceSchema.parse(req.body);

    const blend = await prisma.savedBlend.findFirst({
      where: { id: blendId, userId: req.userId },
    });
    if (!blend) return res.status(404).json(error("Blend not found"));

    const voice = await prisma.blendVoice.findFirst({
      where: { id: voiceId, blendId },
    });
    if (!voice) return res.status(404).json(error("Voice not found in blend"));

    const updated = await prisma.blendVoice.update({
      where: { id: voiceId },
      data: {
        ...(body.label !== undefined && { label: body.label }),
        ...(body.percentage !== undefined && { percentage: body.percentage }),
        ...(body.referenceVoiceId !== undefined && { referenceVoiceId: body.referenceVoiceId }),
      },
      include: { referenceVoice: true },
    });

    res.json(success({ voice: updated }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    res.status(500).json(error("Failed to update blend voice"));
  }
});

// Remove a voice from a blend
voiceRouter.delete("/blends/:blendId/voices/:voiceId", async (req: AuthRequest, res) => {
  try {
    const blendId = req.params.blendId as string;
    const voiceId = req.params.voiceId as string;

    const blend = await prisma.savedBlend.findFirst({
      where: { id: blendId, userId: req.userId },
    });
    if (!blend) return res.status(404).json(error("Blend not found"));

    const voice = await prisma.blendVoice.findFirst({
      where: { id: voiceId, blendId },
    });
    if (!voice) return res.status(404).json(error("Voice not found in blend"));

    await prisma.blendVoice.delete({ where: { id: voiceId } });
    res.json(success({ success: true }));
  } catch (err: any) {
    res.status(500).json(error("Failed to delete blend voice"));
  }
});

// Calibrate voice profile from a Twitter handle's tweets
const calibrateSchema = z.object({
  handle: z.string().min(1).max(50),
});

voiceRouter.post("/calibrate", async (req: AuthRequest, res) => {
  try {
    const body = calibrateSchema.parse(req.body);
    const normalizedHandle = normalizeReferenceHandle(body.handle);

    // Fetch tweets from Twitter/X
    const { user: twitterUser, tweets } = await fetchTweetsByHandle(normalizedHandle);

    if (tweets.length === 0) {
      return res.status(400).json(error(`No tweets found for @${normalizedHandle}`));
    }

    // Claude calibration can take tens of seconds on larger tweet sets, so Railway deploys
    // need RAILWAY_SERVICE_TIMEOUT=90000 for this endpoint.
    const calibration = await calibrateFromTweets(tweets.map((t) => t.text));

    // Update voice profile with all 12 calibrated dimensions
    const dimensionData = buildVoiceProfileUpdate(calibration);

    const profile = await prisma.voiceProfile.upsert({
      where: { userId: req.userId! },
      update: dimensionData,
      create: { userId: req.userId!, ...dimensionData },
    });

    // Log analytics
    await prisma.analyticsEvent.create({
      data: { userId: req.userId!, type: "VOICE_REFINEMENT" },
    });

    res.json(success({
      profile,
      calibration: {
        confidence: calibration.calibrationConfidence,
        analysis: calibration.analysis,
        tweetsAnalyzed: calibration.tweetsAnalyzed,
        twitterUser: { username: twitterUser.username, name: twitterUser.name },
      },
    }));
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    logger.error({ err: err.message }, "Calibration failed");
    // Surface Twitter API errors to the client so the frontend can show a useful message
    const msg = err.message ?? "";
    if (msg.includes("429")) return res.status(429).json(error(`Twitter API rate limit: ${msg}`));
    if (msg.includes("404") || msg.includes("not found")) return res.status(404).json(error(msg));
    if (msg.includes("403")) return res.status(403).json(error(msg));
    res.status(502).json(error(`Voice calibration failed: ${msg}`));
  }
});

// Get voice dimension insights (engagement feedback loop)
voiceRouter.get("/insights", async (req: AuthRequest, res) => {
  try {
    const insights = await getVoiceInsights(req.userId!);

    if (!insights) {
      return res.status(200).json(
        success({
          insights: null,
          status: "insufficient_data",
          message:
            "Need at least 10 posted drafts with engagement data to generate insights. Keep posting!",
        }),
      );
    }

    res.json(
      success({
        insights,
        status: "ready",
      }),
    );
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to compute voice insights");
    res.status(500).json(error("Failed to compute voice insights"));
  }
});

// --- Voice Blending Engine (primary + secondary weighting) ---

const voiceBlendSchema = z.object({
  primary_id: z.string().min(1, "primary_id is required"),
  additional_ids: z.array(z.string().min(1)).default([]),
  weights: z
    .record(z.string(), z.number().min(0).max(1))
    .optional(),
});

/**
 * POST /api/voice/blend
 *
 * Blend voice inspirations from Twitter profiles into a unified voice profile.
 * Fetches tweets from each inspiration, analyzes writing style, and produces
 * weighted blended dimensions. Stores the result per user.
 *
 * Body: { primary_id, additional_ids?, weights? }
 */
voiceRouter.post("/blend", async (req: AuthRequest, res) => {
  try {
    const body = voiceBlendSchema.parse(req.body);

    logger.info(
      {
        userId: req.userId,
        primaryId: body.primary_id,
        additionalCount: body.additional_ids.length,
      },
      "Starting voice blend",
    );

    // Run the blend engine
    const result = await blendVoices(
      body.primary_id,
      body.additional_ids,
      body.weights,
    );

    // Persist the blended profile
    const profileData = {
      primaryTwitterId: body.primary_id,
      primaryHandle:
        result.inspirationProfiles.find(
          (p) => p.twitterId === body.primary_id,
        )?.handle ?? null,
      additionalTwitterIds: body.additional_ids,
      additionalHandles: result.inspirationProfiles
        .filter((p) => p.twitterId !== body.primary_id)
        .map((p) => p.handle),
      weights: result.appliedWeights as any,
      humor: result.dimensions.humor,
      formality: result.dimensions.formality,
      brevity: result.dimensions.brevity,
      contrarianTone: result.dimensions.contrarianTone,
      directness: result.dimensions.directness,
      warmth: result.dimensions.warmth,
      technicalDepth: result.dimensions.technicalDepth,
      confidence: result.dimensions.confidence,
      evidenceOrientation: result.dimensions.evidenceOrientation,
      solutionOrientation: result.dimensions.solutionOrientation,
      socialPosture: result.dimensions.socialPosture,
      selfPromotionalIntensity: result.dimensions.selfPromotionalIntensity,
      styleSignals: result.styleSignals as any,
      tweetsAnalyzed: result.totalTweetsAnalyzed,
      blendSummary: result.summary,
    };

    const blendedProfile = await prisma.blendedVoiceProfile.upsert({
      where: { userId: req.userId! },
      update: profileData,
      create: { userId: req.userId!, ...profileData },
    });

    // Also update the main voice profile so tweet generation uses blended values
    await prisma.voiceProfile.upsert({
      where: { userId: req.userId! },
      update: {
        humor: result.dimensions.humor,
        formality: result.dimensions.formality,
        brevity: result.dimensions.brevity,
        contrarianTone: result.dimensions.contrarianTone,
        directness: result.dimensions.directness,
        warmth: result.dimensions.warmth,
        technicalDepth: result.dimensions.technicalDepth,
        confidence: result.dimensions.confidence,
        evidenceOrientation: result.dimensions.evidenceOrientation,
        solutionOrientation: result.dimensions.solutionOrientation,
        socialPosture: result.dimensions.socialPosture,
        selfPromotionalIntensity: result.dimensions.selfPromotionalIntensity,
        tweetsAnalyzed: result.totalTweetsAnalyzed,
        maturity:
          result.totalTweetsAnalyzed >= 100
            ? VoiceMaturity.ADVANCED
            : result.totalTweetsAnalyzed >= 20
              ? VoiceMaturity.INTERMEDIATE
              : VoiceMaturity.BEGINNER,
      },
      create: {
        userId: req.userId!,
        humor: result.dimensions.humor,
        formality: result.dimensions.formality,
        brevity: result.dimensions.brevity,
        contrarianTone: result.dimensions.contrarianTone,
        directness: result.dimensions.directness,
        warmth: result.dimensions.warmth,
        technicalDepth: result.dimensions.technicalDepth,
        confidence: result.dimensions.confidence,
        evidenceOrientation: result.dimensions.evidenceOrientation,
        solutionOrientation: result.dimensions.solutionOrientation,
        socialPosture: result.dimensions.socialPosture,
        selfPromotionalIntensity: result.dimensions.selfPromotionalIntensity,
        tweetsAnalyzed: result.totalTweetsAnalyzed,
        maturity:
          result.totalTweetsAnalyzed >= 100
            ? VoiceMaturity.ADVANCED
            : result.totalTweetsAnalyzed >= 20
              ? VoiceMaturity.INTERMEDIATE
              : VoiceMaturity.BEGINNER,
      },
    });

    // Log analytics event
    await prisma.analyticsEvent.create({
      data: { userId: req.userId!, type: "VOICE_REFINEMENT" },
    });

    res.json(
      success({
        blendedProfile,
        inspirations: result.inspirationProfiles.map((p) => ({
          twitterId: p.twitterId,
          handle: p.handle,
          name: p.name,
          tweetCount: p.tweetCount,
          weight: result.appliedWeights[p.twitterId],
        })),
        dimensions: result.dimensions,
        styleSignals: result.styleSignals,
        summary: result.summary,
      }),
    );
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(error("Invalid request", 400, err.errors));
    }
    logger.error({ err: err.message, userId: req.userId }, "Voice blend failed");
    res.status(502).json(error(`Voice blend failed: ${err.message}`));
  }
});

/**
 * GET /api/voice/blended-profile
 *
 * Returns the current user's stored blended voice profile,
 * including the source inspirations, weights, and blended dimensions.
 */
voiceRouter.get("/blended-profile", async (req: AuthRequest, res) => {
  try {
    const profile = await prisma.blendedVoiceProfile.findUnique({
      where: { userId: req.userId! },
    });

    if (!profile) {
      return res.status(404).json(
        error("No blended voice profile found. Use POST /api/voice/blend to create one."),
      );
    }

    res.json(
      success({
        profile: {
          id: profile.id,
          primaryTwitterId: profile.primaryTwitterId,
          primaryHandle: profile.primaryHandle,
          additionalTwitterIds: profile.additionalTwitterIds,
          additionalHandles: profile.additionalHandles,
          weights: profile.weights,
          dimensions: {
            humor: profile.humor,
            formality: profile.formality,
            brevity: profile.brevity,
            contrarianTone: profile.contrarianTone,
            directness: profile.directness,
            warmth: profile.warmth,
            technicalDepth: profile.technicalDepth,
            confidence: profile.confidence,
            evidenceOrientation: profile.evidenceOrientation,
            solutionOrientation: profile.solutionOrientation,
            socialPosture: profile.socialPosture,
            selfPromotionalIntensity: profile.selfPromotionalIntensity,
          },
          styleSignals: profile.styleSignals,
          tweetsAnalyzed: profile.tweetsAnalyzed,
          blendSummary: profile.blendSummary,
          createdAt: profile.createdAt,
          updatedAt: profile.updatedAt,
        },
      }),
    );
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to load blended voice profile");
    res.status(500).json(error("Failed to load blended voice profile"));
  }
});
