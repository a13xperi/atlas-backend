/**
 * Atlas — Seed / Repair Anil Demo Account
 *
 * Idempotent. Safe to run multiple times. Brings Anil's account to a known
 * "demo-ready" state for the Wednesday Apr 14 demo:
 *
 *   - User exists (MANAGER, displayName "Anil", email anil@delphidigital.io)
 *   - xHandle = "anillulla"  (X OAuth = primary login, no password needed)
 *   - tourCompleted = true   (skip onboarding flow on demo)
 *   - onboardingTrack = TRACK_A
 *   - VoiceProfile populated (12 dimensions, ADVANCED, 240 tweets analyzed)
 *   - 5 reference voices  (Delphi, Messari, Naval, paulg, pmarca)
 *   - 3 saved blends
 *   - 8 sample drafts (mix of POSTED / APPROVED / DRAFT)
 *   - 2 campaigns (Modular Rollups Report / DeFi Market Update) with
 *     report-sourced tweet drafts linked for the campaign queue view
 *   - Morning briefing preference + 3 CATEGORY alert subscriptions
 *     (AI×crypto #1, Macro/rates/regulatory #2, Stablecoins/RWA #3) —
 *     delivered to PORTAL + TELEGRAM, from Anil's Zight Part 2 preferences
 *     (task #3971 / Atlas BO 8 + BO 11).
 *
 * Run:
 *   cd ~/projects/atlas-backend
 *   DATABASE_URL=... npx tsx scripts/seed-anil.ts
 *
 * Or via package script (if added):
 *   npm run seed:anil
 */

import "dotenv/config";

import { PrismaClient, OnboardingTrack } from "@prisma/client";

const prisma = new PrismaClient();

const ANIL_EMAIL = "anil@delphidigital.io";
const ANIL_HANDLE = "anil";
const ANIL_X_HANDLE = "anillulla";

type RefSeed = {
  name: string;
  handle: string;
  isActive?: boolean;
  category?: string;
};

const REFERENCE_VOICES: RefSeed[] = [
  { name: "Delphi Digital", handle: "@Delphi_Digital", isActive: true, category: "research" },
  { name: "Messari", handle: "@MessariCrypto", isActive: true, category: "research" },
  { name: "Naval", handle: "@naval", isActive: true, category: "founder" },
  { name: "Paul Graham", handle: "@paulg", isActive: true, category: "founder" },
  { name: "Marc Andreessen", handle: "@pmarca", isActive: false, category: "investor" },
];

type BlendSeed = {
  name: string;
  voices: Array<{ label: string; percentage: number; refName?: string }>;
};

const SAVED_BLENDS: BlendSeed[] = [
  {
    name: "Delphi Voice",
    voices: [
      { label: "Anil", percentage: 70 },
      { label: "Delphi Digital", percentage: 20, refName: "Delphi Digital" },
      { label: "Messari", percentage: 10, refName: "Messari" },
    ],
  },
  {
    name: "Founder Voice",
    voices: [
      { label: "Anil", percentage: 55 },
      { label: "Naval", percentage: 25, refName: "Naval" },
      { label: "Paul Graham", percentage: 20, refName: "Paul Graham" },
    ],
  },
  {
    name: "Market Commentary",
    voices: [
      { label: "Anil", percentage: 60 },
      { label: "Messari", percentage: 25, refName: "Messari" },
      { label: "Marc Andreessen", percentage: 15, refName: "Marc Andreessen" },
    ],
  },
];

type DraftSeed = {
  content: string;
  status: "DRAFT" | "APPROVED" | "POSTED";
  sourceType: "REPORT" | "ARTICLE" | "TWEET" | "TRENDING_TOPIC" | "VOICE_NOTE" | "MANUAL";
  sourceContent?: string;
  blendName?: string;
  confidence: number;
  predictedEngagement: number;
  actualEngagement?: number;
  engagementMetrics?: { likes: number; retweets: number; impressions: number };
  daysAgo: number;
};

