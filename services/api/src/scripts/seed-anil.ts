/**
 * Atlas — Seed Demo User: Anil
 *
 * Creates a fully-populated manager account with:
 * - Supabase auth user + Prisma user (MANAGER role)
 * - Configured voice profile (crypto analyst style)
 * - 3 reference voices (crypto influencers)
 * - 2 saved blends
 * - 5 sample tweet drafts (various statuses)
 * - Analytics events (30 days of activity)
 * - Alert subscriptions + sample alerts
 * - Learning log entries
 *
 * Run: npx tsx services/api/src/scripts/seed-anil.ts
 *
 * Idempotent: skips if user with email already exists.
 */

import * as dotenv from "dotenv";
dotenv.config();

import { PrismaClient } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const ANIL_EMAIL = "anil@delphidigital.io";
const ANIL_PASSWORD = "AtlasDemo2026!";
const ANIL_HANDLE = "anil";

async function main() {
  console.log("🌱 Seeding demo user: Anil\n");

  // Check if already exists
  const existing = await prisma.user.findUnique({ where: { email: ANIL_EMAIL } });
  if (existing) {
    console.log(`✅ User "${ANIL_HANDLE}" already exists (${existing.id}). Skipping.`);
    return;
  }

  // --- Supabase Auth ---
  let supabaseId: string | undefined;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (supabaseUrl && supabaseKey) {
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Check if Supabase user exists
    const { data: existingUsers } = await supabase.auth.admin.listUsers();
    const existingSupaUser = existingUsers?.users?.find((u: { email?: string }) => u.email === ANIL_EMAIL);

    if (existingSupaUser) {
      supabaseId = existingSupaUser.id;
      console.log(`  Supabase auth user exists: ${supabaseId}`);
    } else {
      const { data, error } = await supabase.auth.admin.createUser({
        email: ANIL_EMAIL,
        password: ANIL_PASSWORD,
        email_confirm: true,
      });
      if (error) {
        console.error("  ❌ Supabase createUser failed:", error.message);
        console.log("  Continuing without Supabase auth (legacy JWT fallback)...");
      } else {
        supabaseId = data.user.id;
        console.log(`  ✅ Supabase auth user created: ${supabaseId}`);
      }
    }
  } else {
    console.log("  ⚠️ Supabase not configured — skipping auth user creation");
  }

  // --- Prisma User + Voice Profile ---
  const passwordHash = await bcrypt.hash(ANIL_PASSWORD, 10);
  const user = await prisma.user.create({
    data: {
      handle: ANIL_HANDLE,
      email: ANIL_EMAIL,
      displayName: "Anil",
      passwordHash,
      supabaseId,
      role: "MANAGER",
      onboardingTrack: "TRACK_A",
      voiceProfile: {
        create: {
          humor: 35,
          formality: 70,
          brevity: 65,
          contrarianTone: 45,
          maturity: "ADVANCED",
          tweetsAnalyzed: 127,
        },
      },
    },
    include: { voiceProfile: true },
  });
  console.log(`  ✅ User created: ${user.id} (${user.handle}, ${user.role})`);
  console.log(`  ✅ Voice profile: humor=${user.voiceProfile!.humor} formality=${user.voiceProfile!.formality} brevity=${user.voiceProfile!.brevity} contrarian=${user.voiceProfile!.contrarianTone}`);

  // --- Reference Voices ---
  const voices = await Promise.all([
    prisma.referenceVoice.create({
      data: { userId: user.id, name: "Hasu", handle: "@hasufl", avatarUrl: null, isActive: true },
    }),
    prisma.referenceVoice.create({
      data: { userId: user.id, name: "Cobie", handle: "@CobieChat", avatarUrl: null, isActive: true },
    }),
    prisma.referenceVoice.create({
      data: { userId: user.id, name: "Messari Research", handle: "@MessariCrypto", avatarUrl: null, isActive: false },
    }),
  ]);
  console.log(`  ✅ ${voices.length} reference voices created`);

  // --- Saved Blends ---
  const blend1 = await prisma.savedBlend.create({
    data: {
      userId: user.id,
      name: "Research Mode",
      voices: {
        create: [
          { label: "My voice", percentage: 50, referenceVoiceId: null },
          { label: "Hasu", percentage: 30, referenceVoiceId: voices[0].id },
          { label: "Cobie", percentage: 20, referenceVoiceId: voices[1].id },
        ],
      },
    },
  });

  const blend2 = await prisma.savedBlend.create({
    data: {
      userId: user.id,
      name: "Hot Take Mode",
      voices: {
        create: [
          { label: "My voice", percentage: 60, referenceVoiceId: null },
          { label: "Cobie", percentage: 40, referenceVoiceId: voices[1].id },
        ],
      },
    },
  });
  console.log(`  ✅ 2 saved blends: "${blend1.name}", "${blend2.name}"`);

  // --- Tweet Drafts ---
  const now = new Date();
  const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

  const drafts = await Promise.all([
    prisma.tweetDraft.create({
      data: {
        userId: user.id, content: "The merge was months ago and we're still arguing about MEV. Builders are the new miners and they're playing a completely different game.",
        status: "POSTED", confidence: 0.87, predictedEngagement: 3200, actualEngagement: 4100,
        sourceType: "TRENDING_TOPIC", sourceContent: "MEV and builder dynamics post-merge",
        blendId: blend1.id, createdAt: daysAgo(12), updatedAt: daysAgo(12),
      },
    }),
    prisma.tweetDraft.create({
      data: {
        userId: user.id, content: "L2 sequencers are going to be the next big unlock. Shared sequencing isn't just about throughput — it's about composability between rollups that currently can't talk to each other.",
        status: "POSTED", confidence: 0.82, predictedEngagement: 2800, actualEngagement: 3500,
        sourceType: "REPORT", sourceContent: "Delphi Digital: L2 Sequencer Landscape Q1 2026",
        createdAt: daysAgo(8), updatedAt: daysAgo(8),
      },
    }),
    prisma.tweetDraft.create({
      data: {
        userId: user.id, content: "Hot take: the next cycle won't be led by new L1s. It'll be won by whoever solves cross-chain UX. The chain abstraction thesis is underpriced.",
        status: "APPROVED", confidence: 0.91, predictedEngagement: 4500,
        sourceType: "TWEET", sourceContent: "chain abstraction discussion thread",
        blendId: blend2.id, createdAt: daysAgo(3), updatedAt: daysAgo(3),
      },
    }),
    prisma.tweetDraft.create({
      data: {
        userId: user.id, content: "Stablecoin volumes on L2s just hit an ATH. This is the real adoption metric — not TVL, not token price. Watch where the dollars settle.",
        status: "DRAFT", confidence: 0.78, predictedEngagement: 2100,
        sourceType: "ARTICLE", sourceContent: "DefiLlama stablecoin dashboard analysis",
        createdAt: daysAgo(1), updatedAt: daysAgo(1),
      },
    }),
    prisma.tweetDraft.create({
      data: {
        userId: user.id, content: "Thread idea: Why restaking is both the most innovative and most dangerous primitive in DeFi right now. The leverage is hidden in plain sight.",
        status: "DRAFT", confidence: 0.74, predictedEngagement: 1800,
        sourceType: "MANUAL", createdAt: daysAgo(0), updatedAt: daysAgo(0),
      },
    }),
  ]);
  console.log(`  ✅ ${drafts.length} tweet drafts (2 posted, 1 approved, 2 draft)`);

  // --- Analytics Events (30 days of activity) ---
  const eventTypes = [
    "DRAFT_CREATED", "DRAFT_POSTED", "FEEDBACK_GIVEN", "VOICE_REFINEMENT",
    "REPORT_INGESTED", "ENGAGEMENT_RECORDED", "SESSION_START", "RESEARCH_CONDUCTED",
  ] as const;

  const events: { userId: string; type: (typeof eventTypes)[number]; value: number | null; createdAt: Date }[] = [];
  for (let day = 0; day < 30; day++) {
    const date = daysAgo(day);
    // 1-3 sessions per day
    events.push({ userId: user.id, type: "SESSION_START", value: null, createdAt: date });
    if (day % 2 === 0) {
      events.push({ userId: user.id, type: "DRAFT_CREATED", value: null, createdAt: date });
      events.push({ userId: user.id, type: "RESEARCH_CONDUCTED", value: null, createdAt: date });
    }
    if (day % 5 === 0) {
      events.push({ userId: user.id, type: "DRAFT_POSTED", value: null, createdAt: date });
      events.push({ userId: user.id, type: "ENGAGEMENT_RECORDED", value: Math.random() * 5000, createdAt: date });
    }
    if (day % 7 === 0) {
      events.push({ userId: user.id, type: "FEEDBACK_GIVEN", value: null, createdAt: date });
      events.push({ userId: user.id, type: "VOICE_REFINEMENT", value: null, createdAt: date });
    }
    if (day % 10 === 0) {
      events.push({ userId: user.id, type: "REPORT_INGESTED", value: null, createdAt: date });
    }
  }
  await prisma.analyticsEvent.createMany({ data: events });
  console.log(`  ✅ ${events.length} analytics events (30 days of activity)`);

  // --- Alert Subscriptions ---
  const subs = await Promise.all([
    prisma.alertSubscription.create({
      data: { userId: user.id, type: "CATEGORY", value: "DeFi", isActive: true, delivery: ["PORTAL"] },
    }),
    prisma.alertSubscription.create({
      data: { userId: user.id, type: "CATEGORY", value: "L2s", isActive: true, delivery: ["PORTAL", "TELEGRAM"] },
    }),
    prisma.alertSubscription.create({
      data: { userId: user.id, type: "ACCOUNT", value: "vitalik.eth", isActive: true, delivery: ["PORTAL"] },
    }),
  ]);
  console.log(`  ✅ ${subs.length} alert subscriptions`);

  // --- Sample Alerts ---
  const alerts = await Promise.all([
    prisma.alert.create({
      data: {
        type: "trending", title: "Uniswap v4 hooks gaining traction",
        context: "Multiple core devs discussing hook patterns. Volume on v4 pools up 40% this week.",
        sentiment: "bullish", relevance: 0.85, userId: user.id,
        createdAt: daysAgo(1),
      },
    }),
    prisma.alert.create({
      data: {
        type: "account", title: "Vitalik on account abstraction roadmap",
        context: "New blog post outlines EIP-7702 path to native AA on mainnet.",
        sourceUrl: "https://vitalik.eth.limo/aa-roadmap",
        sentiment: "neutral", relevance: 0.92, userId: user.id,
        createdAt: daysAgo(0),
      },
    }),
    prisma.alert.create({
      data: {
        type: "report", title: "Messari: Q1 2026 DeFi Report",
        context: "TVL recovery across major protocols. Lending markets seeing record utilization.",
        draftReply: "The DeFi recovery isn't just TVL — utilization rates tell a more interesting story.",
        sentiment: "bullish", relevance: 0.78, userId: user.id,
        createdAt: daysAgo(0),
      },
    }),
  ]);
  console.log(`  ✅ ${alerts.length} sample alerts`);

  // --- Learning Log ---
  const logEntries = await Promise.all([
    prisma.learningLogEntry.create({
      data: { userId: user.id, event: "Brevity improved tweet engagement by 23%", impact: "Shorter threads with punchy opening lines perform better", positive: true, createdAt: daysAgo(5) },
    }),
    prisma.learningLogEntry.create({
      data: { userId: user.id, event: "Contrarian take on L2 fees got mixed response", impact: "Audience prefers data-backed contrarian takes over pure opinion", positive: false, createdAt: daysAgo(10) },
    }),
    prisma.learningLogEntry.create({
      data: { userId: user.id, event: "Research-backed drafts consistently outperform", impact: "Drafts with source material score 30% higher confidence", positive: true, createdAt: daysAgo(15) },
    }),
  ]);
  console.log(`  ✅ ${logEntries.length} learning log entries`);

  // --- Summary ---
  console.log("\n🎉 Demo user seeded successfully!\n");
  console.log("  Login credentials:");
  console.log(`    Email:    ${ANIL_EMAIL}`);
  console.log(`    Password: ${ANIL_PASSWORD}`);
  console.log(`    Handle:   @${ANIL_HANDLE}`);
  console.log(`    Role:     MANAGER`);
  console.log(`\n  Data seeded:`);
  console.log(`    Voice profile (humor=35, formality=70, brevity=65, contrarian=45)`);
  console.log(`    ${voices.length} reference voices (Hasu, Cobie, Messari)`);
  console.log(`    ${2} saved blends (Research Mode, Hot Take Mode)`);
  console.log(`    ${drafts.length} tweet drafts (posted, approved, draft)`);
  console.log(`    ${events.length} analytics events (30 days)`);
  console.log(`    ${subs.length} alert subscriptions`);
  console.log(`    ${alerts.length} sample alerts`);
  console.log(`    ${logEntries.length} learning log entries`);
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
