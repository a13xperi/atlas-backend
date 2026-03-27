# Ralph Fix Plan — Atlas Backend Test Coverage

## High Priority
- [x] Set up Jest + ts-jest infrastructure (jest.config, tsconfig for tests)
- [x] Add test suite for auth routes (register, login, me) — mock Prisma + bcrypt + JWT
- [ ] Add test suite for drafts routes (CRUD + generate/regenerate) — mock Prisma + OpenAI
- [ ] Add test suite for voice routes (profile CRUD, references, blends) — mock Prisma
- [x] Add test suite for auth middleware (JWT verification, req.userId injection)

## Medium Priority
- [ ] Add test suite for analytics routes (summary, learning-log, engagement, team) — mock Prisma
- [ ] Add test suite for alerts routes (subscriptions CRUD, feed) — mock Prisma
- [ ] Add test suite for research routes — mock OpenAI + Redis cache
- [ ] Add test suite for trending routes — mock Grok + Redis cache
- [ ] Add test suite for images routes — mock Gemini
- [ ] Add test suite for users routes (profile, team) — mock Prisma

## Low Priority
- [ ] Add test suite for lib/generate.ts (tweet generation logic, prompt building)
- [ ] Add test suite for lib/research.ts (research conductor)
- [ ] Add test suite for lib/redis.ts (cache utilities)
- [ ] Validate Zod schemas on all input endpoints

## Completed
- [x] Project enabled for Ralph

## Notes
- Mock ALL external services: Prisma, OpenAI, Gemini, Grok, Redis — do NOT make real API calls
- Mock Prisma using jest.mock, not a real database
- This is a production-deployed API on Railway — do NOT modify existing route logic
- Do NOT modify prisma/schema.prisma
- Focus on testing existing behavior, not adding new features
- Mark tasks as [x] in this file as you complete them
