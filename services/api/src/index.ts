import "./lib/sentry"; // Must be first — initializes Sentry before other imports
import { Sentry } from "./lib/sentry";
import { createServer } from "http";
import express from "express";
import cookieParser from "cookie-parser";
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
import { loopRouter } from "./routes/loop";
import briefingRouter from "./routes/briefing";
import { docsRouter } from "./routes/docs";
import { xAuthRouter } from "./routes/x-auth";
import { buildErrorResponse, requestIdMiddleware } from "./middleware/requestId";
import { rateLimit } from "./middleware/rateLimit";
import { requestLogger } from "./middleware/requestLogger";
import { logger } from "./lib/logger";
import { formatErrorResponse } from "./lib/errors";
import { prisma } from "./lib/prisma";
import { getRedis } from "./lib/redis";
import { initBot } from "./lib/telegram";
import { initSocket } from "./lib/socket";

dotenv.config();

const app = express();
const PORT = config.PORT;

const allowedOrigins = [
  ...config.FRONTEND_URL.split(",").map((o) => o.trim()),
  // Always allow staging + localhost for development
  "https://staging-delphi-atlas.vercel.app",
  "https://delphi-atlas-git-staging-*.vercel.app",
  "http://localhost:3000",
  "http://localhost:3001",
].filter(Boolean);

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
app.use(cookieParser());
app.use(requestIdMiddleware);
app.use(requestLogger);
app.use(rateLimit(100, 60 * 1000)); // Global: 100 req/min per IP

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
app.use("/api/docs", docsRouter);
app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/voice", voiceRouter);
app.use("/api/drafts", draftsRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/alerts", alertsRouter);
app.use("/api/research", researchRouter);
app.use("/api/trending", trendingRouter);
app.use("/api/images", imagesRouter);
app.use("/api/loop", loopRouter);
app.use("/api/briefing", briefingRouter);
app.use("/api/auth/x", xAuthRouter);

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
server.timeout = 120_000; // 2 min — AI generation routes need more than Railway's 30s default
server.keepAliveTimeout = 65_000;
initSocket(server, allowedOrigins);

server.listen(PORT, () => {
  logger.info({ port: PORT }, `Atlas API running on port ${PORT}`);
});

export default app;