const SAMPLE_DRAFTS: DraftSeed[] = [
  {
    content:
      "The crypto research industry is evolving from selling reports to selling decision frameworks. The next generation of research firms will look more like Bloomberg terminals than PDF subscriptions.",
    status: "POSTED",
    sourceType: "REPORT",
    sourceContent: "Internal memo on Delphi research product evolution.",
    blendName: "Delphi Voice",
    confidence: 0.91,
    predictedEngagement: 12400,
    actualEngagement: 15800,
    engagementMetrics: { likes: 412, retweets: 89, impressions: 58000 },
    daysAgo: 12,
  },
  {
    content:
      "Tokenized treasuries crossed $2B and nobody batted an eye. That is the signal. When TradFi adoption stops making headlines, it means the integration is working.",
    status: "POSTED",
    sourceType: "TRENDING_TOPIC",
    sourceContent: "Tokenized treasury growth and institutional adoption metrics.",
    blendName: "Market Commentary",
    confidence: 0.86,
    predictedEngagement: 9200,
    actualEngagement: 10500,
    engagementMetrics: { likes: 298, retweets: 67, impressions: 41200 },
    daysAgo: 9,
  },
  {
    content:
      "Delphi's latest research on modular rollups shows we're at an inflection point: shared sequencers are no longer a 2027 problem, they are a Q2 2026 problem.",
    status: "POSTED",
    sourceType: "REPORT",
    sourceContent: "Delphi modular rollups quarterly note",
    blendName: "Delphi Voice",
    confidence: 0.88,
    predictedEngagement: 8400,
    actualEngagement: 9100,
    engagementMetrics: { likes: 264, retweets: 51, impressions: 36400 },
    daysAgo: 7,
  },
  {
    content:
      "Team shipping velocity is the real alpha in a research org. One analyst who posts three high-signal tweets a week is worth five who publish a monthly PDF.",
    status: "APPROVED",
    sourceType: "MANUAL",
    blendName: "Founder Voice",
    confidence: 0.79,
    predictedEngagement: 7600,
    daysAgo: 4,
  },
  {
    content:
      "Hot take: the next cycle won't be led by new L1s. It'll be won by whoever solves cross-chain UX. The chain abstraction thesis is underpriced.",
    status: "APPROVED",
    sourceType: "TWEET",
    sourceContent: "chain abstraction discussion thread",
    blendName: "Market Commentary",
    confidence: 0.83,
    predictedEngagement: 5400,
    daysAgo: 3,
  },
  {
    content:
      "Stablecoin volumes just crossed $2T monthly. This isn't a crypto story anymore — it's a payments story. The dollar got an upgrade and most people missed it.",
    status: "DRAFT",
    sourceType: "ARTICLE",
    sourceContent: "DefiLlama stablecoin dashboard",
    blendName: "Market Commentary",
    confidence: 0.78,
    predictedEngagement: 4100,
    daysAgo: 1,
  },
  {
    content:
      "AI-assisted content creation is not about replacing analysts. It's about removing the 80% of work that isn't thinking, so 100% of the time goes into the part that is.",
    status: "DRAFT",
    sourceType: "MANUAL",
    blendName: "Founder Voice",
    confidence: 0.74,
    predictedEngagement: 3800,
    daysAgo: 1,
  },
  {
    content:
      "Thread idea: Why restaking is both the most innovative and most dangerous primitive in DeFi right now. The leverage is hidden in plain sight.",
    status: "DRAFT",
    sourceType: "MANUAL",
    confidence: 0.71,
    predictedEngagement: 3200,
    daysAgo: 0,
  },
];

function daysAgoDate(d: number): Date {
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000);
}

