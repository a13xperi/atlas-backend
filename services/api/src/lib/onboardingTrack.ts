import { OnboardingTrack } from "@prisma/client";

/**
 * Normalize an incoming onboardingTrack value (from HTTP body, seed script,
 * or admin tool) into a typed Prisma OnboardingTrack enum value.
 *
 * Accepts: "A", "B", "TRACK_A", "TRACK_B" in any case (with or without
 * surrounding whitespace). Returns null for undefined/null/unrecognized
 * input so callers can cleanly skip the field instead of sending a string
 * that Prisma will reject at runtime.
 */
export function normalizeOnboardingTrack(
  value: unknown,
): OnboardingTrack | null {
  if (typeof value !== "string") return null;

  const v = value.trim().toUpperCase();
  if (v === "A" || v === "TRACK_A") return OnboardingTrack.TRACK_A;
  if (v === "B" || v === "TRACK_B") return OnboardingTrack.TRACK_B;
  return null;
}
