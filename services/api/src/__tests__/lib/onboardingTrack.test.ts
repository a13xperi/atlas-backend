import { OnboardingTrack } from "@prisma/client";
import { normalizeOnboardingTrack } from "../../lib/onboardingTrack";

describe("normalizeOnboardingTrack", () => {
  describe("canonical enum values", () => {
    it("accepts TRACK_A", () => {
      expect(normalizeOnboardingTrack("TRACK_A")).toBe(OnboardingTrack.TRACK_A);
    });

    it("accepts TRACK_B", () => {
      expect(normalizeOnboardingTrack("TRACK_B")).toBe(OnboardingTrack.TRACK_B);
    });
  });

  describe("short-form values", () => {
    it('accepts "A" as TRACK_A', () => {
      expect(normalizeOnboardingTrack("A")).toBe(OnboardingTrack.TRACK_A);
    });

    it('accepts "B" as TRACK_B', () => {
      expect(normalizeOnboardingTrack("B")).toBe(OnboardingTrack.TRACK_B);
    });
  });

  describe("case insensitivity (the bug this fixes)", () => {
    it("accepts lowercase track_a", () => {
      expect(normalizeOnboardingTrack("track_a")).toBe(OnboardingTrack.TRACK_A);
    });

    it("accepts lowercase track_b", () => {
      expect(normalizeOnboardingTrack("track_b")).toBe(OnboardingTrack.TRACK_B);
    });

    it("accepts mixed case Track_A", () => {
      expect(normalizeOnboardingTrack("Track_A")).toBe(OnboardingTrack.TRACK_A);
    });

    it('accepts lowercase "a"', () => {
      expect(normalizeOnboardingTrack("a")).toBe(OnboardingTrack.TRACK_A);
    });

    it('accepts lowercase "b"', () => {
      expect(normalizeOnboardingTrack("b")).toBe(OnboardingTrack.TRACK_B);
    });
  });

  describe("whitespace tolerance", () => {
    it("trims surrounding whitespace", () => {
      expect(normalizeOnboardingTrack("  TRACK_A  ")).toBe(
        OnboardingTrack.TRACK_A,
      );
    });

    it("trims mixed-case with whitespace", () => {
      expect(normalizeOnboardingTrack(" track_b ")).toBe(
        OnboardingTrack.TRACK_B,
      );
    });
  });

  describe("invalid input", () => {
    it("returns null for undefined", () => {
      expect(normalizeOnboardingTrack(undefined)).toBeNull();
    });

    it("returns null for null", () => {
      expect(normalizeOnboardingTrack(null)).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(normalizeOnboardingTrack("")).toBeNull();
    });

    it("returns null for unknown strings", () => {
      expect(normalizeOnboardingTrack("TRACK_C")).toBeNull();
      expect(normalizeOnboardingTrack("C")).toBeNull();
      expect(normalizeOnboardingTrack("foo")).toBeNull();
    });

    it("returns null for non-string types", () => {
      expect(normalizeOnboardingTrack(1)).toBeNull();
      expect(normalizeOnboardingTrack({})).toBeNull();
      expect(normalizeOnboardingTrack([])).toBeNull();
      expect(normalizeOnboardingTrack(true)).toBeNull();
    });
  });
});
