import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const SEED_PASSWORD = "atlas-demo-2026";

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function main() {
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);

  // --- 1. Users ---
  const users = await Promise.all([
    prisma.user.upsert({
      where: { handle: "piers" },
      update: {},
      create: {
        handle: "piers",
        email: "piers@delphidigital.io",
        passwordHash,
        displayName: "Piers Kicks",
        role: "ADMIN",
        onboardingTrack: "TRACK_A",
      },
    }),
    prisma.user.upsert({
      where: { handle: "alex" },
      update: {},
      create: {
        handle: "alex",
        email: "alex@delphidigital.io",
        passwordHash,
        displayName: "Alex Chen",
        role: "MANAGER",
        onboardingTrack: "TRACK_A",
      },
    }),
    prisma.user.upsert({
      where: { handle: "demo-analyst" },
      update: {},
      create: {
        handle: "demo-analyst",
        email: "demo@delphidigital.io",
        passwordHash,
        displayName: "Demo Analyst",
        role: "ANALYST",
        onboardingTrack: "TRACK_B",
      },
    }),
  ]);

  console.log(`Seeded ${users.length} users`);

  // --- 2. Voice Profiles ---
  const voiceConfigs = [
    { humor: 35, formality: 75, brevity: 60, contrarianTone: 25, maturity: "ADVANCED" as const, tweetsAnalyzed: 200 },
    { humor: 55, formality: 50, brevity: 80, contrarianTone: 45, maturity: "INTERMEDIATE" as const, tweetsAnalyzed: 85 },
    { humor: 70, formality: 30, brevity: 50, contrarianTone: 60, maturity: "BEGINNER" as const, tweetsAnalyzed: 0 },
  ];

  for (let i = 0; i < users.length; i++) {
    await prisma.voiceProfile.upsert({
      where: { userId: users[i].id },
      update: {},
      create: {
        userId: users[i].id,
        ...voiceConfigs[i],
      },
    });
  }

  console.log("Seeded voice profiles");

  // --- 3. Tweet Drafts ---
  const draftTopics = [
    { content: "DeFi yields are compressing across the board. Aave v3 rates down 40% from Jan peaks. The risk-free rate on-chain is converging toward TradFi levels — and that's actually healthy for long-term adoption.", status: "POSTED" as const, sourceType: "REPORT" as const, confidence: 0.88, predictedEngagement: 22900, actualEngagement: 19400 },
    { content: "L2 throughput just hit a new ATH — 150 TPS combined across Arbitrum, Base, and OP Mainnet. The modular thesis is playing out faster than anyone expected. Gas costs on Base are now sub-cent for simple transfers.", status: "POSTED" as const, sourceType: "TRENDING_TOPIC" as const, confidence: 0.82, predictedEngagement: 15500, actualEngagement: 18200 },
    { content: "Hot take: The next cycle won't be driven by retail. Institutional allocators are building positions in liquid staking and RWAs while CT argues about memecoins. Follow the smart money, not the noise.", status: "APPROVED" as const, sourceType: "MANUAL" as const, confidence: 0.75, predictedEngagement: 12400, actualEngagement: null },
    { content: "Market structure update: CEX spot volumes down 35% MoM. DEX-to-CEX ratio now at 22% — highest ever. Uniswap v4 hooks are enabling custom AMM strategies that simply weren't possible before.", status: "DRAFT" as const, sourceType: "ARTICLE" as const, confidence: 0.71, predictedEngagement: 8200, actualEngagement: null },
    { content: "Stablecoin regulation thread incoming. The EU's MiCA framework is setting the template. Key takeaway: compliant stablecoins will capture 80%+ of volume by 2027. Non-compliant ones face de-listing risk.", status: "POSTED" as const, sourceType: "REPORT" as const, confidence: 0.85, predictedEngagement: 11200, actualEngagement: 13800 },
    { content: "MEV is the most misunderstood topic in crypto. It's not just 'sandwich attacks.' Flashbots is building infrastructure that makes block production more fair. PBS is a net positive for Ethereum.", status: "DRAFT" as const, sourceType: "MANUAL" as const, confidence: 0.68, predictedEngagement: 6500, actualEngagement: null },
    { content: "Governance participation rates across top 20 DAOs: median 3.2% of token supply votes. That's embarrassingly low. Conviction voting and delegation markets could change this — Arbitrum DAO is leading here.", status: "APPROVED" as const, sourceType: "TWEET" as const, confidence: 0.79, predictedEngagement: 9800, actualEngagement: null },
    { content: "Bitcoin ETF flows flipped net positive again this week ($890M inflows). IBIT alone accounts for 60% of volume. The TradFi-to-crypto pipeline is now a permanent fixture of market structure.", status: "POSTED" as const, sourceType: "TRENDING_TOPIC" as const, confidence: 0.91, predictedEngagement: 25600, actualEngagement: 28100 },
    { content: "Unpopular opinion: Most 'AI x Crypto' projects are vaporware. The 3 that actually matter: Bittensor (decentralized inference), Ritual (on-chain ML), and Morpheus (agent infrastructure). Everything else is marketing.", status: "DRAFT" as const, sourceType: "MANUAL" as const, confidence: 0.65, predictedEngagement: 18000, actualEngagement: null },
    { content: "Weekly alpha: Solana's state compression just reduced NFT minting costs by 99.9%. This unlocks loyalty programs, gaming assets, and identity credentials at scale. Watch for enterprise adoption this quarter.", status: "APPROVED" as const, sourceType: "ARTICLE" as const, confidence: 0.77, predictedEngagement: 7400, actualEngagement: null },
  ];

  for (let i = 0; i < draftTopics.length; i++) {
    const userIdx = i % users.length;
    const d = draftTopics[i];
    await prisma.tweetDraft.create({
      data: {
        userId: users[userIdx].id,
        content: d.content,
        status: d.status,
        sourceType: d.sourceType,
        confidence: d.confidence,
        predictedEngagement: d.predictedEngagement,
        actualEngagement: d.actualEngagement,
        createdAt: daysAgo(randomBetween(1, 28)),
      },
    });
  }

  console.log(`Seeded ${draftTopics.length} tweet drafts`);

  // --- 4. Research Results (Trending Topics) ---
  const researchEntries = [
    { query: "DeFi yield compression 2026", summary: "Cross-protocol yields declining toward TradFi parity. Aave, Compound, and Maker rates converging around 3-5% APY.", sentiment: "neutral", confidence: 0.84 },
    { query: "Layer 2 scaling throughput", summary: "Combined L2 TPS exceeds Ethereum L1 by 10x. Base and Arbitrum leading in transaction volume.", sentiment: "bullish", confidence: 0.89 },
    { query: "Stablecoin regulation MiCA", summary: "EU MiCA framework effective. Circle USDC positioned as compliant leader. Tether facing de-listing pressure in EU markets.", sentiment: "mixed", confidence: 0.78 },
    { query: "Bitcoin ETF institutional flows", summary: "Weekly net inflows averaging $600M+. BlackRock IBIT dominates with 60% market share. Grayscale outflows stabilizing.", sentiment: "bullish", confidence: 0.92 },
    { query: "AI crypto intersection projects", summary: "Bittensor, Ritual, and Morpheus identified as legitimate projects. Most AI+crypto tokens lack technical substance.", sentiment: "bearish", confidence: 0.71 },
    { query: "Solana state compression adoption", summary: "NFT minting costs reduced by 99.9%. Enterprise pilots for loyalty programs and identity credentials underway.", sentiment: "bullish", confidence: 0.81 },
    { query: "MEV protection mechanisms", summary: "Flashbots PBS adoption growing. Block building separated from proposing. MEV redistribution to users via MEV-Share.", sentiment: "neutral", confidence: 0.76 },
    { query: "DAO governance participation rates", summary: "Median voting participation at 3.2% of token supply. Delegation markets and conviction voting emerging as solutions.", sentiment: "bearish", confidence: 0.73 },
  ];

  for (let i = 0; i < researchEntries.length; i++) {
    const userIdx = i % users.length;
    const r = researchEntries[i];
    await prisma.researchResult.create({
      data: {
        userId: users[userIdx].id,
        query: r.query,
        summary: r.summary,
        keyFacts: ["Key finding 1", "Key finding 2", "Key finding 3"],
        sentiment: r.sentiment,
        relatedTopics: ["DeFi", "Ethereum", "Market Structure"],
        sources: [{ title: "Delphi Research", url: "https://delphidigital.io" }],
        confidence: r.confidence,
        createdAt: daysAgo(randomBetween(1, 21)),
      },
    });
  }

  console.log(`Seeded ${researchEntries.length} research results`);

  // --- 5. Analytics Events (30-day spread) ---
  const eventTypes = [
    "DRAFT_CREATED", "DRAFT_POSTED", "ENGAGEMENT_RECORDED",
    "SESSION_START", "VOICE_REFINEMENT", "REPORT_INGESTED",
    "RESEARCH_CONDUCTED", "FEEDBACK_GIVEN",
  ] as const;

  let eventCount = 0;
  for (let day = 0; day < 30; day++) {
    const eventsPerDay = randomBetween(3, 12);
    for (let e = 0; e < eventsPerDay; e++) {
      const userIdx = randomBetween(0, users.length - 1);
      const typeIdx = randomBetween(0, eventTypes.length - 1);
      await prisma.analyticsEvent.create({
        data: {
          userId: users[userIdx].id,
          type: eventTypes[typeIdx],
          value: typeIdx <= 2 ? randomBetween(100, 30000) : randomBetween(1, 10),
          metadata: { source: "seed", day },
          createdAt: daysAgo(day),
        },
      });
      eventCount++;
    }
  }

  console.log(`Seeded ${eventCount} analytics events`);

  // --- 6. Learning Log Entries ---
  const learningEntries = [
    { event: "Voice calibration completed from 50 tweets", impact: "Humor dimension adjusted from 50 → 35 based on tweet analysis", positive: true },
    { event: "Draft engagement exceeded prediction by 18%", impact: "Model confidence for market structure topics increased", positive: true },
    { event: "Low engagement on contrarian take about MEV", impact: "Contrarian tone threshold adjusted — too aggressive for current audience", positive: false },
    { event: "Reference voice @punk6529 added to blend", impact: "Thread-style formatting improved, avg engagement up 12%", positive: true },
    { event: "3 drafts archived without posting", impact: "AI-generated content needs more human editing for authenticity", positive: false },
    { event: "First tweet hit 25K+ impressions", impact: "Identified optimal posting time and topic formula for DeFi analysis", positive: true },
    { event: "Voice maturity upgraded to Intermediate", impact: "Unlocked advanced generation features and multi-voice blending", positive: true },
    { event: "Engagement prediction off by 40% on regulatory topic", impact: "Model retrained with regulatory sentiment data", positive: false },
  ];

  for (let i = 0; i < learningEntries.length; i++) {
    const userIdx = i % users.length;
    const l = learningEntries[i];
    await prisma.learningLogEntry.create({
      data: {
        userId: users[userIdx].id,
        event: l.event,
        impact: l.impact,
        positive: l.positive,
        createdAt: daysAgo(randomBetween(1, 25)),
      },
    });
  }

  console.log(`Seeded ${learningEntries.length} learning log entries`);

  console.log("\nSeed complete!");
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