async function ensureUser() {
  const existing = await prisma.user.findFirst({
    where: { OR: [{ email: ANIL_EMAIL }, { handle: ANIL_HANDLE }] },
  });

  const userData = {
    handle: ANIL_HANDLE,
    email: ANIL_EMAIL,
    displayName: "Anil",
    role: "MANAGER" as const,
    onboardingTrack: OnboardingTrack.TRACK_A,
    xHandle: ANIL_X_HANDLE,
    tourCompleted: true,
    tourStep: 0,
  };

  if (existing) {
    const updated = await prisma.user.update({
      where: { id: existing.id },
      data: userData,
    });
    console.log(`  user: repaired existing  ${updated.id}`);
    return updated;
  }

  const created = await prisma.user.create({ data: userData });
  console.log(`  user: created            ${created.id}`);
  return created;
}

async function ensureVoiceProfile(userId: string) {
  const data = {
    humor: 35,
    formality: 72,
    brevity: 65,
    contrarianTone: 45,
    directness: 72,
    warmth: 40,
    technicalDepth: 80,
    confidence: 78,
    evidenceOrientation: 85,
    solutionOrientation: 60,
    socialPosture: 55,
    selfPromotionalIntensity: 30,
    maturity: "ADVANCED" as const,
    tweetsAnalyzed: 240,
  };

  const profile = await prisma.voiceProfile.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
  console.log(`  voice profile: ok        humor=${profile.humor} formality=${profile.formality}`);
  return profile;
}

async function ensureReferenceVoices(userId: string) {
  const byName = new Map<string, string>();
  for (const ref of REFERENCE_VOICES) {
    const existing = await prisma.referenceVoice.findFirst({
      where: { userId, name: ref.name },
    });
    if (existing) {
      const updated = await prisma.referenceVoice.update({
        where: { id: existing.id },
        data: {
          handle: ref.handle,
          isActive: ref.isActive ?? true,
          category: ref.category,
        },
      });
      byName.set(ref.name, updated.id);
    } else {
      const created = await prisma.referenceVoice.create({
        data: {
          userId,
          name: ref.name,
          handle: ref.handle,
          isActive: ref.isActive ?? true,
          category: ref.category,
        },
      });
      byName.set(ref.name, created.id);
    }
  }
  console.log(`  reference voices: ok     (${byName.size})`);
  return byName;
}

async function ensureBlends(userId: string, refIdByName: Map<string, string>) {
  const byName = new Map<string, string>();
  for (const blend of SAVED_BLENDS) {
    const existing = await prisma.savedBlend.findFirst({
      where: { userId, name: blend.name },
    });

    let blendId: string;
    if (existing) {
      blendId = existing.id;
      // Wipe and rebuild voice components for clean state
      await prisma.blendVoice.deleteMany({ where: { blendId } });
    } else {
      const created = await prisma.savedBlend.create({
        data: { userId, name: blend.name },
      });
      blendId = created.id;
    }

    for (const v of blend.voices) {
      await prisma.blendVoice.create({
        data: {
          blendId,
          label: v.label,
          percentage: v.percentage,
          referenceVoiceId: v.refName ? refIdByName.get(v.refName) ?? null : null,
        },
      });
    }
    byName.set(blend.name, blendId);
  }
  console.log(`  saved blends: ok         (${byName.size})`);
  return byName;
}

async function ensureDrafts(userId: string, blendIdByName: Map<string, string>) {
  // Wipe and reseed for clean, predictable demo state.
  const deleted = await prisma.tweetDraft.deleteMany({ where: { userId } });
  if (deleted.count > 0) {
    console.log(`  drafts: cleared          (${deleted.count} old)`);
  }

  for (const d of SAMPLE_DRAFTS) {
    const when = daysAgoDate(d.daysAgo);
    await prisma.tweetDraft.create({
      data: {
        userId,
        content: d.content,
        status: d.status,
        confidence: d.confidence,
        predictedEngagement: d.predictedEngagement,
        actualEngagement: d.actualEngagement,
        engagementMetrics: d.engagementMetrics ?? undefined,
        sourceType: d.sourceType,
        sourceContent: d.sourceContent,
        blendId: d.blendName ? blendIdByName.get(d.blendName) ?? null : null,
        createdAt: when,
        updatedAt: when,
      },
    });
  }

  const counts = await prisma.tweetDraft.groupBy({
    by: ["status"],
    where: { userId },
    _count: { _all: true },
  });
  const summary = counts.map((c) => `${c.status}=${c._count._all}`).join(" ");
  console.log(`  drafts: seeded           (${SAMPLE_DRAFTS.length}) ${summary}`);
}

