# CLAUDE.md — Atlas Backend API

## Project
Backend services for Atlas by Delphi Digital — a content-to-tweet crafting platform with personalized voice/tonality for crypto analysts.

## Stack
- Express 4 with TypeScript
- Prisma ORM with PostgreSQL
- Redis (ioredis) for caching
- JWT authentication (jsonwebtoken + bcryptjs)
- Telegraf for Telegram bot (planned)
- Anthropic Claude SDK for tweet generation (planned)
- Zod for validation

## Repositories
- Backend: https://github.com/a13xperi/atlas-backend
- Frontend: https://github.com/a13xperi/atlas-portal

## Deployed URLs
### Production
- API: https://api-production-9bef.up.railway.app
- Health check: https://api-production-9bef.up.railway.app/health
- Frontend: https://delphi-atlas.vercel.app

### Staging
- API: auto-provisioned on Railway staging environment
- Frontend: https://staging-delphi-atlas.vercel.app

## Environments
- **Branches:** `main` (production), `staging` (staging)
- **Branch protection:** Both branches have GitHub rulesets — main requires PR + 1 approval + status checks; staging requires status checks + allows admin direct push
- **CI:** GitHub Actions workflow (`ci.yml`) runs type-check + tests on push/PR to main and staging
- **CORS:** Multi-origin support via comma-separated `FRONTEND_URL` with wildcard pattern matching

## Railway
- Project ID: 2c9ea379-6c4b-4e39-a31b-357b43ddeb11
- **Production:** Postgres + Redis + API (from GitHub main branch)
- **Staging:** Separate Postgres + Redis + API instances (from GitHub staging branch)
- Prisma db push runs on startup to sync schema
- `GEMINI_MODEL` env var controls which Gemini model is used (not hardcoded)

## Architecture
```
services/
  api/src/
    index.ts            # Express app entry point
    lib/prisma.ts       # Prisma client singleton
    middleware/auth.ts   # JWT auth middleware
    routes/
      auth.ts           # POST /register, /login, GET /me
      users.ts          # GET/PATCH /profile, GET /team
      voice.ts          # GET/PATCH /profile, GET/POST /references, GET/POST /blends
      drafts.ts         # GET/POST/PATCH/DELETE /drafts
      analytics.ts      # GET /summary, /learning-log, /engagement, /team
      alerts.ts         # GET/POST/PATCH/DELETE /subscriptions, GET /feed
  telegram-bot/src/     # (planned) Telegraf bot
  voice-worker/src/     # (planned) Background processing
prisma/
  schema.prisma         # 10 models: Users, Sessions, VoiceProfiles, ReferenceVoices, SavedBlends, BlendVoices, TweetDrafts, AnalyticsEvents, AlertSubscriptions, Alerts, LearningLog
```

## API Routes (all live and tested)
- `POST /api/auth/register` — { handle, onboardingTrack? } → { user, token }
- `POST /api/auth/login` — { handle } → { user, token }
- `GET /api/auth/me` — → { user + voiceProfile }
- `GET/PATCH /api/users/profile` — user profile CRUD
- `GET /api/users/team` — team list (MANAGER/ADMIN only)
- `GET/PATCH /api/voice/profile` — voice dimensions (humor, formality, brevity, contrarianTone)
- `GET/POST /api/voice/references` — reference voice accounts
- `GET/POST /api/voice/blends` — saved voice blends with percentages
- `GET/POST/PATCH/DELETE /api/drafts` — tweet draft CRUD, auto-logs analytics events
- `GET /api/analytics/summary` — 30-day counts (drafts, posts, feedback, refinements, ingested)
- `GET /api/analytics/learning-log` — model learning entries
- `GET /api/analytics/engagement` — engagement events (7 days)
- `GET /api/analytics/team` — team analytics (MANAGER only)
- `GET/POST/PATCH/DELETE /api/alerts/subscriptions` — alert subscription management
- `GET /api/alerts/feed` — recent alerts

## Database Models
Key enums: Role (ANALYST/MANAGER/ADMIN), VoiceMaturity (BEGINNER/INTERMEDIATE/ADVANCED), DraftStatus (DRAFT/APPROVED/POSTED/ARCHIVED), SourceType (REPORT/ARTICLE/TWEET/TRENDING_TOPIC/VOICE_NOTE/MANUAL), AlertType (CATEGORY/ACCOUNT/REPORT_TYPE), AlertDelivery (PORTAL/TELEGRAM)

## Conventions
- All routes wrapped in try/catch with error responses
- Auth middleware at `authenticate` — adds `req.userId`
- Prisma client singleton at `lib/prisma.ts`
- Analytics events auto-logged on draft create/post/feedback
- Manager-only routes check `user.role !== "ANALYST"`

## What's Next
1. Wire remaining frontend pages to API
2. Telegram bot service (services/telegram-bot/)
3. AI integration — Claude API for tweet generation from content objects
4. Background voice-worker for async processing
