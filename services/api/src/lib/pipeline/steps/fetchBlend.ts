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

/**
 * Dimensions stored on a mixed scale depending on source:
 *   - Calibration-sourced profiles store these at 0–100
 *   - Manually-set profiles (slider input) store them at 0–10
 * When the blended average is <= 10 for these keys, we assume it came from the
 * 0–10 scale and rescale it to 0–100 so the prompt builder sees a consistent scale.
 */
const EXTENDED_DIMENSIONS: ReadonlySet<NumericDimKey> = new Set([
  "directness",
  "warmth",
  "technicalDepth",
  "confidence",
  "evidenceOrientation",
  "solutionOrientation",
  "socialPosture",
  "selfPromotionalIntensity",
]);

function normalizeHandle(handle?: string | null) {
  return handle?.replace(/^@/, "").trim().toLowerCase() ?? "";
}

export const fetchBlendStep: PipelineStep = {
  name: "fetchBlend",
  group: "prepare",
  optional: true,

  async execute(ctx) {
    if (!ctx.blendId) return;

    let blend;
    try {
      blend = await prisma.savedBlend.findFirst({
        where: { id: ctx.blendId, userId: ctx.userId },
        include: { voices: { include: { referenceVoice: { include: { voiceProfile: true } } } } },
      });
    } catch (err) {
      // DB lookup failed — fall back to base voice and surface a soft warning.
      ctx.blendedDimensions = undefined;
      ctx.blendWarning = "blend_not_found";
      throw err;
    }

    if (!blend || !ctx.voiceProfile) {
      // The user asked for a blend but we couldn't load it. Surface this as a
      // soft warning so the response layer can tell the frontend.
      ctx.blendWarning = "blend_not_found";
      return;
    }

    ctx.blendVoices = blend.voices.map((v) => ({
      label: v.referenceVoice?.name || v.label,
      percentage: v.percentage,
    }));

    const resolved: { weight: number; profile: VoiceDimensions }[] = [];
    const unresolvedHandles = new Set<string>();
    let selfWeight = 0;

    for (const v of blend.voices) {
      if (v.referenceVoice?.voiceProfile) {
        resolved.push({
          weight: v.percentage / 100,
          profile: v.referenceVoice.voiceProfile as unknown as VoiceDimensions,
        });
        continue;
      }

      const normalizedHandle = normalizeHandle(v.referenceVoice?.handle);
      if (normalizedHandle) {
        unresolvedHandles.add(normalizedHandle);
        continue;
      }

      if (!v.referenceVoiceId) {
        selfWeight += v.percentage / 100;
      }
    }

    if (unresolvedHandles.size > 0) {
      const users = await prisma.user.findMany({
        where: { handle: { in: Array.from(unresolvedHandles) } },
        include: { voiceProfile: true },
      });

      const profileByHandle = new Map<string, VoiceDimensions>();
      for (const user of users) {
        if (user.voiceProfile) {
          profileByHandle.set(
            normalizeHandle(user.handle),
            user.voiceProfile as unknown as VoiceDimensions,
          );
        }
      }

      for (const v of blend.voices) {
        const normalizedHandle = normalizeHandle(v.referenceVoice?.handle);
        if (normalizedHandle && profileByHandle.has(normalizedHandle)) {
          resolved.push({
            weight: v.percentage / 100,
            profile: profileByHandle.get(normalizedHandle)!,
          });
        }
      }
    }

    if (selfWeight > 0) {
      resolved.push({
        weight: selfWeight,
        profile: ctx.voiceProfile,
      });
    }

    if (resolved.length === 0) {
      // Blend exists but none of its voices resolved to a profile — fall back
      // to the base voice and warn the caller so the UI can surface it.
      ctx.blendWarning = "blend_not_found";
      return;
    }

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
      let avg = Math.round(sum * 100) / 100;

      // Extended dimensions are stored on a mixed scale: calibration writes
      // 0–100, manual slider writes 0–10. If the weighted average lands <= 10
      // for one of these keys, assume it came from the 0–10 scale and rescale
      // so the prompt builder sees a consistent 0–100 value.
      if (EXTENDED_DIMENSIONS.has(key) && avg <= 10) {
        avg = Math.round(avg * 10 * 100) / 100;
      }

      (blended as Record<NumericDimKey, number>)[key] = avg;
    }

    ctx.blendedDimensions = blended;
  },
};
