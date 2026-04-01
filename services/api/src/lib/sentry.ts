import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env.SENTRY_DSN || "https://6be1301a05c1c96a9de8ef96b5552c76@o4511146712825856.ingest.us.sentry.io/4511146753523712",
  tracesSampleRate: 1.0,
  environment: process.env.NODE_ENV || "development",
});

export { Sentry };
