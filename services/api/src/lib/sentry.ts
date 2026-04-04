import * as Sentry from "@sentry/node";
import { config } from "./config";

Sentry.init({
  dsn: config.SENTRY_DSN,
  tracesSampleRate: 1.0,
  environment: config.NODE_ENV,
});

export { Sentry };
