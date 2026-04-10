import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "./config";
import { withRetry } from "./retry";

let client: GoogleGenerativeAI | null = null;

const DEFAULT_GEMINI_TEXT_MODEL = "gemini-2.5-flash";
const DEFAULT_GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";

export function getGeminiClient(): GoogleGenerativeAI {
  if (!client) {
    if (!config.GOOGLE_AI_API_KEY) {
      throw new Error("GOOGLE_AI_API_KEY is not set — image generation requires a Google AI API key");
    }
    client = new GoogleGenerativeAI(config.GOOGLE_AI_API_KEY);
  }
  return client;
}

export type ImageStyle = "infographic" | "quote_card" | "avatar" | "thumbnail";

interface ImageGenParams {
  content: string;
  style: ImageStyle;
  aspectRatio?: "1:1" | "16:9" | "4:5";
}

export interface ImageGenResult {
  imageData: string; // base64 encoded
  mimeType: string;
  promptUsed: string;
}

interface GeminiInlineDataPart {
  inlineData?: {
    data?: string;
    mimeType?: string;
  };
  text?: string;
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiInlineDataPart[];
    };
  }>;
}

const STYLE_PROMPTS: Record<ImageStyle, string> = {
  infographic:
    "Create a clean, modern infographic-style visual for a crypto/finance tweet. Dark background (#1a1a2e), teal accents (#4ecdc4). Include a simple chart or data visualization. Minimal text overlay. Professional and sleek.",
  quote_card:
    "Create a stylized quote card for social media. Dark gradient background, modern typography feel. Teal (#4ecdc4) accent lines. Clean, minimal, suitable for Twitter/X. No actual text — just the visual design with placeholder areas.",
  avatar:
    "Create a modern, abstract avatar icon for a crypto analyst profile. Geometric shapes, dark tones with teal (#4ecdc4) highlights. Professional, suitable as a social media profile picture. Square format.",
  thumbnail:
    "Create a thumbnail image for a crypto content piece. Eye-catching, dark theme with teal (#4ecdc4) accents. Modern, clean design suitable for social media preview cards.",
};

function resolveGeminiTextModel(): string {
  const configuredModel = config.GEMINI_MODEL?.trim();

  if (!configuredModel) return DEFAULT_GEMINI_TEXT_MODEL;
  if (configuredModel.toLowerCase().includes("image")) return DEFAULT_GEMINI_TEXT_MODEL;

  return configuredModel;
}

function resolveGeminiImageModel(): string {
  const configuredImageModel = config.GEMINI_IMAGE_MODEL?.trim();
  if (configuredImageModel) return configuredImageModel;

  const legacyModel = config.GEMINI_MODEL?.trim();
  if (legacyModel && legacyModel.toLowerCase().includes("image") && !legacyModel.startsWith("gemini-2.0")) {
    return legacyModel;
  }

  return DEFAULT_GEMINI_IMAGE_MODEL;
}

function buildImagePrompt(content: string, style: ImageStyle, aspectRatio: ImageGenParams["aspectRatio"]): string {
  const stylePrompt = STYLE_PROMPTS[style] || STYLE_PROMPTS.quote_card;

  return `${stylePrompt}

Create an original social image with no brand logos or watermarks.
Keep any text in the image minimal and highly legible.
Use aspect ratio ${aspectRatio}.

Context for the visual: "${content.slice(0, 500)}"`;
}

async function postGeminiImageRequest(
  model: string,
  prompt: string,
  aspectRatio: NonNullable<ImageGenParams["aspectRatio"]>,
): Promise<GeminiGenerateContentResponse> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": config.GOOGLE_AI_API_KEY!,
      },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{ text: prompt }],
        }],
        generationConfig: {
          responseModalities: ["Image"],
          imageConfig: {
            aspectRatio,
          },
        },
      }),
    },
  );

  if (!response.ok) {
    let message = `Gemini image request failed with status ${response.status}`;
    const rawBody = await response.text();

    if (rawBody) {
      try {
        const payload = JSON.parse(rawBody) as { error?: { message?: string } };
        if (payload.error?.message) {
          message = payload.error.message;
        } else {
          message = rawBody;
        }
      } catch {
        message = rawBody;
      }
    }

    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  return response.json() as Promise<GeminiGenerateContentResponse>;
}

export async function generateImage(params: ImageGenParams): Promise<ImageGenResult> {
  const { content, style, aspectRatio = "16:9" } = params;
  const fullPrompt = buildImagePrompt(content, style, aspectRatio);
  const model = resolveGeminiImageModel();

  const result = await withRetry(
    () => postGeminiImageRequest(model, fullPrompt, aspectRatio),
    "gemini:generateImage",
  );

  const parts = result.candidates?.flatMap((candidate) => candidate.content?.parts ?? []) ?? [];
  const imagePart = parts.find((part) => part.inlineData?.data);

  if (!imagePart?.inlineData?.data) {
    const textPart = parts.find((part) => part.text?.trim())?.text?.trim();
    if (textPart) {
      throw new Error(`Gemini image model returned text instead of an image: ${textPart.slice(0, 200)}`);
    }
    throw new Error(`Gemini image model "${model}" returned no inline image data`);
  }

  return {
    imageData: imagePart.inlineData.data,
    mimeType: imagePart.inlineData.mimeType ?? "image/png",
    promptUsed: fullPrompt,
  };
}

/**
 * Generate a text-based visual description for a tweet.
 * This creates a structured prompt that could be used with any image API,
 * or rendered as a styled card on the frontend.
 */
export async function generateVisualConcept(tweetContent: string, style: ImageStyle = "quote_card"): Promise<{
  concept: string;
  colorScheme: string[];
  layout: string;
  elements: string[];
}> {
  const client = getGeminiClient();
  const model = client.getGenerativeModel({ model: resolveGeminiTextModel() });

  const result = await withRetry(
    () =>
      model.generateContent({
        contents: [{
          role: "user",
          parts: [{
            text: `You are a visual design AI for crypto Twitter content. Given this tweet, create a visual concept.

Tweet: "${tweetContent}"

Respond with JSON only:
{
  "concept": "one sentence describing the visual",
  "colorScheme": ["#hex1", "#hex2", "#hex3"],
  "layout": "the layout type (centered-quote | split-stat | chart-overlay | minimal-gradient)",
  "elements": ["element 1", "element 2", "element 3"]
}

Use the Atlas brand palette: primary #4ecdc4 (teal), bg #1a1a2e, surface #2d3748. Make it bold and shareable.`
      }]
    }],
    generationConfig: {
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
    },
  }),
    "gemini:generateVisualConcept",
  );

  const text = result.response.text();

  try {
    const parsed = JSON.parse(text);
    return {
      concept: parsed.concept ?? "Visual concept for tweet",
      colorScheme: Array.isArray(parsed.colorScheme) ? parsed.colorScheme : ["#4ecdc4", "#1a1a2e", "#2d3748"],
      layout: parsed.layout ?? "minimal-gradient",
      elements: Array.isArray(parsed.elements) ? parsed.elements : [],
    };
  } catch {
    // Gemini sometimes returns non-JSON despite responseMimeType — fallback to structured default
    return {
      concept: text.slice(0, 200) || "Visual concept for tweet",
      colorScheme: ["#4ecdc4", "#1a1a2e", "#2d3748"],
      layout: "minimal-gradient" as const,
      elements: ["text overlay", "gradient background"],
    };
  }
}
