/**
 * Pipeline Runner test suite
 * Tests: parallel grouping, optional/required steps, timing, error handling
 */

import { runPipeline } from "../../../lib/pipeline/runner";
import type { PipelineStep, PipelineContext } from "../../../lib/pipeline/types";

function makeContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    userId: "user-123",
    sourceContent: "BTC analysis",
    sourceType: "REPORT",
    stepResults: [],
    ...overrides,
  };
}

function makeStep(overrides: Partial<PipelineStep> & { execute?: PipelineStep["execute"] } = {}): PipelineStep {
  return {
    name: "test-step",
    execute: async () => {},
    ...overrides,
  };
}

describe("runPipeline", () => {
  it("runs steps in sequence by default", async () => {
    const order: string[] = [];

    const result = await runPipeline([
      makeStep({ name: "a", execute: async () => { order.push("a"); } }),
      makeStep({ name: "b", execute: async () => { order.push("b"); } }),
    ], makeContext());

    expect(order).toEqual(["a", "b"]);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].name).toBe("a");
    expect(result.steps[1].name).toBe("b");
  });

  it("runs grouped steps in parallel", async () => {
    const startTimes: Record<string, number> = {};

    const slowStep = (name: string): PipelineStep => makeStep({
      name,
      group: "parallel",
      execute: async () => {
        startTimes[name] = Date.now();
        await new Promise((r) => setTimeout(r, 50));
      },
    });

    await runPipeline([slowStep("p1"), slowStep("p2"), slowStep("p3")], makeContext());

    // All should start within a few ms of each other (parallel, not serial)
    const times = Object.values(startTimes);
    const spread = Math.max(...times) - Math.min(...times);
    expect(spread).toBeLessThan(30); // Would be ~100+ if serial
  });

  it("runs ungrouped step after preceding group completes", async () => {
    const order: string[] = [];

    await runPipeline([
      makeStep({ name: "prep1", group: "prepare", execute: async () => { order.push("prep1"); } }),
      makeStep({ name: "prep2", group: "prepare", execute: async () => { order.push("prep2"); } }),
      makeStep({ name: "generate", execute: async () => { order.push("generate"); } }),
    ], makeContext());

    // Generate must come after both prep steps
    expect(order.indexOf("generate")).toBeGreaterThan(order.indexOf("prep1"));
    expect(order.indexOf("generate")).toBeGreaterThan(order.indexOf("prep2"));
  });

  it("continues when optional step fails", async () => {
    const ctx = makeContext();

    const result = await runPipeline([
      makeStep({
        name: "optional-fail",
        optional: true,
        execute: async () => { throw new Error("boom"); },
      }),
      makeStep({
        name: "after",
        execute: async (c) => { c.generatedContent = "done"; },
      }),
    ], ctx);

    expect(ctx.generatedContent).toBe("done");
    expect(result.steps.find((s) => s.name === "optional-fail")?.status).toBe("skipped");
    expect(result.steps.find((s) => s.name === "after")?.status).toBe("success");
  });

  it("aborts when required step fails", async () => {
    const ctx = makeContext();

    await expect(runPipeline([
      makeStep({
        name: "required-fail",
        execute: async () => { throw new Error("critical error"); },
      }),
      makeStep({ name: "should-not-run" }),
    ], ctx)).rejects.toThrow("critical error");

    expect(ctx.stepResults.find((s) => s.name === "required-fail")?.status).toBe("failed");
  });

  it("records latency for each step", async () => {
    const result = await runPipeline([
      makeStep({
        name: "slow",
        execute: async () => { await new Promise((r) => setTimeout(r, 20)); },
      }),
    ], makeContext());

    expect(result.steps[0].latencyMs).toBeGreaterThanOrEqual(15);
  });

  it("records total pipeline time", async () => {
    const result = await runPipeline([
      makeStep({ name: "a" }),
    ], makeContext());

    expect(result.totalMs).toBeGreaterThanOrEqual(0);
  });

  it("returns immediately for empty pipeline", async () => {
    const result = await runPipeline([], makeContext());
    expect(result.steps).toHaveLength(0);
    expect(result.totalMs).toBeGreaterThanOrEqual(0);
  });

  it("steps can write to and read from context", async () => {
    const ctx = makeContext();

    await runPipeline([
      makeStep({
        name: "writer",
        execute: async (c) => { c.researchContext = "BTC is bullish"; },
      }),
      makeStep({
        name: "reader",
        execute: async (c) => {
          expect(c.researchContext).toBe("BTC is bullish");
          c.generatedContent = `Tweet about: ${c.researchContext}`;
        },
      }),
    ], ctx);

    expect(ctx.generatedContent).toBe("Tweet about: BTC is bullish");
  });
});
