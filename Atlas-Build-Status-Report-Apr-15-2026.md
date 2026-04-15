# Atlas — Build Status Report (Apr 15, 2026)

---

## 🚀 What shipped in the last 36 hours

### The big ship event
- **Production v2 is live** — the full codebase shipped from staging to main today at 13:00.

### Portal (27 PRs)
- **Onboarding rebuilt** — swipe-based onboarding UI, real tweet scan UI with error surfacing, clearer pole labels on voice calibration sliders, and guards against bad calibration output.
- **Voice & crafting upgraded** — new VoicePillBar and RecipeCard components, workspace moved above the fold, voice sliders now populate correctly after calibration, and skip-card animations work smoothly.
- **Navigation & admin improved** — admin and feedback are always visible for admins, admin shortcut added to primary nav, test reset button added, and the profile page is restored.
- **Security & infrastructure hardened** — CORS stubs and oracle fixtures for e2e testing, CSP fallback for Supabase, safe default CDN origins, X avatar fallback via unavatar, staging CI unblocked (9 failing tests fixed), and alerts gated behind a feature flag.

### Backend (20 PRs)
- **Auth & security hardened** — JWT revocation with Redis jti blocklist, Twitter OAuth origin-safe refresh, hardcoded passwords removed from seed scripts, and env-var fail-fast guards.
- **Voice & calibration tightened** — safe reference voice fallback for blends, rejection of degenerate all-zero AI calibration output, top-engaged + most-recent tweet blend for calibration, and xAvatarUrl persisted and mapped correctly.
- **Campaigns & features expanded** — batch post-all capped at 25 drafts, NLP alerts, scheduled briefing delivery, swipe-onboarding API routes, and PATCH/DELETE voice blends endpoints.
- **Infrastructure stabilized** — env hygiene CI guardrails, production smoke tests skipped unless enabled, Railway staging branch reliability improved, and a stale branch regression reverted.

---

## 🎯 Where things stand today

Atlas is live in production. The auth layer is hardened with JWT revocation and origin-safe OAuth refresh. Voice onboarding has been completely rebuilt with a swipe-based flow and real tweet scanning. The crafting page was redesigned with workspace above the fold and a cleaner voice selection experience. Admin tooling is now accessible directly from the primary nav. Both portal and backend CI are green and stable.

---

## 🔧 What's being fixed right now

- **Kimi** is closing out 3 remaining voice UI bugs: gray circles on avatars, incorrect "Onboarding blend" names, and a missing active indicator.
- **Codex** is opening a backend PR for the briefing / oracle / campaigns bundle.
- **Production** is running at [delphi-atlas.vercel.app](https://delphi-atlas.vercel.app) and [api-production-9bef.up.railway.app](https://api-production-9bef.up.railway.app).

---

## 📦 What's landing next (this week)

- Voice naming fixed consistently across all profiles.
- Twitter avatars displayed on all voice recipe cards.
- Backend batch campaign posting and per-user briefing timezone support.
- SSE oracle streaming for real-time updates.
- 20 stale branches automatically cleaned up.

---

## ✅ Atlas is stable and shipping

In the last 36 hours, 47 PRs merged across portal and backend. Production v2 is live. Auth is hardened. Voice onboarding and crafting are materially better. The team is actively closing the last known UI bugs and opening the next feature bundle. Momentum is strong and the pipeline is clear.
