import "./lib/sentry"; // Must be first — initializes Sentry before other imports
import { Sentry } from "./lib/sentry";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { config } from "./lib/config";
import { authRouter } from "./routes/auth";
import { voiceRouter } from "./routes/voice";
import { draftsRouter } from "./routes/drafts";
import { analyticsRouter } from "./routes/analytics";
import { alertsRouter } from "./routes/alerts";
import { usersRouter } from "./routes/users";
import { researchRouter } from "./routes/research";
import { trendingRouter } from "./routes/trending";
import { imagesRouter } from "./routes/images";
import { buildErrorResponse, requestIdMiddleware } from "./middleware/requestId";
import { rateLimit } from "./middleware/rateLimit";
import { requestLogger } from "./middleware/requestLogger";
import { logger } from "./lib/logger";
import { formatErrorResponse } from "./lib/errors";
import { prisma } from "./lib/prisma";
import { getRedis } from "./lib/redis";
import { initBot } from "./lib/telegram";

dotenv.config();

const app = express();
const PORT = config.PORT;

const allowedOrigins = config.FRONTEND_URL
  .split(",")
  .map((o) => o.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const allowed = allowedOrigins.some((ao) =>
        ao.includes("*")
          ? new RegExp("^" + ao.replace(/\*/g, ".*") + "$").test(origin)
          : ao === origin
      );
      callback(null, allowed || undefined);
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(requestIdMiddleware);
app.use(requestLogger);
app.use(rateLimit(100, 60 * 1000)); // Global: 100 req/min per IP

// Health check
app.get("/health", async (_req, res) => {
  const checks: Record<string, string> = {};

  // Database check
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.db = "ok";
  } catch {
    checks.db = "error";
  }

  // Redis check
  try {
    const redis = getRedis();
    if (redis) {
      await redis.ping();
      checks.redis = "ok";
    } else {
      checks.redis = "not_configured";
    }
  } catch {
    checks.redis = "error";
  }

  const allOk = Object.values(checks).every((v) => v === "ok" || v === "not_configured");
  res.status(allOk ? 200 : 503).json({
    status: allOk ? "ok" : "degraded",
    service: "atlas-api",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    checks,
  });
});

// Routes
app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/voice", voiceRouter);
app.use("/api/drafts", draftsRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/alerts", alertsRouter);
app.use("/api/research", researchRouter);
app.use("/api/trending", trendingRouter);
app.use("/api/images", imagesRouter);

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

app.listen(PORT, () => {
  logger.info({ port: PORT }, `Atlas API running on port ${PORT}`);
});

export default app;
