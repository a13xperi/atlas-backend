import OpenAI from "openai";

let client: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (!client) {
    client = new OpenAI(); // reads OPENAI_API_KEY from env
  }
  return client;
}
