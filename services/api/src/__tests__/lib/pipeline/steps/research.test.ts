/**
 * Research step test suite
 * Mocks: conductResearch from lib/research
 */

jest.mock("../../../../lib/research", () => ({
  conductResearch: jest.fn(),
}));

import { researchStep } from "../../../../lib/pipeline/steps/research";
import { conductResearch } from "../../../../lib/research";
import type { PipelineContext } from "../../../../lib/pipeline/types";

const mockConductResearch = conductResearch as jest.Mock;

function makeContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    userId: "user-123",
    sourceContent: "BTC analysis",
    sourceType: "REPORT",
    stepResults: [],
    ...overrides,
  };
}

describe("researchStep", () => {
  beforeEach(() => {
    mockConductResearch.mockReset();
  });

  it("is marked as optional", () => {
    expect(researchStep.optional).toBe(true);
  });

  it("is in the prepare group", () => {
    expect(researchStep.group).toBe("prepare");
  });

  it("calls conductResearch and formats context string", async () => {
    mockConductResearch.mockResolvedValueOnce({
      summary: "BTC is at ATH",
      keyFacts: ["Price up 10%", "Volume surging"],
      sentiment: "bullish",
    });

    const ctx = makeContext();
    await researchStep.execute(ctx);

    expect(mockConductResearch).toHaveBeenCalledWith({
      query: "BTC analysis",
      context: "REPORT",
    });
    expect(ctx.researchContext).toContain("BTC is at ATH");
    expect(ctx.researchContext).toContain("Price up 10%");
    expect(ctx.researchContext).toContain("bullish");
  });

  it("propagates error (runner handles optional semantics)", async () => {
    mockConductResearch.mockRejectedValueOnce(new Error("API timeout"));

    const ctx = makeContext();
    await expect(researchStep.execute(ctx)).rejects.toThrow("API timeout");
  });
});
