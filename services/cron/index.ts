import { startBriefingCron } from "./briefing";

let cronServicesStarted = false;

export function startCronServices(): void {
  if (cronServicesStarted) {
    return;
  }

  cronServicesStarted = true;
  startBriefingCron();
}
