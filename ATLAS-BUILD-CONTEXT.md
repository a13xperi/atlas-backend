# Atlas Build Context — Shared Multi-Agent Protocol
# Last updated: 2026-04-03
# All AI tools: READ THIS FIRST before doing any work.

## SESSION COORDINATION (NEW — Apr 3, 2026)
Multiple CC sessions + Codex tasks run concurrently. Coordination via:
- **Supabase** `session_locks` table (project `zoirudjyqfqvpxsrxepr`) — atomic task locking
- **`.coordination/STATUS.json`** — machine-readable state (active sessions, claimed files, do_not_touch)
- **`.coordination/CODEX-BRIEFING.md`** — Codex reads this to avoid claimed files
- **Notion Build Tracker `Claimed By` field** — session ID of who owns the task
Before modifying any file, check `.coordination/STATUS.json` `do_not_touch` array.
Use `/claim-task` to lock work. Use `/sync-coordination` after completing work.

## PROJECT OVERVIEW
Atlas is a content-to-tweet platform for crypto analysts at Delphi Digital.
Frontend: Next.js 14, Tailwind, deployed on Vercel (delphi-atlas.vercel.app)
Backend: Express, Prisma, PostgreSQL, Redis, deployed on Railway
GitHub: a13xperi/atlas-backend (this repo), a13xperi/atlas-portal (frontend)
Branch: main (auto-deploy)

## ARCHITECTURE
Browser → Vercel (Next.js 14) → Railway (Express) → PostgreSQL + Redis
AI Providers (4): OpenAI gpt-4o, Anthropic Claude, Gemini Flash, Grok-3
External: Supabase Auth, Telegram, Sentry, X/Twitter
Stats: 51 backend files (~4K LOC), 12 frontend routes, 10 components,
16 Prisma models, 4 AI providers, 35+ endpoints

## FILE OWNERSHIP — CRITICAL: DO NOT VIOLATE
Claude Code owns: services/api/src/*, prisma/*, package.json
Codex owns: services/api/src/routes/* (new route files only), services/api/src/lib/* (new lib files only)
Cursor owns: services/api/src/__tests__/*, *.test.ts
Warp owns: deployment only, no file edits
SHARED (coordinate first): README.md, .env.example, .github/*, ATLAS-BUILD-CONTEXT.md, TASK-STATUS.md

## COMMIT FORMAT
[tool] type: description
Examples: [claude-code] fix: add userId filter to alerts endpoint

## CONFLICT RULES
1. NEVER modify files outside your lane
2. ALWAYS git pull before starting work
3. ALWAYS push immediately after committing
4. If merge conflict: STOP, note in TASK-STATUS.md

## KNOWN P0 ISSUES
1. Alert feed exposes ALL users' alerts (services/api/src/routes/alerts.ts) → Claude Code
2. /analytics crashes on empty data → Cursor
3. No error.tsx on 10/12 frontend routes → Cursor (atlas-portal repo)
4. Sentry DSN hardcoded in lib/config.ts → Claude Code

## DATABASE SCHEMA
User → VoiceProfile (1:1), ReferenceVoice (1:n), SavedBlend (1:n)
User → TweetDraft (1:n), AlertSubscription (1:n), Alert (1:n)
Enums: Role (ANALYST/MANAGER/ADMIN), OnboardingTrack, DraftStatus

## API ROUTES (services/api/src/routes/ — 13 files, 35+ endpoints)
auth.ts, voice.ts, drafts.ts, users.ts, analytics.ts,
alerts.ts, research.ts, images.ts, trending.ts

## AUTH FLOW
Login → JWT + HttpOnly cookies → sessionStorage Bearer fallback
Dual-mode: Supabase JWT + legacy JWT

## AI ROUTING
OpenAI gpt-4o → tweets, Anthropic → research, Gemini → images, Grok → trending
