/**
 * Prompt builder test suite
 * Tests buildTweetPrompt function and voice dimension helpers
 */

import { buildTweetPrompt } from "../../lib/prompt";

const baseProfile = {
  humor: 50,
  formality: 50,
  brevity: 50,
  contrarianTone: 50,
};

describe("buildTweetPrompt", () => {
  it("returns system and userMessage strings", () => {
    const { system, userMessage } = buildTweetPrompt({
      voiceProfile: baseProfile,
      sourceContent: "Bitcoin hits ATH",
      sourceType: "REPORT",
    });
    expect(typeof system).toBe("string");
    expect(typeof userMessage).toBe("string");
    expect(system.length).toBeGreaterThan(0);
    expect(userMessage).toContain("Bitcoin hits ATH");
  });

  it("includes voice dimensions in system prompt", () => {
    const { system } = buildTweetPrompt({
      voiceProfile: baseProfile,
      sourceContent: "test",
      sourceType: "MANUAL",
    });
    expect(system).toContain("Humor");
    expect(system).toContain("Formality");
    expect(system).toContain("Brevity");
    expect(system).toContain("Contrarian");
  });

  it("includes blend voices when provided", () => {
    const { system } = buildTweetPrompt({
      voiceProfile: baseProfile,
      sourceContent: "test",
      sourceType: "MANUAL",
      blendVoices: [
        { label: "Balaji", percentage: 60 },
        { label: "Vitalik", percentage: 40 },
      ],
    });
    expect(system).toContain("Voice Blend");
    expect(system).toContain("Balaji");
    expect(system).toContain("Vitalik");
  });

  it("includes feedback in refinement prompt", () => {
    const { system } = buildTweetPrompt({
      voiceProfile: baseProfile,
      sourceContent: "test",
      sourceType: "MANUAL",
      feedback: "Make it more contrarian",
    });
    expect(system).toContain("Refinement Request");
    expect(system).toContain("Make it more contrarian");
  });

  it("includes research context when provided", () => {
    const { system } = buildTweetPrompt({
      voiceProfile: baseProfile,
      sourceContent: "test",
      sourceType: "REPORT",
      researchContext: "Summary: BTC up 10%\nKey facts: Adoption rising",
    });
    expect(system).toContain("Research Context");
    expect(system).toContain("BTC up 10%");
  });

  describe("source type instructions", () => {
    const types = ["REPORT", "ARTICLE", "TWEET", "TRENDING_TOPIC", "VOICE_NOTE", "MANUAL"] as const;

    for (const type of types) {
      it(`formats userMessage with source type label for ${type}`, () => {
        const { userMessage } = buildTweetPrompt({
          voiceProfile: baseProfile,
          sourceContent: "some content",
          sourceType: type,
        });
        expect(userMessage).toContain("some content");
        // Should include a [label] tag
        expect(userMessage).toMatch(/^\[.+\]/);
      });
    }
  });

  describe("humor dimension descriptions", () => {
    it("describes very low humor as serious", () => {
      const { system } = buildTweetPrompt({
        voiceProfile: { ...baseProfile, humor: 10 },
        sourceContent: "test",
        sourceType: "MANUAL",
      });
      expect(system).toContain("Completely serious");
    });

    it("describes very high humor as comedic", () => {
      const { system } = buildTweetPrompt({
        voiceProfile: { ...baseProfile, humor: 95 },
        sourceContent: "test",
        sourceType: "MANUAL",
      });
      expect(system).toContain("Heavily comedic");
    });
  });

  describe("formality dimension descriptions", () => {
    it("describes very low formality as casual", () => {
      const { system } = buildTweetPrompt({
        voiceProfile: { ...baseProfile, formality: 10 },
        sourceContent: "test",
        sourceType: "MANUAL",
      });
      expect(system).toContain("Extremely casual");
    });

    it("describes very high formality as formal", () => {
      const { system } = buildTweetPrompt({
        voiceProfile: { ...baseProfile, formality: 95 },
        sourceContent: "test",
        sourceType: "MANUAL",
      });
      expect(system).toContain("Highly formal");
    });
  });

  describe("contrarian dimension descriptions", () => {
    it("describes very high contrarian tone", () => {
      const { system } = buildTweetPrompt({
        voiceProfile: { ...baseProfile, contrarianTone: 90 },
        sourceContent: "test",
        sourceType: "MANUAL",
      });
      expect(system).toContain("Strongly contrarian");
    });
  });
});
