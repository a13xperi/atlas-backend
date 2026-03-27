import Anthropic from "@anthropic-ai/sdk";

// Singleton — SDK reads ANTHROPIC_API_KEY from env automatically
let client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}
