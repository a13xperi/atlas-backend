import type { PipelineStep } from "../types";

/**
 * Fetch and extract text from a URL when sourceType is ARTICLE.
 * Replaces the URL in sourceContent with the actual article text
 * so downstream research/generation steps have real content to work with.
 */

const URL_PATTERN = /^https?:\/\/.+/;
const MAX_CHARS = 8000; // keep well under the 10k sourceContent limit

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export const fetchArticleStep: PipelineStep = {
  name: "fetchArticle",
  group: "prepare",
  optional: true,

  async execute(ctx) {
    if (ctx.sourceType !== "ARTICLE") return;
    if (!URL_PATTERN.test(ctx.sourceContent.trim())) return;

    const url = ctx.sourceContent.trim();

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; AtlasBot/1.0; +https://delphi-atlas.vercel.app)",
          Accept: "text/html,application/xhtml+xml",
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        ctx.fetchArticleError = `HTTP ${response.status}`;
        return;
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
        ctx.fetchArticleError = `Unsupported content type: ${contentType}`;
        return;
      }

      const html = await response.text();
      const text = stripHtml(html);

      if (text.length < 100) {
        ctx.fetchArticleError = "Extracted text too short — site may require JS";
        return;
      }

      // Store original URL so it can be referenced, replace sourceContent with text
      ctx.articleUrl = url;
      ctx.sourceContent = text.slice(0, MAX_CHARS);
    } catch (err) {
      ctx.fetchArticleError = err instanceof Error ? err.message : "fetch failed";
    }
  },
};