type CampaignSeed = {
  name: string;
  description: string;
  status: "DRAFT" | "ACTIVE" | "COMPLETED" | "PAUSED";
  // Predicate to pick which drafts belong to this campaign.
  pickDrafts: (drafts: Array<{ id: string; status: string; sourceType: string }>) => string[];
};

const CAMPAIGNS: CampaignSeed[] = [
  {
    name: "Modular Rollups Report",
    description:
      "Report-sourced campaign from Delphi's modular rollups quarterly note — drives the shared sequencer narrative with supporting trending commentary.",
    status: "ACTIVE",
    // Link all drafts sourced from REPORT or TRENDING_TOPIC (3 total).
    pickDrafts: (drafts) =>
      drafts
        .filter(
          (d) => d.sourceType === "REPORT" || d.sourceType === "TRENDING_TOPIC",
        )
        .map((d) => d.id),
  },
  {
    name: "DeFi Market Update",
    description:
      "Working campaign for the upcoming DeFi update — stablecoin payments angle plus the restaking thread idea, both still in DRAFT status.",
    status: "DRAFT",
    // Link the 2 DRAFT-status drafts that fit the DeFi update narrative
    // (stablecoin volumes ARTICLE + restaking MANUAL). Skip the AI/content
    // creation draft — unrelated to the DeFi theme.
    pickDrafts: (drafts) =>
      drafts
        .filter(
          (d) =>
            d.status === "DRAFT" &&
            (d.sourceType === "ARTICLE" || d.sourceType === "MANUAL"),
        )
        .filter((_, idx, arr) => {
          // Keep the stablecoin ARTICLE draft and the restaking MANUAL draft.
          // With 3 DRAFT rows (ARTICLE, MANUAL, MANUAL), take the ARTICLE and
          // the last MANUAL (restaking).
          return arr.length <= 2 || idx === 0 || idx === arr.length - 1;
        })
        .map((d) => d.id),
  },
];

