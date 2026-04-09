import { complete } from "../../providers";
import type { PipelineStep } from "../types";

/**
 * Summarize oversized sourceContent so downstream steps (research, generate)
 * receive a manageable but complete representation of the original report.
 *
 * Threshold: if sourceContent > 15 000 chars (~4k tokens), we ask the LLM
 * to produce a dense summary that preserves all key facts, data points, and
 * conclusions.  The original text is still available in `ctx.originalSourceContent`.
 */

const SUMMARIZE_THRESHOLD = 15_000;

const SUMMARIZE_SYSTEM = `You are an expert research analyst. Summarize the following content into a dense, factual summary.

Rules:
- Preserve ALL key data points, statistics, percentages, and numbers.
- Preserve ALL conclusions, recommendations, and main arguments.
- Preserve names of people, projects, protocols, and organizations.
- Use concise language — no filler.
- Aim for roughly 3000-5000 words of summary depending on original length.
- Structure with clear sections if the original has logical sections.
- Do NOT add any commentary or analysis — only condense what is there.`;

export const summarizeContentStep: PipelineStep = {
  name: "summarizeContent",
  // No group — runs before "prepare" group
  optional: true,

  async execute(ctx) {
    if (ctx.sourceContent.length <= SUMMARIZE_THRESHOLD) return;

    // Stash original for reference
    (ctx as unknown as Record<string, unknown>).originalSourceContent = ctx.sourceContent;

    // For extremely long content (>80k), chunk and summarize each chunk,
    // then merge. For moderate content, single-pass summarization.
    const CHUNK_SIZE = 60_000; // ~15k tokens per chunk
    const content = ctx.sourceContent;

    if (content.length <= CHUNK_SIZE) {
      ctx.sourceContent = await summarizeSingle(content);
    } else {
      ctx.sourceContent = await summarizeChunked(content, CHUNK_SIZE);
    }
  },
};

async function summarizeSingle(text: string): Promise<string> {
  const response = await complete({
    taskType: "research",
    maxTokens: 4000,
    temperature: 0.2,
    messages: [
      { role: "system", content: SUMMARIZE_SYSTEM },
      { role: "user", content: text },
    ],
  });
  return response.content;
}

async function summarizeChunked(text: string, chunkSize: number): Promise<string> {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }

  // Summarize each chunk in parallel
  const summaries = await Promise.all(
    chunks.map((chunk, i) =>
      summarizeSingle(`[Part ${i + 1} of ${chunks.length}]\n\n${chunk}`)
    )
  );

  const merged = summaries.join("\n\n---\n\n");

  // If merged summaries are still long, do a final consolidation pass
  if (merged.length > SUMMARIZE_THRESHOLD) {
    return summarizeSingle(
      `The following are section-by-section summaries of a single large document. ` +
      `Consolidate them into one cohesive summary, preserving all key data and conclusions.\n\n${merged}`
    );
  }

  return merged;
}
