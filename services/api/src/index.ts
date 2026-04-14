import "./lib/sentry"; // Must be first — initializes Sentry before other imports
import { Sentry } from "./lib/sentry";
import { createServer } from "http";
import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import { config } from "./lib/config";
import { authRouter } from "./routes/auth";
import { voiceRouter, referenceAccountsRouter } from "./routes/voice";
import { draftsRouter } from "./routes/drafts";
import { analyticsRouter } from "./routes/analytics";
import { alertsRouter } from "./routes/alerts";
import { arenaRouter } from "./routes/arena";
import { usersRouter } from "./routes/users";
import { researchRouter } from "./routes/research";
import { trendingRouter } from "./routes/trending";
import { imagesRouter } from "./routes/images";
import { loopRouter } from "./routes/loop";
import briefingRouter from "./routes/briefing";
import { docsRouter } from "./routes/docs";
import { xAuthRouter, twitterLoginRouter } from "./routes/x-auth";
import { oracleRouter } from "./routes/oracle";
import { campaignsRouter } from "./routes/campaigns";
import { campaignsPdfRouter } from "./routes/campaigns-pdf";
import { monitorsRouter } from "./routes/monitors";
import { paperclipRouter } from "./routes/paperclip";
import { telegramRouter } from "./routes/telegram";
import { transcribeRouter } from "./routes/transcribe";
import { uploadRouter } from "./routes/upload";
import { qaRouter } from "./routes/qa";
import { adminRouter } from "./routes/admin";
import { adminFlagsRouter } from "./routes/admin-flags";
import { adminBackupRouter } from "./routes/admin-backup";
import { twitterRouter } from "./routes/twitter";
import { queueRouter } from "./routes/queue";
import { bugsRouter } from "./routes/bugs";
import { buildErrorResponse, requestIdMiddleware } from "./middleware/requestId";
import { rateLimit, rateLimitByUser } from "./middleware/rateLimit";
import { requestLogger } from "./middleware/requestLogger";
import { logger } from "./lib/logger";
import { formatErrorResponse } from "./lib/errors";
import { assertCorsConfig, buildCorsOptions } from "./lib/cors";
import { prisma } from "./lib/prisma";
import { getRedis } from "./lib/redis";
import { initBot } from "./lib/telegram";
import { initSocket } from "./lib/socket";
import { startScheduler } from "./lib/scheduler";

dotenv.config();

const app = express();
// Railway terminates TLS and forwards one hop. With trust proxy set,
// Express parses X-Forwarded-For safely and exposes the validated client
// IP as req.ip — so rate limiters can key on a value the client cannot spoof.
app.set("trust proxy", 1);
const PORT = config.PORT;

const allowedOrigins = config.FRONTEND_URL.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// Refuse to boot a production API with an empty CORS allowlist. Under the
// old middleware an empty list silently rejected every browser request —
// fail loudly instead so the bad deploy is caught before traffic hits it.
assertCorsConfig({ allowedOrigins, nodeEnv: config.NODE_ENV });

app.use(helmet());
app.use(cors(buildCorsOptions(allowedOrigins)));
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.use(requestIdMiddleware);
app.use(requestLogger);

const generalApiLimiter = rateLimitByUser(
  config.RATE_LIMIT_GENERAL_MAX_REQUESTS,
  config.RATE_LIMIT_GENERAL_WINDOW_MS,
);

// Protect the unauthenticated swagger UI — it parses a YAML file on every
// request, so a burst of hits is expensive. IP-scoped, separate namespace
// from any future auth-router limit.
const docsRateLimiter = rateLimit(
  config.RATE_LIMIT_DOCS_MAX_REQUESTS,
  config.RATE_LIMIT_DOCS_WINDOW_MS,
  "docs",
);

