/**
 * Pipeline Runner — executes steps with parallel grouping and observability.
 * Inspired by claw-code's runtime crate orchestration pattern.
 */

import type { PipelineStep, PipelineContext, StepResult, PipelineResult } from "./types";
import { logger } from "../logger";
import { withTimeout } from "../timeout";

async function executeStep(step: PipelineStep, ctx: PipelineContext): Promise<StepResult> {
  const start = Date.now();
  try {
    await step.execute(ctx);
    return {
      name: step.name,
      status: "success",
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (step.optional) {
      logger.warn({ step: step.name, error }, `Optional pipeline step failed`);
      return {
        name: step.name,
        status: "skipped",
        latencyMs: Date.now() - start,
        error,
      };
    }
    // Required step — record and re-throw
    const result: StepResult = {
      name: step.name,
      status: "failed",
      latencyMs: Date.now() - start,
      error,
    };
    ctx.stepResults.push(result);
    throw err;
  }
}

/**
 * Run pipeline steps in order, parallelizing steps that share a group.
 *
 * Execution order is determined by first appearance of each group/step:
 * - Steps with the same `group` string are collected and run with Promise.all
 * - Steps with no group run individually in sequence
 * - Groups execute in the order their first member appears in the steps array
 */
export async function runPipeline(steps: PipelineStep[], ctx: PipelineContext): Promise<PipelineResult> {
  const pipelineStart = Date.now();

  // Build ordered execution plan: array of (group | single step)
  const plan: { group?: string; steps: PipelineStep[] }[] = [];
  const seenGroups = new Set<string>();

  for (const step of steps) {
    if (step.group) {
      if (!seenGroups.has(step.group)) {
        seenGroups.add(step.group);
        // Collect all steps in this group
        const grouped = steps.filter((s) => s.group === step.group);
        plan.push({ group: step.group, steps: grouped });
      }
    } else {
      plan.push({ steps: [step] });
    }
  }

  // Execute plan
  for (const entry of plan) {
    if (entry.steps.length === 1) {
      const result = await executeStep(entry.steps[0], ctx);
      ctx.stepResults.push(result);
    } else {
      // Parallel group — 30s cap prevents the prepare phase from hanging
      const results = await withTimeout(
        Promise.all(entry.steps.map((s) => executeStep(s, ctx))),
        30_000,
        `pipeline-group:${entry.group ?? "parallel"}`,
      );
      ctx.stepResults.push(...results);
    }
  }

  return {
    ctx,
    steps: ctx.stepResults,
    totalMs: Date.now() - pipelineStart,
  };
}
