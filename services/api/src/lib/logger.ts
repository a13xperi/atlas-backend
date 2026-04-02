import pino from "pino";

// Read NODE_ENV directly — logger initializes before config to avoid circular dep
const nodeEnv = process.env.NODE_ENV || "development";

export const logger = pino({
  level: nodeEnv === "test" ? "silent" : "info",
  transport:
    nodeEnv === "development"
      ? { target: "pino/file", options: { destination: 1 } }
      : undefined,
  base: { service: "atlas-api" },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});
