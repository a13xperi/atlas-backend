import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(8000),
  FRONTEND_URL: z
    .string()
    .default("https://delphi-atlas.vercel.app,https://atlas-staging.vercel.app,http://localhost:3000"),

  // Auth
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),

  // Database
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // Redis (optional — caching degrades gracefully)
  REDIS_URL: z.string().optional(),

  // AI providers
  GOOGLE_AI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  XAI_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),

  // Supabase (optional — legacy JWT fallback if not set)
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_JWT_SECRET: z.string().optional(),

  // Twitter / X
  TWITTER_BEARER_TOKEN: z.string().optional(),
  TWITTER_CLIENT_ID: z.string().optional(),
  TWITTER_CLIENT_SECRET: z.string().optional(),
  TWITTER_OAUTH_CALLBACK_URL: z.string().optional(),
  TWITTER_LOGIN_CALLBACK_URL: z.string().optional(),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().optional(),

  // Monitoring
  SENTRY_DSN: z.string().optional(),
});

type Env = z.infer<typeof envSchema>;

function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const missing = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(`\n❌ Environment validation failed:\n${missing}\n`);
    if (process.env.NODE_ENV === "production") {
      process.exit(1);
    }
    // In dev/test, use defaults for what we can
    return envSchema.parse({
      ...process.env,
      JWT_SECRET: process.env.JWT_SECRET || "dev-only-secret-do-not-use-in-production",
      DATABASE_URL: process.env.DATABASE_URL || "postgresql://localhost:5432/atlas",
    });
  }

  return result.data;
}

export const config = validateEnv();