// Health check
app.get("/health", async (_req, res) => {
  let database: "ok" | "error" = "ok";
  let cache: "ok" | "unavailable" = "unavailable";

  try {
    await prisma.$queryRaw`SELECT 1`;
    database = "ok";
  } catch {
    database = "error";
  }

  try {
    const redis = getRedis();
    if (!redis) {
      throw new Error("Redis unavailable");
    }

    await redis.ping();
    cache = "ok";
  } catch {
    cache = "unavailable";
  }

  res.status(database === "error" ? 503 : 200).json({
    status: "ok",
    version: process.env.npm_package_version || "unknown",
    uptime: process.uptime(),
    database,
    cache,
    timestamp: new Date().toISOString(),
  });
});

// Routes
app.use("/api/docs", docsRateLimiter, docsRouter);
app.use("/api/auth/x", xAuthRouter);
app.use("/api/auth", authRouter);
app.use("/api", generalApiLimiter);
app.use("/api/users", usersRouter);
app.use("/api/voice", referenceAccountsRouter);
app.use("/api/voice", voiceRouter);
app.use("/api/drafts", draftsRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/alerts", alertsRouter);
app.use("/api/arena", arenaRouter);
app.use("/api/research", researchRouter);
app.use("/api/trending", trendingRouter);
app.use("/api/images", imagesRouter);
app.use("/api/loop", loopRouter);
app.use("/api/briefing", briefingRouter);
app.use("/api/auth/twitter", twitterLoginRouter);
app.use("/api/oracle", oracleRouter);
app.use("/api/campaigns", campaignsRouter);
// Second mount at /api/campaigns — adds POST /api/campaigns/generate-from-pdf.
// Split into its own router because routes/campaigns.ts was under concurrent
// edit from another session when this feature landed; keeping it isolated
// avoids merge conflicts and lets the other session's work land cleanly.
app.use("/api/campaigns", campaignsPdfRouter);
app.use("/api/monitors", monitorsRouter);
app.use("/api/telegram", telegramRouter);
app.use("/api/paperclip", paperclipRouter);
app.use("/api/transcribe", transcribeRouter);
app.use("/api/upload", uploadRouter);
app.use("/api/qa", qaRouter);
app.use("/api/admin/feature-flags", adminFlagsRouter);
app.use("/api/admin/backup", adminBackupRouter);
app.use("/api/admin", adminRouter);
app.use("/api/twitter", twitterRouter);
app.use("/api/queue", queueRouter);
app.use("/api/bugs", bugsRouter);

// 404 handler — catch unknown routes before error handlers
app.use((req, res) => {
  res.status(404).json(buildErrorResponse(req, `Cannot ${req.method} ${req.path}`));
});

// Sentry error handler — must be before any other error middleware
Sentry.setupExpressErrorHandler(app);

// Global error handler
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const requestId = (req as any).requestId;
  const { statusCode, body } = formatErrorResponse(err, requestId);
  if (statusCode >= 500) {
    logger.error({ requestId, err: err.message }, `Unhandled error: ${err.message}`);
  }
  res.status(statusCode).json(body);
});

const server = createServer(app);
// Keep the Node timeout above Railway's RAILWAY_SERVICE_TIMEOUT=90000 so Anthropic-backed
// routes fail at the platform boundary first instead of being cut off by the app server.
server.timeout = 120_000;
server.keepAliveTimeout = 65_000;
initSocket(server, allowedOrigins);
initBot();

server.listen(PORT, () => {
  logger.info({ port: PORT }, `Atlas API running on port ${PORT}`);
  startScheduler();

  // 2026-04-11: Enable queue + campaigns feature flags
  void (async () => {
    try {
      for (const key of ["queue", "campaigns"]) {
        await prisma.featureFlag.upsert({
          where: { key },
          update: { enabled: true },
          create: { key, enabled: true, rolloutRole: "everyone" },
        });
      }
      logger.info("Feature flags: queue + campaigns enabled");
    } catch (err: any) {
      logger.error({ err: err.message }, "Failed to enable feature flags on startup");
    }
  })();
});

export default app;
