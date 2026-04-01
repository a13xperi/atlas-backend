import "./lib/sentry"; // Must be first — initializes Sentry before other imports
import { Sentry } from "./lib/sentry";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
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
import { initBot } from "./lib/telegram";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8000;

const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:3000")
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

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "atlas-api", timestamp: new Date().toISOString() });
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

// Sentry error handler — must be before any other error middleware
Sentry.setupExpressErrorHandler(app);

// Global error handler
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err.message, err.stack);
  res.status(500).json(
    buildErrorResponse(req, "Internal server error", {
      message: err.message,
    })
  );
});

app.listen(PORT, () => {
  console.log(`Atlas API running on port ${PORT}`);
});

export default app;
