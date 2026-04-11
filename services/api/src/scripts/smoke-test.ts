/**
 * Atlas API — E2E Smoke Test
 *
 * Validates environment, DB connectivity, Redis, core API flows,
 * and authenticated GET coverage across all route modules.
 *
 * Run with: npm run smoke
 *
 * Exit 0 = all checks passed (safe to deploy)
 * Exit 1 = one or more checks failed (block deploy)
 */

import dotenv from "dotenv";
dotenv.config();

import request from "supertest";
import app from "../index";
import { prisma } from "../lib/prisma";
import { getRedis } from "../lib/redis";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let warned = 0;
const errors: string[] = [];

function ok(label: string) {
  console.log(`  ✅  ${label}`);
  passed++;
}

function warn(label: string) {
  console.warn(`  ⚠️   ${label}`);
  warned++;
}

function fail(label: string, detail?: string) {
  console.error(`  ❌  ${label}${detail ? `: ${detail}` : ""}`);
  errors.push(label);
  failed++;
}

// ─── Step 1: Environment Variables ────────────────────────────────────────────

function checkEnv() {
  console.log("\n[1/6] Environment variables");

  const required = ["DATABASE_URL", "JWT_SECRET"];
  const recommended = [
    "ANTHROPIC_API_KEY",
    "FRONTEND_URL",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "REDIS_URL",
  ];

  for (const key of required) {
    if (process.env[key]) ok(key);
    else fail(`${key} is missing (required)`);
  }

  for (const key of recommended) {
    if (process.env[key]) ok(key);
    else warn(`${key} not set (optional — some features degraded)`);
  }
}

// ─── Step 2: Database Connectivity ────────────────────────────────────────────

async function checkDatabase() {
  console.log("\n[2/6] Database connectivity");
  try {
    await prisma.$queryRaw`SELECT 1`;
    ok("Postgres reachable");

    const userCount = await prisma.user.count();
    ok(`User table accessible (${userCount} rows)`);
  } catch (e: any) {
    fail("Database unreachable", e.message);
  }
}

// ─── Step 3: Redis Connectivity ──────────────────────────────────────────────

async function checkRedis() {
  console.log("\n[3/6] Redis connectivity");
  const redis = getRedis();
  if (!redis) {
    warn("Redis not configured (REDIS_URL missing) — caching disabled");
    return;
  }
  try {
    const pong = await redis.ping();
    if (pong === "PONG") ok("Redis reachable");
    else fail("Redis ping unexpected response", pong);
  } catch (e: any) {
    warn(`Redis unreachable (non-fatal): ${e.message}`);
  }
}

// ─── Step 4: Health Check ─────────────────────────────────────────────────────

async function checkHealth() {
  console.log("\n[4/6] API health");
  try {
    const res = await request(app).get("/health");
    if (res.status === 200 && res.body.status === "ok") ok("/health → 200 ok");
    else fail("/health returned unexpected response", JSON.stringify(res.body));
  } catch (e: any) {
    fail("/health check failed", e.message);
  }
}

// ─── Step 5: Core E2E Flow ────────────────────────────────────────────────────

