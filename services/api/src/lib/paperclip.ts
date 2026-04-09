import { config } from "./config";
import { logger } from "./logger";

export const PAPERCLIP_TASKS_URL =
  "https://paperclip-server-production-24ad.up.railway.app/api/tasks";

export type PaperclipTaskTriggerInput = {
  agentId: string;
  taskType: string;
  payload: Record<string, unknown>;
};

export class PaperclipError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 502,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "PaperclipError";
  }
}

function parseResponseBody(rawBody: string): unknown {
  if (!rawBody) return null;

  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

export async function triggerPaperclipTask(
  input: PaperclipTaskTriggerInput,
): Promise<unknown> {
  const apiKey = config.PAPERCLIP_API_KEY?.trim();
  if (!apiKey) {
    throw new PaperclipError("PAPERCLIP_API_KEY is not configured", 500);
  }

  let response: Response;

  try {
    response = await fetch(PAPERCLIP_TASKS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
  } catch (err) {
    logger.error({ err }, "[paperclip] Failed to reach Paperclip");
    throw new PaperclipError("Failed to reach Paperclip", 502);
  }

  const rawBody = await response.text();
  const body = parseResponseBody(rawBody);

  if (!response.ok) {
    logger.error({ status: response.status, body }, "[paperclip] Paperclip task trigger failed");

    const message =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : `Paperclip request failed with status ${response.status}`;

    throw new PaperclipError(message, 502, body);
  }

  return body;
}
