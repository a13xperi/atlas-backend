# AGENTS.md — Atlas Backend (Codex Context)

## Project
Backend API for Atlas by Delphi Digital — a content-to-tweet crafting platform with personalized voice/tonality for crypto analysts.

## Stack
- Express 4 + TypeScript
- Prisma ORM + PostgreSQL (Supabase)
- Redis (ioredis) for caching
- JWT authentication (jsonwebtoken + bcryptjs)
- Zod for request validation
- Jest + Supertest for testing (14 test files)
- GitHub Actions CI with PostgreSQL + Redis services

## Structure
```
services/api/src/
  index.ts                    # Express app entry point
  middleware/auth.ts           # JWT auth middleware — DO NOT MODIFY
  lib/
    prisma.ts                 # Prisma client singleton
    anthropic.ts              # Claude SDK wrapper
    gemini.ts                 # Gemini SDK wrapper
    openai.ts                 # OpenAI SDK wrapper
    grok.ts                   # Grok SDK wrapper
    generate.ts               # Tweet generation orchestrator
    prompt.ts                 # Prompt building utilities
    research.ts               # Research/content ingestion
    redis.ts                  # Redis client + cache helpers
  routes/
    auth.ts                   # POST /register, /login, GET /me
    users.ts                  # GET/PATCH /profile, GET /team
    voice.ts                  # Voice profile + blends + references
    drafts.ts                 # Tweet draft CRUD
    analytics.ts              # Analytics summaries + learning log
    alerts.ts                 # Alert subscriptions + feed
    images.ts                 # Image generation
    research.ts               # Research endpoints
    trending.ts               # Trending topics
  __tests__/
    auth.test.ts              # Auth route tests
    middleware.test.ts         # Auth middleware tests
    lib/generate.test.ts      # Generate lib tests
    lib/prompt.test.ts        # Prompt lib tests
    lib/research.test.ts      # Research lib tests
    lib/redis.test.ts         # Redis lib tests
    routes/users.test.ts
    routes/voice.test.ts
    routes/drafts.test.ts
    routes/analytics.test.ts
    routes/alerts.test.ts
    routes/images.test.ts
    routes/research.test.ts
    routes/trending.test.ts
prisma/
  schema.prisma               # Database schema (13 models)
```

## Commands
```bash
npm test              # Run all tests (Jest)
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
npm run build         # TypeScript compile
npx prisma validate   # Validate schema changes
npx prisma generate   # Regenerate Prisma client after schema changes
```

## Branch Convention
All Codex branches MUST use the prefix: `codex/{description}`

Example: `codex/add-trending-pagination`, `codex/fix-draft-validation`

## PR Convention
- Target branch: `staging` (never `main`)
- PR title: concise description of the change
- PR body: include what changed, what tests cover it, and the Notion task ID if provided in the prompt

## DO NOT MODIFY
- `services/api/src/middleware/auth.ts` — auth middleware is shared across all routes; changes here require coordinated review
- `railway.json`, `nixpacks.toml` — deploy configuration
- `.github/workflows/` — CI configuration (unless specifically asked)
- `prisma/schema.prisma` — only modify if the task explicitly requires schema changes, and always run `npx prisma validate` after

## Coding Standards
- All route handlers wrapped in try/catch with consistent error responses: `res.status(XXX).json({ error: "message" })`
- Auth middleware adds `req.userId` — use this, don't re-derive from tokens
- Prisma client imported from `lib/prisma.ts` — never instantiate a new PrismaClient
- Use Zod for request body validation on all POST/PATCH routes
- Analytics events auto-logged on draft create/post/feedback — maintain this pattern
- Manager-only routes check `user.role !== "ANALYST"`
- All new routes must have a corresponding test file in `__tests__/routes/`
- All new lib modules must have a corresponding test file in `__tests__/lib/`

## Database Models (Key Enums)
- Role: ANALYST, MANAGER, ADMIN
- VoiceMaturity: BEGINNER, INTERMEDIATE, ADVANCED
- DraftStatus: DRAFT, APPROVED, POSTED, ARCHIVED
- SourceType: REPORT, ARTICLE, TWEET, TRENDING_TOPIC, VOICE_NOTE, MANUAL
- AlertType: CATEGORY, ACCOUNT, REPORT_TYPE
- AlertDelivery: PORTAL, TELEGRAM

## Testing Patterns
- Tests use Supertest to make HTTP requests against the Express app
- Database is mocked via Prisma's `jest.mock` pattern (see existing test files for examples)
- Redis is mocked via `ioredis-mock`
- Auth tokens generated in test setup using `jsonwebtoken.sign()`
- Each test file is independent — no shared state between files
