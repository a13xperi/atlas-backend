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
 *
 * Run:
 *   cd ~/projects/atlas-backend
 *   DATABASE_URL=... npx tsx scripts/seed-anil.ts
 *
 * Or via package script (if added):
 *   npm run seed:anil
 */

import "dotenv/config";

import { PrismaClient } from "@prisma/client";

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
    onboardingTrack: "TRACK_A" as const,
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

async function main() {
  console.log("seeding Anil demo account");

  const user = await ensureUser();
  await ensureVoiceProfile(user.id);
  const refIds = await ensureReferenceVoices(user.id);
  const blendIds = await ensureBlends(user.id, refIds);
  await ensureDrafts(user.id, blendIds);

  console.log("\ndone — Anil demo account is ready");
  console.log(`  email:        ${ANIL_EMAIL}`);
  console.log(`  handle:       ${ANIL_HANDLE}`);
  console.log(`  xHandle:      @${ANIL_X_HANDLE}`);
  console.log(`  role:         MANAGER`);
  console.log(`  tour:         completed`);
}

main()
  .catch((err) => {
    console.error("seed failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
