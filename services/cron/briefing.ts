import { logger } from "../api/src/lib/logger";

export const BRIEFING_CRON_EXPRESSION = "*/5 * * * *";
const BRIEFING_INTERVAL_MS = 5 * 60_000;

let briefingCronInterval: ReturnType<typeof setInterval> | null = null;
const logBriefingHeartbeat = logger.info.bind(logger) as (...args: unknown[]) => void;

export function startBriefingCron(): void {
  if (briefingCronInterval) {
    return;
  }

  logger.info("[briefing-cron] registered");

  briefingCronInterval = setInterval(() => {
    logBriefingHeartbeat("[briefing-cron] Job Heartbeat", { ts: new Date().toISOString() });
    // TODO: Replace heartbeat stub with real briefing generation.
  }, BRIEFING_INTERVAL_MS);
}

export function stopBriefingCron(): void {
  if (!briefingCronInterval) {
    return;
  }

  clearInterval(briefingCronInterval);
  briefingCronInterval = null;
}