async function ensureCampaigns(userId: string) {
  // Wipe and reseed for clean, predictable demo state.
  // Unlink any drafts from old campaigns first (campaignId is nullable).
  await prisma.tweetDraft.updateMany({
    where: { userId, campaignId: { not: null } },
    data: { campaignId: null },
  });
  const deleted = await prisma.campaign.deleteMany({ where: { userId } });
  if (deleted.count > 0) {
    console.log(`  campaigns: cleared       (${deleted.count} old)`);
  }

  // Fetch existing drafts so we can link them by id.
  const draftRows = await prisma.tweetDraft.findMany({
    where: { userId },
    select: { id: true, status: true, sourceType: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  let totalLinked = 0;
  for (const c of CAMPAIGNS) {
    const campaign = await prisma.campaign.create({
      data: {
        userId,
        name: c.name,
        description: c.description,
        status: c.status,
      },
    });

    const draftIds = c.pickDrafts(
      draftRows.map((d) => ({
        id: d.id,
        status: d.status,
        sourceType: d.sourceType,
      })),
    );

    if (draftIds.length > 0) {
      await prisma.tweetDraft.updateMany({
        where: { id: { in: draftIds }, userId },
        data: { campaignId: campaign.id },
      });
    }
    totalLinked += draftIds.length;
    console.log(
      `  campaign: ${c.name.padEnd(22)} ${c.status.padEnd(8)} linked=${draftIds.length}`,
    );
  }
  console.log(`  campaigns: seeded        (${CAMPAIGNS.length}) drafts_linked=${totalLinked}`);
}

// ── Briefing + alert subscriptions ────────────────────────────────────
// Sourced from Anil's Zight Part 2 recording (captured in task #3971).
// Priority order matters: topics[0] is the #1 lead topic that the
// briefing engine leans into, topics[1] is the second beat, etc. We
// also spin up three CATEGORY alert subscriptions on the same topics
// so the alerts feed + Telegram bot stay in sync with the morning brief.
const ANIL_BRIEFING_TOPICS = [
  "AI×crypto",
  "Macro/rates/regulatory",
  "Stablecoins/RWA",
];

const ANIL_BRIEFING_SOURCES = [
  "X/Twitter",
  "Delphi Research",
  "News",
];

async function ensureBriefingConfig(userId: string) {
  // 1. Morning briefing preference — upsert by the unique userId constraint.
  //    `channel` is a single String in the schema; "PORTAL" keeps the
  //    in-app briefing card live, and the CATEGORY alert subscriptions
  //    below carry the Telegram delivery.
  const preference = await prisma.briefingPreference.upsert({
    where: { userId },
    create: {
      userId,
      deliveryTime: "08:00",
      topics: ANIL_BRIEFING_TOPICS,
      sources: ANIL_BRIEFING_SOURCES,
      channel: "PORTAL",
    },
    update: {
      deliveryTime: "08:00",
      topics: ANIL_BRIEFING_TOPICS,
      sources: ANIL_BRIEFING_SOURCES,
      channel: "PORTAL",
    },
  });
  console.log(
    `  briefing pref: ok        ${preference.deliveryTime} topics=${preference.topics.length} channel=${preference.channel}`,
  );

  // 2. Three CATEGORY alert subscriptions on the same topics.
  //    `delivery: [PORTAL, TELEGRAM]` routes matches to both the in-app
  //    alerts feed and Anil's Telegram bot. The @@unique([userId, type, value])
  //    constraint makes this idempotent — re-runs just flip isActive/delivery
  //    back on in case someone toggled them off.
  const desired: Array<{ value: string; delivery: ("PORTAL" | "TELEGRAM")[] }> =
    ANIL_BRIEFING_TOPICS.map((value) => ({
      value,
      delivery: ["PORTAL", "TELEGRAM"],
    }));

  for (const sub of desired) {
    const existing = await prisma.alertSubscription.findFirst({
      where: { userId, type: "CATEGORY", value: sub.value },
    });
    if (existing) {
      await prisma.alertSubscription.update({
        where: { id: existing.id },
        data: { isActive: true, delivery: sub.delivery },
      });
    } else {
      await prisma.alertSubscription.create({
        data: {
          userId,
          type: "CATEGORY",
          value: sub.value,
          isActive: true,
          delivery: sub.delivery,
        },
      });
    }
  }
  console.log(
    `  alert subs: ok           (${desired.length}) delivery=[PORTAL,TELEGRAM]`,
  );
}

async function main() {
  console.log("seeding Anil demo account");

  const user = await ensureUser();
  await ensureVoiceProfile(user.id);
  const refIds = await ensureReferenceVoices(user.id);
  const blendIds = await ensureBlends(user.id, refIds);
  await ensureDrafts(user.id, blendIds);
  await ensureCampaigns(user.id);
  await ensureBriefingConfig(user.id);

  console.log("\ndone — Anil demo account is ready");
  console.log(`  email:        ${ANIL_EMAIL}`);
  console.log(`  handle:       ${ANIL_HANDLE}`);
  console.log(`  xHandle:      @${ANIL_X_HANDLE}`);
  console.log(`  role:         MANAGER`);
  console.log(`  tour:         completed`);
  console.log(`  briefing:     08:00 on ${ANIL_BRIEFING_TOPICS.join(", ")}`);
  console.log(`  alerts:       PORTAL + TELEGRAM on ${ANIL_BRIEFING_TOPICS.length} categories`);
}

main()
  .catch((err) => {
    console.error("seed failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
