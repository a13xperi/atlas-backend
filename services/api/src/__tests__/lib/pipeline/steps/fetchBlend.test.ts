jest.mock("../../../../lib/prisma", () => ({
  prisma: {
    savedBlend: {
      findFirst: jest.fn(),
    },
    user: {
      findMany: jest.fn(),
    },
  },
}));

import { prisma } from "../../../../lib/prisma";
import { fetchBlendStep } from "../../../../lib/pipeline/steps/fetchBlend";
import type { PipelineContext } from "../../../../lib/pipeline/types";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

function makeContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    userId: "user-123",
    sourceContent: "ETH thesis",
    sourceType: "MANUAL",
    blendId: "blend-1",
    voiceProfile: {
      humor: 50,
      formality: 50,
      brevity: 50,
      contrarianTone: 50,
      directness: 50,
      warmth: 50,
      technicalDepth: 50,
      confidence: 50,
      evidenceOrientation: 50,
      solutionOrientation: 50,
      socialPosture: 50,
      selfPromotionalIntensity: 50,
      maturity: "INTERMEDIATE",
    },
    stepResults: [],
    ...overrides,
  };
}

describe("fetchBlendStep", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("blends the user's voice with a stored seeded reference profile", async () => {
    (mockPrisma.savedBlend.findFirst as jest.Mock).mockResolvedValueOnce({
      id: "blend-1",
      voices: [
        {
          label: "My voice",
          percentage: 70,
          referenceVoiceId: null,
          referenceVoice: null,
        },
        {
          label: "Paul Graham",
          percentage: 30,
          referenceVoiceId: "ref-1",
          referenceVoice: {
            name: "Paul Graham",
            handle: "paulgraham",
            voiceProfile: {
              humor: 90,
              formality: 80,
              brevity: 70,
              contrarianTone: 60,
              directness: 90,
              warmth: 40,
              technicalDepth: 55,
              confidence: 85,
              evidenceOrientation: 65,
              solutionOrientation: 60,
              socialPosture: 35,
              selfPromotionalIntensity: 20,
            },
          },
        },
      ],
    });

    const ctx = makeContext();
    await fetchBlendStep.execute(ctx);

    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    expect(ctx.blendVoices).toEqual([
      { label: "My voice", percentage: 70 },
      { label: "Paul Graham", percentage: 30 },
    ]);
    expect(ctx.blendedDimensions).toEqual(
      expect.objectContaining({
        humor: 62,
        formality: 59,
        brevity: 56,
        contrarianTone: 53,
        directness: 62,
      }),
    );
  });

  it("falls back to Atlas users when a reference handle maps to a calibrated user", async () => {
    (mockPrisma.savedBlend.findFirst as jest.Mock).mockResolvedValueOnce({
      id: "blend-2",
      voices: [
        {
          label: "Peer analyst",
          percentage: 100,
          referenceVoiceId: "ref-legacy",
          referenceVoice: {
            name: "Peer analyst",
            handle: "@atlas-peer",
            voiceProfile: null,
          },
        },
      ],
    });
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValueOnce([
      {
        handle: "atlas-peer",
        voiceProfile: {
          humor: 74,
          formality: 61,
          brevity: 69,
          contrarianTone: 58,
          directness: 81,
          warmth: 45,
          technicalDepth: 67,
          confidence: 73,
          evidenceOrientation: 77,
          solutionOrientation: 55,
          socialPosture: 41,
          selfPromotionalIntensity: 24,
        },
      },
    ]);

    const ctx = makeContext({ blendId: "blend-2" });
    await fetchBlendStep.execute(ctx);

    expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
      where: { handle: { in: ["atlas-peer"] } },
      include: { voiceProfile: true },
    });
    expect(ctx.blendedDimensions).toEqual(
      expect.objectContaining({
        humor: 74,
        directness: 81,
      }),
    );
  });
});
