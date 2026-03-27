# Atlas Backend — Test Coverage Plan

## Mission
Add Jest test suites for all routes, middleware, and lib modules. NO source code changes.

## Status Legend
- [ ] Not started
- [x] Complete

---

## Setup
- [x] Create jest.config.js at repo root
- [x] Create tsconfig for tests (if needed)

## Middleware Tests
- [ ] `services/api/src/__tests__/middleware/auth.test.ts`

## Route Tests
- [x] `services/api/src/__tests__/auth.test.ts` (15 tests passing)
- [ ] `services/api/src/__tests__/routes/users.test.ts`
- [ ] `services/api/src/__tests__/routes/voice.test.ts`
- [x] `services/api/src/__tests__/routes/drafts.test.ts` (24 tests passing)
- [ ] `services/api/src/__tests__/routes/analytics.test.ts`
- [ ] `services/api/src/__tests__/routes/alerts.test.ts`
- [ ] `services/api/src/__tests__/routes/research.test.ts`
- [ ] `services/api/src/__tests__/routes/trending.test.ts`
- [ ] `services/api/src/__tests__/routes/images.test.ts`

## Lib Tests
- [ ] `services/api/src/__tests__/lib/generate.test.ts`
- [ ] `services/api/src/__tests__/lib/prompt.test.ts`
- [ ] `services/api/src/__tests__/lib/redis.test.ts`
- [ ] `services/api/src/__tests__/lib/research.test.ts`

## Notes
- All external services (Prisma, OpenAI, Gemini, Grok, Redis) must be mocked
- Test HTTP status codes, response shapes, auth guards, and error handling
- Use supertest for HTTP-level testing
