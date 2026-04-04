/**
 * Oracle Agent tool definitions for Anthropic tool_use.
 * Each tool maps to an Atlas API capability the Oracle can invoke on behalf of the user.
 */

import type { ToolDefinition } from "./providers/types";

export const ORACLE_TOOLS: ToolDefinition[] = [
  {
    name: "navigate",
    description:
      "Navigate the user to a page in Atlas. Use this when the user asks to go somewhere or when an action requires being on a specific page.",
    input_schema: {
      type: "object",
      properties: {
        page: {
          type: "string",
          description:
            'Route path: /dashboard, /crafting, /voice-profiles, /alerts, /analytics, /arena, /campaigns, /team-library, /briefing, /telegram, /profile',
        },
        params: {
          type: "object",
          description:
            "Optional query parameters (e.g. { content: '...', voice: 'MyBlend' } for /crafting)",
          additionalProperties: { type: "string" },
        },
      },
      required: ["page"],
    },
  },
  {
    name: "generate_draft",
    description:
      "Generate a tweet draft from content using the user's voice profile. Returns the generated draft text and ID.",
    input_schema: {
      type: "object",
      properties: {
        sourceContent: {
          type: "string",
          description: "The source content to turn into a tweet (article text, topic, idea)",
        },
        sourceType: {
          type: "string",
          enum: ["REPORT", "ARTICLE", "TWEET", "MANUAL"],
          description: "Type of source content. Default: MANUAL",
        },
        blendId: {
          type: "string",
          description: "Optional saved blend ID to use instead of personal voice",
        },
      },
      required: ["sourceContent"],
    },
  },
  {
    name: "list_drafts",
    description:
      "List the user's recent tweet drafts. Optionally filter by status.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["DRAFT", "APPROVED", "POSTED", "ARCHIVED"],
          description: "Filter by draft status. Omit for all drafts.",
        },
      },
    },
  },
  {
    name: "get_voice_profile",
    description:
      "Get the user's current voice profile dimensions and saved blends.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_analytics_summary",
    description:
      "Get the user's analytics summary: draft count, post count, engagement stats over the last 30 days.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_trending",
    description:
      "Get currently trending topics in crypto twitter. Useful when the user asks what's hot or wants content inspiration.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_signals",
    description:
      "Get the user's signal feed — alerts about trending topics, competitor posts, and market moves.",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Optional category filter: SIGNAL, ALERT, NOTIFICATION",
        },
      },
    },
  },
  {
    name: "conduct_research",
    description:
      "Research a topic and return a summary. Use when the user wants to understand something before drafting.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The research query or topic to investigate",
        },
      },
      required: ["query"],
    },
  },
];

/** Tools that require user confirmation before executing (destructive writes). */
export const CONFIRMATION_REQUIRED = new Set([
  "post_draft",
  "schedule_draft",
  "calibrate_voice",
  "update_voice_dimension",
  "subscribe_signal",
]);

/** Tools safe to execute server-side without a frontend round-trip (read-only). */
export const SERVER_EXECUTABLE = new Set([
  "get_voice_profile",
  "get_analytics_summary",
  "get_trending",
  "get_signals",
  "list_drafts",
  "conduct_research",
]);
