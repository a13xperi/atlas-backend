## SESSION COORDINATION (read first)
Multiple CC sessions + Codex tasks run concurrently on this repo.
Before starting ANY work:
1. Read `.coordination/STATUS.json` — check `do_not_touch` array
2. Never modify a file listed in `do_not_touch` (another session owns it)
3. Use `/claim-task` to atomically claim work (Supabase lock + Notion update)
4. After completing a task, run `/sync-coordination` to update bridge files

Session ID format: `CC-{N}-{repo}` (e.g. `CC-1-backend`)
Coordination DB: Supabase project `zoirudjyqfqvpxsrxepr`, table `session_locks`

## MULTI-AGENT BUILD PROTOCOL
This project uses multiple AI coding tools in parallel.
READ ATLAS-BUILD-CONTEXT.md for full project context and architecture.
Check `.coordination/STATUS.json` for live task assignments (replaces TASK-STATUS.md).

## YOUR ROLE: Backend Lane (Claude Code)
You ONLY modify: services/api/src/*, prisma/*, package.json, tsconfig.json
DO NOT touch: frontend repo (atlas-portal), test files (Cursor lane)

## AFTER EVERY COMMIT
1. Run `/sync-coordination` to update bridge files
2. git add -A && git commit -m "[claude-code] type: description" && git push

---

# CLAUDE.md — Atlas Backend API

## Project
Backend services for Atlas by Delphi Digital — a content-to-tweet crafting platform with personalized voice/tonality for crypto analysts.

## Stack
- Express 4 with TypeScript
- Prisma ORM with PostgreSQL
- Redis (ioredis) for caching
- JWT authentication (jsonwebtoken + bcryptjs)
- Telegraf for Telegram bot
- Anthropic Claude SDK for tweet generation
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
      alerts.ts         # GET/POST/PATCH/DELETE /subscriptions, GET /feed
      analytics.ts      # GET /summary, /learning-log, /engagement, /team
      auth.ts           # POST /register, /login, GET /me
      briefing.ts       # Briefing preferences and delivery
      campaigns.ts      # Campaign CRUD and management
      docs.ts           # API documentation
      drafts.ts         # GET/POST/PATCH/DELETE /drafts
      images.ts         # AI image generation
      loop.ts           # Background loop/scheduler endpoints
      monitors.ts       # NLP monitor CRUD
      oracle.ts         # Oracle AI copilot endpoints
      qa.ts             # QA test run management (Supabase-backed)
      research.ts       # Research result endpoints
      transcribe.ts     # Voice note transcription
      trending.ts       # Trending topic feeds
      users.ts          # GET/PATCH /profile, GET /team
      voice.ts          # GET/PATCH /profile, GET/POST /references, GET/POST /blends
      x-auth.ts         # X/Twitter OAuth flow
  telegram-bot/src/     # Telegraf bot
  voice-worker/src/     # Background processing
prisma/
  schema.prisma         # 17 models: User, Session, VoiceProfile, ReferenceVoice, SavedBlend, BlendVoice, TweetDraft, AnalyticsEvent, AlertSubscription, Alert, LearningLogEntry, ResearchResult, BriefingPreference, Briefing, GeneratedImage, NlpMonitor, Campaign
```

## API Routes (all live and tested)
- `POST /api/auth/register` — { handle, onboardingTrack? } → { user, token }
- `POST /api/auth/login` — { handle } → { user, token }
- `GET /api/auth/me` — → { user + voiceProfile }
- `GET/PATCH /api/users/profile` — user profile CRUD
- `GET /api/users/team` — team list (MANAGER/ADMIN only)
- `GET/PATCH /api/voice/profile` — 12 voice dimensions (humor, formality, brevity, contrarianTone, directness, warmth, technicalDepth, confidence, evidenceOrientation, solutionOrientation, socialPosture, selfPromotionalIntensity)
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
1. Queue initiative (intelligent draft queue UI)
2. Campaign engine (PDF→multi-tweet workflow)
3. Oracle evolution (persistent AI copilot)
