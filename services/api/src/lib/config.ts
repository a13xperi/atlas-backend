import { z } from "zod";
import { logger } from "./logger";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "staging", "test"]).default("development"),
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

  // Rate limiting
  RATE_LIMIT_AUTH_MAX_REQUESTS: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_AUTH_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  // Stricter per-endpoint limits layered on top of the router-level auth limit
  // to raise the cost of credential stuffing / mass-registration attacks.
  RATE_LIMIT_LOGIN_MAX_REQUESTS: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_LOGIN_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60_000),
  RATE_LIMIT_REGISTER_MAX_REQUESTS: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_REGISTER_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60_000),
  // Docs (swagger UI) — unauthenticated and file-backed, keep it cheap per IP.
  RATE_LIMIT_DOCS_MAX_REQUESTS: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_DOCS_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_AI_GENERATION_MAX_REQUESTS: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_AI_GENERATION_WINDOW_MS: z.coerce.number().int().positive().default(60 * 60 * 1000),
  RATE_LIMIT_GENERAL_MAX_REQUESTS: z.coerce.number().int().positive().default(500),
  RATE_LIMIT_GENERAL_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  // AI providers
  GOOGLE_AI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  GEMINI_IMAGE_MODEL: z.string().optional(),
  XAI_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),

  // Supabase (optional — legacy JWT fallback if not set)
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_JWT_SECRET: z.string().optional(),
  SUPABASE_PROJECT_REF: z.string().optional(),
  SUPABASE_MANAGEMENT_API_TOKEN: z.string().optional(),

  // Twitter / X
  TWITTER_BEARER_TOKEN: z.string().optional(),
  TWITTER_CLIENT_ID: z.string().optional(),
  TWITTER_CLIENT_SECRET: z.string().optional(),
  TWITTER_OAUTH_CALLBACK_URL: z.string().optional(),
  TWITTER_LOGIN_CALLBACK_URL: z.string().optional(),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().optional(),

  // Paperclip
  PAPERCLIP_API_KEY: z.string().optional(),
  PAPERCLIP_WEBHOOK_SECRET: z.string().optional(),

  // Monitoring
  SENTRY_DSN: z.string().optional(),

  // GitHub — used by the AutoResearch loop PR creation flow in
  // routes/loop.ts. Values are still read from process.env at request
  // time (so tests that set them per-test keep working), but the
  // fallback values live here via the exported constants below so the
  // hardcoded defaults don't drift away from the documented .env.example.
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_OWNER: z.string().optional(),
  GITHUB_REPO: z.string().optional(),

  // Backup — R2 (Cloudflare) logical dumps
  R2_ENDPOINT: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),

  // Backup — local logical dumps
  BACKUP_LOCAL_DIR: z.string().optional().default("./backups"),
  BACKUP_RETENTION_DAYS: z.coerce.number().optional().default(7),
});

type Env = z.infer<typeof envSchema>;

function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const missing = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    // logger.ts reads NODE_ENV directly so it resolves before this file
    // runs — safe to use here even though config hasn't finished loading.
    // We prefer structured output over a bare console.error so Railway and
    // other log aggregators can index the failure; the CLI smoke-test
    // scripts are the only places that still talk to the raw console.
    logger.error(
      { missing: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      `Environment validation failed:\n${missing}`,
    );
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

/**
 * Default values for GitHub integration envs.
 *
 * These live in `config.ts` so the fallback used by `routes/loop.ts` and
 * any future consumer comes from one place — instead of an inline
 * `process.env.X || "string"` scattered across handlers. The values
 * mirror the defaults documented in `.env.example`.
 *
 * Why defaults-as-constants and not zod `.default()`?
 *
 * The loop handlers read `process.env.GITHUB_*` at REQUEST time (not
 * module-load time) so the Jest suite can swap envs between tests.
 * Putting these into the zod schema as `.default()` would freeze them
 * at module-load and silently break `loop.test.ts`'s per-test env
 * mutation. Exported constants preserve the test ergonomics while still
 * centralising the canonical value — bump them here and the next
 * request picks them up.
 */
export const DEFAULT_GITHUB_OWNER = "a13xperi";
export const DEFAULT_GITHUB_REPO = "atlas-portal";
