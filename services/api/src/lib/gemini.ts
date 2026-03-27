import { GoogleGenerativeAI } from "@google/generative-ai";

let client: GoogleGenerativeAI | null = null;

export function getGeminiClient(): GoogleGenerativeAI {
  if (!client) {
    client = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY!);
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

export async function generateImage(params: ImageGenParams): Promise<ImageGenResult> {
  const { content, style, aspectRatio = "16:9" } = params;

  const stylePrompt = STYLE_PROMPTS[style] || STYLE_PROMPTS.quote_card;
  const fullPrompt = `${stylePrompt}\n\nContext for the visual: "${content.slice(0, 200)}"`;

  const client = getGeminiClient();

  // Use Gemini's image generation model
  const model = client.getGenerativeModel({ model: "gemini-2.5-flash" });

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: `Generate an image: ${fullPrompt}. Aspect ratio: ${aspectRatio}.` }] }],
    generationConfig: {
      maxOutputTokens: 1000,
    },
  });

  const response = result.response;
  const text = response.text();

  // Gemini text models return text descriptions, not actual images.
  // For actual image generation, we'd need Imagen API.
  // For now, return a structured description that the frontend can use
  // to create a visual via CSS/SVG, or we can swap to Imagen when available.
  return {
    imageData: text,
    mimeType: "text/plain",
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
  const model = client.getGenerativeModel({ model: "gemini-2.5-flash" });

  const result = await model.generateContent({
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
      maxOutputTokens: 500,
    },
  });

  const text = result.response.text();
  const jsonStr = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  return JSON.parse(jsonStr);
}
