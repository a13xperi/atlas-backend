import { prisma } from "../../prisma";
import type { PipelineStep, VoiceDimensions } from "../types";

/** Numeric dimension keys that can be interpolated via weighted average */
const NUMERIC_DIMENSIONS = [
  "humor",
  "formality",
  "brevity",
  "contrarianTone",
  "directness",
  "warmth",
  "technicalDepth",
  "confidence",
  "evidenceOrientation",
  "solutionOrientation",
  "socialPosture",
  "selfPromotionalIntensity",
] as const;

type NumericDimKey = (typeof NUMERIC_DIMENSIONS)[number];

export const fetchBlendStep: PipelineStep = {
  name: "fetchBlend",
  group: "prepare",
  optional: true,

  async execute(ctx) {
    if (!ctx.blendId) return;

    const blend = await prisma.savedBlend.findFirst({
      where: { id: ctx.blendId, userId: ctx.userId },
      include: { voices: { include: { referenceVoice: true } } },
    });

    if (!blend) return;

    ctx.blendVoices = blend.voices.map((v) => ({
      label: v.referenceVoice?.name || v.label,
      percentage: v.percentage,
    }));

    // --- Algorithmic dimension interpolation ---
    // For each reference voice that has a handle, look up whether a user with
    // that handle exists and has a calibrated voice profile. If so, include
    // that profile's dimensions in the weighted average.
    const handles = blend.voices
      .map((v) => v.referenceVoice?.handle)
      .filter((h): h is string => Boolean(h));

    if (handles.length === 0) return;

    // Batch-fetch users + profiles for all referenced handles
    const users = await prisma.user.findMany({
      where: { handle: { in: handles } },
      include: { voiceProfile: true },
    });

    const profileByHandle = new Map<string, VoiceDimensions>();
    for (const u of users) {
      if (u.voiceProfile) {
        profileByHandle.set(u.handle, u.voiceProfile as unknown as VoiceDimensions);
      }
    }

    // Collect voices that resolved to a profile
    const resolved: { weight: number; profile: VoiceDimensions }[] = [];
    for (const v of blend.voices) {
      const handle = v.referenceVoice?.handle;
      if (handle && profileByHandle.has(handle)) {
        resolved.push({
          weight: v.percentage / 100,
          profile: profileByHandle.get(handle)!,
        });
      }
    }

    if (resolved.length === 0) return;

    // Normalise weights so they sum to 1.0 (in case only some voices resolved)
    const totalWeight = resolved.reduce((s, r) => s + r.weight, 0);
    const blended: Partial<VoiceDimensions> = {};

    for (const key of NUMERIC_DIMENSIONS) {
      const vals = resolved.filter((r) => r.profile[key] != null);
      if (vals.length === 0) continue;

      const sum = vals.reduce(
        (acc, r) => acc + (r.weight / totalWeight) * Number(r.profile[key]),
        0,
      );
      (blended as Record<NumericDimKey, number>)[key] = Math.round(sum * 100) / 100;
    }

    ctx.blendedDimensions = blended;
  },
};