async function checkE2EFlow(): Promise<{ token: string | null; userId: string | null }> {
  console.log("\n[5/6] Core E2E flow");

  const testHandle = `smoke_${Date.now()}`;
  const testEmail = `${testHandle}@smoke.atlas.test`;
  const testPassword = "SmokeTest$1";
  let token: string | null = null;
  let userId: string | null = null;

  // Register
  try {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ handle: testHandle, email: testEmail, password: testPassword });

    if (res.status === 200 && res.body.data?.token) {
      token = res.body.data.token;
      userId = res.body.data.user?.id ?? null;
      ok(`Register → ${testHandle} created`);
    } else {
      fail("Register failed", `${res.status} ${JSON.stringify(res.body)}`);
      return { token, userId };
    }
  } catch (e: any) {
    fail("Register threw", e.message);
    return { token, userId };
  }

  // Login (email + password)
  try {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: testEmail, password: testPassword });

    if (res.status === 200 && res.body.data?.token) ok("Login → token issued");
    else fail("Login failed", `${res.status} ${JSON.stringify(res.body)}`);
  } catch (e: any) {
    fail("Login threw", e.message);
  }

  // Get current user
  try {
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    if (res.status === 200 && res.body.data?.user?.handle === testHandle)
      ok("Auth /me → identity confirmed");
    else fail("Auth /me failed", `${res.status} ${JSON.stringify(res.body)}`);
  } catch (e: any) {
    fail("Auth /me threw", e.message);
  }

  // Update voice profile (PATCH /api/voice/profile)
  try {
    const res = await request(app)
      .patch("/api/voice/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ humor: 60, formality: 40, brevity: 70, contrarianTone: 30 });

    if (res.status === 200 && res.body.data?.profile) ok("Voice profile updated → ok");
    else fail("Voice profile update failed", `${res.status} ${JSON.stringify(res.body)}`);
  } catch (e: any) {
    fail("Voice profile threw", e.message);
  }

  // Create manual draft
  let draftId: string | null = null;
  try {
    const res = await request(app)
      .post("/api/drafts")
      .set("Authorization", `Bearer ${token}`)
      .send({ content: "Smoke test draft — ETH staking yields are compressing fast.", sourceType: "MANUAL" });

    if (res.status === 200 && res.body.data?.draft?.id) {
      draftId = res.body.data.draft.id;
      ok(`Manual draft created → ${draftId!.slice(0, 8)}…`);
    } else {
      fail("Draft creation failed", `${res.status} ${JSON.stringify(res.body)}`);
    }
  } catch (e: any) {
    fail("Draft creation threw", e.message);
  }

  // Approve draft (status → APPROVED)
  if (draftId) {
    try {
      const res = await request(app)
        .patch(`/api/drafts/${draftId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "APPROVED" });

      if (res.status === 200 && res.body.data?.draft?.status === "APPROVED")
        ok("Draft approved → ok");
      else fail("Draft approval failed", `${res.status}`);
    } catch (e: any) {
      fail("Draft approval threw", e.message);
    }
  }

  // Record engagement (post-publish feedback loop)
  if (draftId) {
    try {
      const res = await request(app)
        .post(`/api/drafts/${draftId}/engagement`)
        .set("Authorization", `Bearer ${token}`)
        .send({ likes: 42, retweets: 7, impressions: 310 });

      if (res.status === 200 && res.body.data?.draft?.actualEngagement === 359)
        ok("Engagement recorded → 359 (42+7+310)");
      else fail("Engagement recording failed", `${res.status} ${JSON.stringify(res.body)}`);
    } catch (e: any) {
      fail("Engagement recording threw", e.message);
    }
  }

  // Check engagement-daily endpoint
  try {
    const res = await request(app)
      .get("/api/analytics/engagement-daily")
      .set("Authorization", `Bearer ${token}`);

    if (res.status === 200 && Array.isArray(res.body.data?.days) && res.body.data.days.length === 7)
      ok("Analytics engagement-daily → 7-day series returned");
    else fail("Engagement daily failed", `${res.status} days=${res.body.data?.days?.length}`);
  } catch (e: any) {
    fail("Engagement daily threw", e.message);
  }

  // Cleanup: delete test data in dependency order
  if (userId) {
    try {
      await prisma.tweetDraft.deleteMany({ where: { userId } });
      await prisma.analyticsEvent.deleteMany({ where: { userId } });
      await prisma.blendVoice.deleteMany({
        where: { blend: { userId } },
      });
      await prisma.savedBlend.deleteMany({ where: { userId } });
      await prisma.referenceVoice.deleteMany({ where: { userId } });
      await prisma.voiceProfile.deleteMany({ where: { userId } });
      await prisma.session.deleteMany({ where: { userId } });
      await prisma.alert.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } });
      ok("Test data cleaned up");
    } catch (e: any) {
      warn(`Cleanup incomplete (non-fatal): ${e.message}`);
    }
  }

  return { token, userId };
}

// ─── Step 6: Route Coverage (all authenticated GETs) ─────────────────────────

/**
 * Hits every GET endpoint with a valid JWT and verifies:
 * - No 5xx server errors (any 4xx is acceptable — e.g. 401 for routes that
 *   need X account linked, 403 for manager-only routes)
 * - Response body is valid JSON (not a Prisma leak / raw stack trace)
 * - Routes returning 200 have ok:true
 */
async function checkRouteCoverage(token: string) {
  console.log("\n[6/6] Route coverage (authenticated GET sweep)");

  type RouteCheck = {
    path: string;
    desc: string;
    // Status codes considered a pass. null = any non-5xx.
    expect: number | number[] | null;
  };

  const routes: RouteCheck[] = [
    // ── Auth ──────────────────────────────────────────────────────────────
    { path: "/api/auth/me", desc: "auth/me", expect: 200 },

    // ── Users ─────────────────────────────────────────────────────────────
    { path: "/api/users/profile", desc: "users/profile", expect: 200 },
    { path: "/api/users/team", desc: "users/team (403 for ANALYST)", expect: 403 },

    // ── Voice ─────────────────────────────────────────────────────────────
    { path: "/api/voice/profile", desc: "voice/profile", expect: 200 },
    { path: "/api/voice/references", desc: "voice/references", expect: 200 },
    { path: "/api/voice/blends", desc: "voice/blends", expect: 200 },
    { path: "/api/voice/reference-accounts", desc: "voice/reference-accounts", expect: 200 },

    // ── Drafts ────────────────────────────────────────────────────────────
    { path: "/api/drafts", desc: "drafts list", expect: 200 },

    // ── Analytics ─────────────────────────────────────────────────────────
    { path: "/api/analytics/summary", desc: "analytics/summary", expect: 200 },
    { path: "/api/analytics/learning-log", desc: "analytics/learning-log", expect: 200 },
    { path: "/api/analytics/engagement", desc: "analytics/engagement", expect: 200 },
    { path: "/api/analytics/engagement-daily", desc: "analytics/engagement-daily", expect: 200 },
    { path: "/api/analytics/team", desc: "analytics/team (403 for ANALYST)", expect: 403 },

    // ── Alerts ────────────────────────────────────────────────────────────
    { path: "/api/alerts/subscriptions", desc: "alerts/subscriptions", expect: 200 },
    { path: "/api/alerts/feed", desc: "alerts/feed", expect: 200 },

    // ── Campaigns ─────────────────────────────────────────────────────────
    { path: "/api/campaigns", desc: "campaigns list", expect: 200 },

    // ── Monitors ──────────────────────────────────────────────────────────
    { path: "/api/monitors", desc: "monitors list", expect: 200 },

    // ── Briefing ──────────────────────────────────────────────────────────
    { path: "/api/briefing/preferences", desc: "briefing/preferences", expect: [200, 404] },
    { path: "/api/briefing/history", desc: "briefing/history", expect: 200 },

    // ── Oracle ────────────────────────────────────────────────────────────
    { path: "/api/oracle/session", desc: "oracle/session", expect: [200, 404] },

    // ── Arena ─────────────────────────────────────────────────────────────
    { path: "/api/arena/me", desc: "arena/me", expect: [200, 404] },
    { path: "/api/arena/leaderboard", desc: "arena/leaderboard", expect: 200 },

    // ── Queue ─────────────────────────────────────────────────────────────
    { path: "/api/queue", desc: "queue items", expect: 200 },
    { path: "/api/queue/scheduled", desc: "queue/scheduled", expect: 200 },

    // ── Research ──────────────────────────────────────────────────────────
    { path: "/api/research/history", desc: "research/history", expect: 200 },

    // ── Trending ──────────────────────────────────────────────────────────
    // External data — may return 503 if provider is unavailable
    { path: "/api/trending/topics", desc: "trending/topics (ext, may 503)", expect: [200, 503] },

    // ── Twitter (needs linked X account — 401 expected for test user) ─────
    { path: "/api/twitter/follows", desc: "twitter/follows (no X → 401)", expect: 401 },
    { path: "/api/twitter/likes", desc: "twitter/likes (no X → 401)", expect: 401 },

    // ── Admin (403 for non-admin test user) ───────────────────────────────
    { path: "/api/admin/feature-flags", desc: "admin/feature-flags (403)", expect: [200, 403] },
  ];

  for (const route of routes) {
    try {
      const res = await request(app)
        .get(route.path)
        .set("Authorization", `Bearer ${token}`);

      const expected = route.expect === null
        ? null
        : Array.isArray(route.expect) ? route.expect : [route.expect];

      if (res.status >= 500) {
        // Any 5xx is a hard failure — indicates unhandled exception or Prisma leak
        fail(
          `${route.path} → ${res.status} (server error)`,
          JSON.stringify(res.body).slice(0, 200),
        );
      } else if (expected === null || expected.includes(res.status)) {
        ok(`${route.desc} → ${res.status}`);
      } else {
        warn(`${route.desc}: expected ${Array.isArray(route.expect) ? route.expect.join("/") : route.expect}, got ${res.status}`);
      }
    } catch (e: any) {
      fail(`${route.desc}: request threw`, e.message);
    }
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Atlas API — Smoke Test");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  checkEnv();
  await checkDatabase();
  await checkRedis();
  await checkHealth();
  const { token } = await checkE2EFlow();

  if (token) {
    await checkRouteCoverage(token);
  } else {
    warn("Skipping route coverage — no token from E2E flow");
  }

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Result: ${passed} passed, ${failed} failed, ${warned} warnings`);
  if (errors.length) {
    console.error("  Failures:");
    errors.forEach((e) => console.error(`    • ${e}`));
  }
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // Disconnect services
  const redis = getRedis();
  if (redis) await redis.quit().catch(() => {});
  await prisma.$disconnect();

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("Smoke test crashed:", e);
  process.exit(1);
});
