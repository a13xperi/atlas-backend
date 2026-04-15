import "dotenv/config";

import bcrypt from "bcryptjs";
import {
  AlertDelivery,
  AlertType,
  AnalyticsType,
  DraftStatus,
  OnboardingTrack,
  Role,
  SourceType,
  VoiceMaturity,
} from "@prisma/client";
import { prisma } from "../services/api/src/lib/prisma";

/**
 * The current schema supports one VoiceProfile per user.
 * To provide multiple demo voice setups per analyst without a schema change,
 * this seed creates one primary VoiceProfile plus multiple reference voices and saved blends.
 */

const SEED_TAG = "atlas-demo-seed-v1";

type VoiceProfileSeed = {
  humor: number;
  formality: number;
  brevity: number;
  contrarianTone: number;
  maturity: VoiceMaturity;
  tweetsAnalyzed: number;
};

type ReferenceVoiceSeed = {
  key: string;
  name: string;
  handle?: string;
  avatarUrl?: string;
  isActive?: boolean;
};

type BlendSeed = {
  name: string;
  voices: Array<{
    label: string;
    percentage: number;
    referenceKey?: string;
  }>;
};

type DraftSeed = {
  content: string;
  status: DraftStatus;
  sourceType: SourceType;
  sourceContent?: string;
  blendName?: string;
  confidence: number;
  predictedEngagement: number;
  actualEngagement?: number;
  engagementMetrics?: {
    likes: number;
    retweets: number;
    impressions: number;
  };
  feedback?: string;
  version?: number;
  daysAgo: number;
  hour?: number;
};

type AlertSubscriptionSeed = {
  type: AlertType;
  value: string;
  delivery: AlertDelivery[];
  isActive?: boolean;
};

type AlertSeed = {
  type: string;
  title: string;
  context: string;
  draftReply?: string;
  sourceUrl?: string;
  sentiment?: string;
  relevance?: number;
  daysAgo: number;
  hour?: number;
};

type LearningLogSeed = {
  event: string;
  impact: string;
  positive: boolean;
  daysAgo: number;
  hour?: number;
};

type SessionSeed = {
  suffix: string;
  daysAgo: number;
  hour?: number;
};

type DemoUserSeed = {
  handle: string;
  email: string;
  displayName: string;
  role: Role;
  onboardingTrack?: OnboardingTrack;
  telegramChatId?: string;
  voiceProfile?: VoiceProfileSeed;
  references?: ReferenceVoiceSeed[];
  blends?: BlendSeed[];
  drafts?: DraftSeed[];
  subscriptions?: AlertSubscriptionSeed[];
  alerts?: AlertSeed[];
  learningLogs?: LearningLogSeed[];
  sessions?: SessionSeed[];
};

const demoUsers: DemoUserSeed[] = [
  {
    handle: "anil",
    email: "anil@delphidigital.io",
    displayName: "Anil Lulla",
    role: Role.MANAGER,
    onboardingTrack: OnboardingTrack.TRACK_A,
    voiceProfile: {
      humor: 35,
      formality: 72,
      brevity: 65,
      contrarianTone: 45,
      maturity: VoiceMaturity.ADVANCED,
      tweetsAnalyzed: 240,
    },
    references: [
      { key: "delphi", name: "Delphi Digital", handle: "@Delphi_Digital" },
      { key: "messari", name: "Messari", handle: "@MessariCrypto" },
      { key: "zhu-su", name: "Zhu Su", handle: "@zaborsky" },
    ],
    blends: [
      {
        name: "Delphi Voice",
        voices: [
          { label: "Anil", percentage: 70 },
          { label: "Delphi Digital", percentage: 20, referenceKey: "delphi" },
          { label: "Messari", percentage: 10, referenceKey: "messari" },
        ],
      },
      {
        name: "Market Commentary",
        voices: [
          { label: "Anil", percentage: 55 },
          { label: "Messari", percentage: 25, referenceKey: "messari" },
          { label: "Zhu Su", percentage: 20, referenceKey: "zhu-su" },
        ],
      },
    ],
    drafts: [
      {
        content:
          "The crypto research industry is evolving from selling reports to selling decision frameworks. The next generation of research firms will look more like Bloomberg terminals than PDF subscriptions.",
        status: DraftStatus.POSTED,
        sourceType: SourceType.REPORT,
        sourceContent: "Internal memo on Delphi research product evolution and competitive landscape.",
        blendName: "Delphi Voice",
        confidence: 0.91,
        predictedEngagement: 12400,
        actualEngagement: 15800,
        engagementMetrics: { likes: 412, retweets: 89, impressions: 58000 },
        version: 2,
        daysAgo: 12,
        hour: 8,
      },
      {
        content:
          "Tokenized treasuries crossed $2B and nobody batted an eye. That is the signal. When TradFi adoption stops making headlines, it means the integration is working.",
        status: DraftStatus.POSTED,
        sourceType: SourceType.TRENDING_TOPIC,
        sourceContent: "Discussion around tokenized treasury growth and institutional adoption metrics.",
        blendName: "Market Commentary",
        confidence: 0.86,
        predictedEngagement: 9200,
        actualEngagement: 10500,
        engagementMetrics: { likes: 298, retweets: 67, impressions: 41200 },
        version: 1,
        daysAgo: 8,
        hour: 9,
      },
      {
        content:
          "Team shipping velocity is the real alpha in a research org. One analyst who posts three high-signal tweets a week is worth five who publish a monthly PDF.",
        status: DraftStatus.APPROVED,
        sourceType: SourceType.MANUAL,
        blendName: "Delphi Voice",
        confidence: 0.78,
        predictedEngagement: 7600,
        feedback: "Might be too spicy for the brand account. Consider framing as industry observation.",
        version: 2,
        daysAgo: 4,
        hour: 10,
      },
      {
        content:
          "AI-assisted content creation is not about replacing analysts. It is about giving every junior the output quality of a senior and letting seniors focus on original thinking.",
        status: DraftStatus.DRAFT,
        sourceType: SourceType.MANUAL,
        blendName: "Delphi Voice",
        confidence: 0.74,
        predictedEngagement: 6800,
        daysAgo: 1,
        hour: 14,
      },
    ],
    subscriptions: [
      { type: AlertType.CATEGORY, value: "DeFi", delivery: [AlertDelivery.PORTAL, AlertDelivery.TELEGRAM] },
      { type: AlertType.CATEGORY, value: "Institutional", delivery: [AlertDelivery.PORTAL] },
      { type: AlertType.ACCOUNT, value: "@Delphi_Digital", delivery: [AlertDelivery.PORTAL, AlertDelivery.TELEGRAM] },
    ],
    alerts: [
      {
        type: "trending",
        title: "RWA narrative gaining institutional traction",
        context: "Multiple asset managers announced tokenized fund products this week, driving RWA token performance.",
        draftReply: "The RWA thesis is playing out faster than expected. When BlackRock and Franklin Templeton are both live, the question shifts from 'if' to 'how fast'.",
        relevance: 92,
        sentiment: "bullish",
        daysAgo: 3,
        hour: 7,
      },
      {
        type: "mention",
        title: "Delphi Digital cited in CoinDesk analysis",
        context: "CoinDesk referenced Delphi's research on L2 economics in their weekly analysis piece.",
        sourceUrl: "https://coindesk.com/example",
        relevance: 85,
        sentiment: "neutral",
        daysAgo: 1,
        hour: 11,
      },
    ],
    learningLogs: [
      {
        event: "Thread format outperformed single tweet by 3x engagement",
        impact: "Shifting default output to thread-first for macro takes.",
        positive: true,
        daysAgo: 10,
        hour: 9,
      },
      {
        event: "Institutional tone resonated more than CT-native voice",
        impact: "Manager-level accounts should lean formal. Reserve CT voice for analyst accounts.",
        positive: true,
        daysAgo: 5,
        hour: 14,
      },
    ],
    sessions: [
      { suffix: "morning", daysAgo: 12, hour: 8 },
      { suffix: "review", daysAgo: 8, hour: 10 },
      { suffix: "desk", daysAgo: 4, hour: 9 },
      { suffix: "latest", daysAgo: 0, hour: 14 },
    ],
  },
  {
    handle: "maya-demo",
    email: "maya.demo@delphidigital.io",
    displayName: "Maya Patel",
    role: Role.ANALYST,
    onboardingTrack: OnboardingTrack.TRACK_A,
    telegramChatId: "maya-demo-telegram",
    voiceProfile: {
      humor: 68,
      formality: 42,
      brevity: 58,
      contrarianTone: 24,
      maturity: VoiceMaturity.BEGINNER,
      tweetsAnalyzed: 18,
    },
    references: [
      { key: "cobie", name: "Cobie", handle: "@Cobie" },
      { key: "base", name: "Base", handle: "@base" },
      { key: "defi-edge", name: "The DeFi Edge", handle: "@thedefiedge" },
    ],
    blends: [
      {
        name: "Starter Thread",
        voices: [
          { label: "Maya", percentage: 55 },
          { label: "Cobie", percentage: 25, referenceKey: "cobie" },
          { label: "Base", percentage: 20, referenceKey: "base" },
        ],
      },
      {
        name: "Fast CT Mode",
        voices: [
          { label: "Maya", percentage: 50 },
          { label: "Cobie", percentage: 35, referenceKey: "cobie" },
          { label: "The DeFi Edge", percentage: 15, referenceKey: "defi-edge" },
        ],
      },
      {
        name: "Research Lite",
        voices: [
          { label: "Maya", percentage: 60 },
          { label: "The DeFi Edge", percentage: 25, referenceKey: "defi-edge" },
          { label: "Base", percentage: 15, referenceKey: "base" },
        ],
      },
    ],
    drafts: [
      {
        content:
          "Stablecoin velocity is picking up again, and that matters more than the headline TVL number. If dollars are moving faster onchain, product usage is finally catching up to the narrative.",
        status: DraftStatus.POSTED,
        sourceType: SourceType.REPORT,
        sourceContent: "Delphi note on stablecoin velocity across Base, Solana, and Ethereum.",
        blendName: "Research Lite",
        confidence: 0.81,
        predictedEngagement: 6200,
        actualEngagement: 7100,
        engagementMetrics: { likes: 188, retweets: 42, impressions: 26400 },
        version: 2,
        daysAgo: 16,
        hour: 9,
      },
      {
        content:
          "Base fees staying low is great, but the bigger unlock is teams shipping consumer flows that feel invisible. The chain that wins the next wave is the one users barely notice.",
        status: DraftStatus.APPROVED,
        sourceType: SourceType.TRENDING_TOPIC,
        sourceContent: "Trending discussion around Base fee compression and consumer app growth.",
        blendName: "Fast CT Mode",
        confidence: 0.74,
        predictedEngagement: 5400,
        feedback: "Tighten the first sentence and add one concrete metric.",
        version: 2,
        daysAgo: 11,
        hour: 10,
      },
      {
        content:
          "Onchain consumer apps still have a retention problem. Users will forgive rough edges in a bull market, but they won’t tolerate clunky wallet UX forever.",
        status: DraftStatus.DRAFT,
        sourceType: SourceType.MANUAL,
        blendName: "Starter Thread",
        confidence: 0.63,
        predictedEngagement: 3100,
        daysAgo: 8,
        hour: 11,
      },
      {
        content:
          "Memecoin volume rotating into infra is actually healthy. When traders stop chasing every launcher and start funding rails, that’s usually when the durable builders get room to run.",
        status: DraftStatus.POSTED,
        sourceType: SourceType.ARTICLE,
        sourceContent: "Article covering memecoin volume decline and infra token outperformance.",
        blendName: "Fast CT Mode",
        confidence: 0.79,
        predictedEngagement: 6800,
        actualEngagement: 6400,
        engagementMetrics: { likes: 154, retweets: 31, impressions: 22100 },
        daysAgo: 5,
        hour: 8,
      },
      {
        content:
          "RWAs feel less like a shiny narrative and more like plumbing now. The real question is which teams can make settlement feel boring enough for real operators to trust.",
        status: DraftStatus.APPROVED,
        sourceType: SourceType.REPORT,
        sourceContent: "Delphi research brief on RWA treasury product growth and settlement rails.",
        blendName: "Research Lite",
        confidence: 0.77,
        predictedEngagement: 5900,
        feedback: "Add a stronger ending and cut one adjective from the opener.",
        daysAgo: 2,
        hour: 9,
      },
      {
        content:
          "Wallet UX is the next distribution moat. The first product that makes signing, swapping, and recovering feel normal will onboard more users than a hundred incentive campaigns.",
        status: DraftStatus.DRAFT,
        sourceType: SourceType.TWEET,
        sourceContent: "Tweet thread about embedded wallets and passkey adoption.",
        blendName: "Starter Thread",
        confidence: 0.66,
        predictedEngagement: 2900,
        version: 1,
        daysAgo: 1,
        hour: 10,
      },
    ],
    subscriptions: [
      { type: AlertType.CATEGORY, value: "Consumer Crypto", delivery: [AlertDelivery.PORTAL, AlertDelivery.TELEGRAM] },
      { type: AlertType.ACCOUNT, value: "@base", delivery: [AlertDelivery.PORTAL] },
    ],
    alerts: [
      {
        type: "CATEGORY",
        title: "Consumer crypto launch volume is climbing",
        context: "Base ecosystem launches are up week over week, with wallets and social apps leading submissions.",
        draftReply: "Consumer UX is slowly becoming the wedge, not the afterthought.",
        sentiment: "bullish",
        relevance: 0.84,
        daysAgo: 2,
        hour: 13,
      },
      {
        type: "ACCOUNT",
        title: "Base posted a new wallet abstraction update",
        context: "The team highlighted passkey recovery improvements and lower friction for first-time users.",
        sourceUrl: "https://x.com/base",
        sentiment: "neutral",
        relevance: 0.9,
        daysAgo: 0,
        hour: 9,
      },
    ],
    learningLogs: [
      {
        event: "Shorter first lines improved approval rate",
        impact: "Drafts with a clear first sentence moved from draft to approved more quickly.",
        positive: true,
        daysAgo: 6,
        hour: 14,
      },
      {
        event: "Memecoin commentary felt too broad",
        impact: "Specific infra examples perform better than generic cycle commentary.",
        positive: false,
        daysAgo: 3,
        hour: 12,
      },
    ],
    sessions: [
      { suffix: "morning", daysAgo: 12, hour: 8 },
      { suffix: "desk", daysAgo: 4, hour: 9 },
      { suffix: "mobile", daysAgo: 1, hour: 7 },
    ],
  },
  {
    handle: "omar-demo",
    email: "omar.demo@delphidigital.io",
    displayName: "Omar Ruiz",
    role: Role.ANALYST,
    onboardingTrack: OnboardingTrack.TRACK_B,
    telegramChatId: "omar-demo-telegram",
    voiceProfile: {
      humor: 34,
      formality: 63,
      brevity: 74,
      contrarianTone: 45,
      maturity: VoiceMaturity.INTERMEDIATE,
      tweetsAnalyzed: 84,
    },
    references: [
      { key: "hasu", name: "Hasu", handle: "@hasufl" },
      { key: "delphi", name: "Delphi Digital", handle: "@Delphi_Digital" },
      { key: "defi-investor", name: "The DeFi Investor", handle: "@TheDeFinvestor" },
    ],
    blends: [
      {
        name: "Desk Note",
        voices: [
          { label: "Omar", percentage: 60 },
          { label: "Hasu", percentage: 25, referenceKey: "hasu" },
          { label: "Delphi Digital", percentage: 15, referenceKey: "delphi" },
        ],
      },
      {
        name: "Risk Radar",
        voices: [
          { label: "Omar", percentage: 55 },
          { label: "Hasu", percentage: 30, referenceKey: "hasu" },
          { label: "The DeFi Investor", percentage: 15, referenceKey: "defi-investor" },
        ],
      },
      {
        name: "Yield Thread",
        voices: [
          { label: "Omar", percentage: 50 },
          { label: "Delphi Digital", percentage: 25, referenceKey: "delphi" },
          { label: "The DeFi Investor", percentage: 25, referenceKey: "defi-investor" },
        ],
      },
    ],
    drafts: [
      {
        content:
          "Aave utilization is high, but the real story is how quickly lenders are repricing risk. DeFi credit markets are getting more efficient, and weaker collateral is losing the subsidy it enjoyed last year.",
        status: DraftStatus.POSTED,
        sourceType: SourceType.REPORT,
        sourceContent: "Internal lending dashboard review for Aave, Morpho, and Spark.",
        blendName: "Desk Note",
        confidence: 0.86,
        predictedEngagement: 7600,
        actualEngagement: 8040,
        engagementMetrics: { likes: 201, retweets: 46, impressions: 30100 },
        version: 2,
        daysAgo: 15,
        hour: 8,
      },
      {
        content:
          "Restaking still looks underpriced if you only watch TVL. The hidden variable is who can actually absorb correlation when one layer of trust assumptions fails.",
        status: DraftStatus.APPROVED,
        sourceType: SourceType.ARTICLE,
        sourceContent: "Article on restaking design tradeoffs and operator concentration.",
        blendName: "Risk Radar",
        confidence: 0.8,
        predictedEngagement: 6900,
        feedback: "Lead with the risk and remove one hedge from the second sentence.",
        version: 2,
        daysAgo: 10,
        hour: 9,
      },
      {
        content:
          "Curve wars are quieter now, but incentive design is still doing most of the strategic work in DeFi. The next winners won’t be the loudest, just the cleanest at retaining sticky liquidity.",
        status: DraftStatus.DRAFT,
        sourceType: SourceType.MANUAL,
        blendName: "Yield Thread",
        confidence: 0.69,
        predictedEngagement: 3600,
        daysAgo: 7,
        hour: 11,
      },
      {
        content:
          "Pendle growth looks less speculative when you map it against treasury demand. Fixed yield is no longer a niche product when stablecoin desks need duration without taking directional beta.",
        status: DraftStatus.POSTED,
        sourceType: SourceType.TRENDING_TOPIC,
        sourceContent: "Trending conversation around Pendle PT demand and stablecoin desk positioning.",
        blendName: "Yield Thread",
        confidence: 0.83,
        predictedEngagement: 7200,
        actualEngagement: 6900,
        engagementMetrics: { likes: 176, retweets: 39, impressions: 24800 },
        daysAgo: 4,
        hour: 10,
      },
      {
        content:
          "The next DeFi unlock is boring middleware. Better accounting, better permissions, and better treasury tooling will matter more than another points program.",
        status: DraftStatus.APPROVED,
        sourceType: SourceType.REPORT,
        sourceContent: "Quarterly note on DeFi back-office tooling and treasury management.",
        blendName: "Desk Note",
        confidence: 0.78,
        predictedEngagement: 5200,
        feedback: "Add one concrete example from treasury workflows.",
        daysAgo: 2,
        hour: 8,
      },
      {
        content:
          "MEV is getting reframed from threat to cost center. Teams that quantify and route around it will ship better UX than teams that keep treating it like an abstract protocol debate.",
        status: DraftStatus.DRAFT,
        sourceType: SourceType.TWEET,
        sourceContent: "Thread on application-aware MEV mitigation.",
        blendName: "Risk Radar",
        confidence: 0.71,
        predictedEngagement: 4100,
        version: 1,
        daysAgo: 0,
        hour: 8,
      },
    ],
    subscriptions: [
      { type: AlertType.CATEGORY, value: "DeFi", delivery: [AlertDelivery.PORTAL, AlertDelivery.TELEGRAM] },
      { type: AlertType.ACCOUNT, value: "@aave", delivery: [AlertDelivery.PORTAL] },
    ],
    alerts: [
      {
        type: "CATEGORY",
        title: "Lending utilization is rising across majors",
        context: "Aave and Morpho both posted higher utilization this week as rates normalized around productive borrow demand.",
        draftReply: "Utilization staying high while spreads compress is a sign the market is maturing.",
        sentiment: "bullish",
        relevance: 0.88,
        daysAgo: 1,
        hour: 13,
      },
      {
        type: "ACCOUNT",
        title: "Aave governance thread flagged new collateral changes",
        context: "Risk parameters are tightening on long-tail assets while stable collateral capacity expands.",
        sourceUrl: "https://x.com/aave",
        sentiment: "neutral",
        relevance: 0.93,
        daysAgo: 0,
        hour: 10,
      },
    ],
    learningLogs: [
      {
        event: "Risk-first openings improved post rate",
        impact: "Drafts that frame the downside first get approved faster by the manager.",
        positive: true,
        daysAgo: 5,
        hour: 15,
      },
      {
        event: "Overexplaining killed brevity",
        impact: "Condensing protocol setup into one sentence keeps the thread moving.",
        positive: false,
        daysAgo: 2,
        hour: 11,
      },
    ],
    sessions: [
      { suffix: "desk", daysAgo: 13, hour: 7 },
      { suffix: "lunch", daysAgo: 6, hour: 12 },
      { suffix: "close", daysAgo: 0, hour: 16 },
    ],
  },
  {
    handle: "sofia-demo",
    email: "sofia.demo@delphidigital.io",
    displayName: "Sofia Park",
    role: Role.ANALYST,
    onboardingTrack: OnboardingTrack.TRACK_A,
    telegramChatId: "sofia-demo-telegram",
    voiceProfile: {
      humor: 26,
      formality: 78,
      brevity: 69,
      contrarianTone: 62,
      maturity: VoiceMaturity.ADVANCED,
      tweetsAnalyzed: 167,
    },
    references: [
      { key: "arthur", name: "Arthur Hayes", handle: "@CryptoHayes" },
      { key: "cms", name: "CMS Holdings", handle: "@cmsholdings" },
      { key: "delphi-macro", name: "Delphi Macro", handle: "@Delphi_Digital" },
    ],
    blends: [
      {
        name: "Macro Desk",
        voices: [
          { label: "Sofia", percentage: 65 },
          { label: "CMS Holdings", percentage: 20, referenceKey: "cms" },
          { label: "Delphi Macro", percentage: 15, referenceKey: "delphi-macro" },
        ],
      },
      {
        name: "Contrarian Tape",
        voices: [
          { label: "Sofia", percentage: 50 },
          { label: "Arthur Hayes", percentage: 35, referenceKey: "arthur" },
          { label: "Delphi Macro", percentage: 15, referenceKey: "delphi-macro" },
        ],
      },
      {
        name: "Institutional Note",
        voices: [
          { label: "Sofia", percentage: 60 },
          { label: "Delphi Macro", percentage: 25, referenceKey: "delphi-macro" },
          { label: "CMS Holdings", percentage: 15, referenceKey: "cms" },
        ],
      },
    ],
    drafts: [
      {
        content:
          "ETF inflows matter, but the second-order effect matters more: they compress the career risk of owning crypto. Once allocators can point to a compliant wrapper, portfolio construction changes fast.",
        status: DraftStatus.POSTED,
        sourceType: SourceType.REPORT,
        sourceContent: "Institutional flows note covering ETF allocation behavior and treasury adoption.",
        blendName: "Institutional Note",
        confidence: 0.89,
        predictedEngagement: 9800,
        actualEngagement: 11200,
        engagementMetrics: { likes: 264, retweets: 61, impressions: 40200 },
        version: 3,
        daysAgo: 14,
        hour: 8,
      },
      {
        content:
          "Regulation is no longer a binary bull or bear input. It is becoming a sorting function, and compliant liquidity rails will capture the marginal institutional dollar first.",
        status: DraftStatus.APPROVED,
        sourceType: SourceType.ARTICLE,
        sourceContent: "Article on stablecoin policy, MiCA enforcement, and US treasury demand.",
        blendName: "Macro Desk",
        confidence: 0.84,
        predictedEngagement: 8500,
        feedback: "Make the sorting-function line the hook and remove one clause.",
        version: 2,
        daysAgo: 9,
        hour: 9,
      },
      {
        content:
          "Crypto equities are quietly becoming a leveraged expression of policy confidence. When the market prices looser regulation, the beta leaks there before it shows up in alt majors.",
        status: DraftStatus.DRAFT,
        sourceType: SourceType.MANUAL,
        blendName: "Contrarian Tape",
        confidence: 0.72,
        predictedEngagement: 4700,
        daysAgo: 6,
        hour: 10,
      },
      {
        content:
          "The dollar is still the core crypto growth story. Stablecoins remain the cleanest bridge between sovereign balance-sheet policy and internet-native distribution.",
        status: DraftStatus.POSTED,
        sourceType: SourceType.TRENDING_TOPIC,
        sourceContent: "Trending debate on stablecoin market share and treasury collateral demand.",
        blendName: "Macro Desk",
        confidence: 0.87,
        predictedEngagement: 9100,
        actualEngagement: 9680,
        engagementMetrics: { likes: 237, retweets: 53, impressions: 35500 },
        daysAgo: 3,
        hour: 11,
      },
      {
        content:
          "If rate cuts arrive into stronger crypto market structure, you get a more durable bid than the last cycle. Liquidity plus wrappers plus policy clarity is a materially different setup.",
        status: DraftStatus.APPROVED,
        sourceType: SourceType.REPORT,
        sourceContent: "Macro desk update on global liquidity, ETF flows, and crypto beta.",
        blendName: "Institutional Note",
        confidence: 0.85,
        predictedEngagement: 8700,
        feedback: "Shorten the ending and add one market-structure example.",
        daysAgo: 1,
        hour: 8,
      },
      {
        content:
          "Most macro takes on crypto still ignore settlement demand. Payments, treasury collateral, and exchange balances tell you more about durability than narrative volume does.",
        status: DraftStatus.DRAFT,
        sourceType: SourceType.TWEET,
        sourceContent: "Macro strategist thread about stablecoin growth versus speculative turnover.",
        blendName: "Contrarian Tape",
        confidence: 0.76,
        predictedEngagement: 5100,
        version: 1,
        daysAgo: 0,
        hour: 9,
      },
    ],
    subscriptions: [
      { type: AlertType.CATEGORY, value: "Macro", delivery: [AlertDelivery.PORTAL, AlertDelivery.TELEGRAM] },
      { type: AlertType.ACCOUNT, value: "@blackrock", delivery: [AlertDelivery.PORTAL] },
    ],
    alerts: [
      {
        type: "CATEGORY",
        title: "ETF flow momentum stayed positive this week",
        context: "Spot ETF inflows remained positive for the fourth straight session while basis stayed orderly.",
        draftReply: "The structural bid matters more than the single-day headline.",
        sentiment: "bullish",
        relevance: 0.91,
        daysAgo: 1,
        hour: 14,
      },
      {
        type: "ACCOUNT",
        title: "BlackRock commentary focused on long-term allocation",
        context: "Recent commentary framed crypto as an emerging sleeve rather than a tactical trade.",
        sourceUrl: "https://x.com/blackrock",
        sentiment: "neutral",
        relevance: 0.87,
        daysAgo: 0,
        hour: 12,
      },
    ],
    learningLogs: [
      {
        event: "Institutional framing increased predicted engagement",
        impact: "Tying macro takes back to allocator behavior improved confidence scores.",
        positive: true,
        daysAgo: 4,
        hour: 16,
      },
      {
        event: "Too much clause stacking reduced clarity",
        impact: "Cleaner sentence structure performs better than dense macro shorthand.",
        positive: false,
        daysAgo: 2,
        hour: 10,
      },
    ],
    sessions: [
      { suffix: "open", daysAgo: 10, hour: 7 },
      { suffix: "desk", daysAgo: 3, hour: 8 },
      { suffix: "review", daysAgo: 0, hour: 15 },
    ],
  },
  {
    handle: "lena-manager",
    email: "lena.manager@delphidigital.io",
    displayName: "Lena Brooks",
    role: Role.MANAGER,
    onboardingTrack: OnboardingTrack.TRACK_A,
    telegramChatId: "lena-manager-telegram",
    voiceProfile: {
      humor: 38,
      formality: 71,
      brevity: 63,
      contrarianTone: 36,
      maturity: VoiceMaturity.ADVANCED,
      tweetsAnalyzed: 132,
    },
    references: [
      { key: "piers", name: "Piers Kicks", handle: "@pierskicks" },
      { key: "delphi", name: "Delphi Digital", handle: "@Delphi_Digital" },
    ],
    blends: [
      {
        name: "Team Calibration",
        voices: [
          { label: "Lena", percentage: 70 },
          { label: "Delphi Digital", percentage: 30, referenceKey: "delphi" },
        ],
      },
      {
        name: "Review Notes",
        voices: [
          { label: "Lena", percentage: 65 },
          { label: "Piers Kicks", percentage: 35, referenceKey: "piers" },
        ],
      },
    ],
    subscriptions: [
      { type: AlertType.CATEGORY, value: "Team Ops", delivery: [AlertDelivery.PORTAL] },
      { type: AlertType.ACCOUNT, value: "@Delphi_Digital", delivery: [AlertDelivery.PORTAL, AlertDelivery.TELEGRAM] },
    ],
    alerts: [
      {
        type: "MANAGER",
        title: "Three analyst drafts are ready for review",
        context: "Approved drafts are waiting across Maya, Omar, and Sofia with fresh feedback attached.",
        sentiment: "neutral",
        relevance: 0.95,
        daysAgo: 0,
        hour: 8,
      },
    ],
    learningLogs: [
      {
        event: "Review cycles shortened this week",
        impact: "Analysts moved more drafts from draft to approved with fewer revision loops.",
        positive: true,
        daysAgo: 1,
        hour: 17,
      },
    ],
    sessions: [
      { suffix: "standup", daysAgo: 5, hour: 8 },
      { suffix: "review", daysAgo: 1, hour: 14 },
    ],
  },
  {
    handle: "anil",
    email: "anil@delphidigital.io",
    displayName: "Anil Lulla",
    role: Role.MANAGER,
    onboardingTrack: OnboardingTrack.TRACK_A,
    telegramChatId: "anil-telegram",
    voiceProfile: {
      humor: 45,
      formality: 72,
      brevity: 55,
      contrarianTone: 38,
      maturity: VoiceMaturity.ADVANCED,
      tweetsAnalyzed: 230,
    },
    references: [
      { key: "nic-carter", name: "Nic Carter", handle: "@nic__carter" },
      { key: "delphi-research", name: "Delphi Digital", handle: "@Delphi_Digital" },
      { key: "punk6529", name: "punk6529", handle: "@punk6529" },
    ],
    blends: [
      {
        name: "Founder Voice",
        voices: [
          { label: "Anil", percentage: 70 },
          { label: "Nic Carter", percentage: 20, referenceKey: "nic-carter" },
          { label: "Delphi Digital", percentage: 10, referenceKey: "delphi-research" },
        ],
      },
      {
        name: "Research Thread",
        voices: [
          { label: "Anil", percentage: 55 },
          { label: "Delphi Digital", percentage: 30, referenceKey: "delphi-research" },
          { label: "punk6529", percentage: 15, referenceKey: "punk6529" },
        ],
      },
    ],
    drafts: [
      {
        content: "Delphi's latest research on modular rollups shows we're at an inflection point. The data stack is finally catching up to the execution layer. Thread incoming.",
        status: DraftStatus.POSTED,
        sourceType: SourceType.REPORT,
        sourceContent: "Delphi modular rollup Q1 2026 report",
        confidence: 92,
        predictedEngagement: 85,
        actualEngagement: 91,
        engagementMetrics: { likes: 342, retweets: 78, impressions: 45200 },
        daysAgo: 8,
        hour: 10,
      },
      {
        content: "Everyone's talking about AI agents but nobody's talking about the infrastructure moat. The companies building the pipes will matter more than the apps on top.",
        status: DraftStatus.POSTED,
        sourceType: SourceType.MANUAL,
        confidence: 88,
        predictedEngagement: 78,
        actualEngagement: 82,
        engagementMetrics: { likes: 267, retweets: 54, impressions: 38100 },
        daysAgo: 5,
        hour: 9,
      },
      {
        content: "Stablecoin volumes just crossed $2T monthly. This isn't a crypto metric anymore — it's a payments metric. The rails are being rebuilt in real-time.",
        status: DraftStatus.DRAFT,
        sourceType: SourceType.TRENDING_TOPIC,
        confidence: 85,
        predictedEngagement: 72,
        daysAgo: 1,
        hour: 8,
      },
    ],
    subscriptions: [
      { type: AlertType.CATEGORY, value: "MACRO", delivery: [AlertDelivery.PORTAL, AlertDelivery.TELEGRAM] },
      { type: AlertType.CATEGORY, value: "DEFI", delivery: [AlertDelivery.PORTAL] },
      { type: AlertType.ACCOUNT, value: "@Delphi_Digital", delivery: [AlertDelivery.PORTAL, AlertDelivery.TELEGRAM] },
    ],
    alerts: [
      {
        type: "CATEGORY",
        title: "DeFi TVL crosses $300B for first time since 2021",
        context: "Total value locked across all chains has reached a new cycle high, driven primarily by restaking protocols and RWA tokenization.",
        sentiment: "bullish",
        relevance: 0.95,
        daysAgo: 2,
        hour: 7,
      },
      {
        type: "ACCOUNT",
        title: "New Delphi Digital report: State of Solana DePIN",
        context: "Comprehensive analysis of decentralized physical infrastructure networks building on Solana. Key findings: 40% QoQ growth in active nodes.",
        sourceUrl: "https://delphidigital.io/reports/solana-depin-2026",
        sentiment: "neutral",
        relevance: 0.88,
        daysAgo: 1,
        hour: 11,
      },
    ],
    learningLogs: [
      { event: "Voice calibration completed", impact: "Tone consistency improved 18% across drafts", positive: true, daysAgo: 14 },
      { event: "Thread format adopted", impact: "Engagement up 32% vs single tweets", positive: true, daysAgo: 7 },
      { event: "Manager blend override", impact: "Team voice alignment improved", positive: true, daysAgo: 3 },
    ],
    sessions: [
      { suffix: "morning", daysAgo: 3, hour: 8 },
      { suffix: "research", daysAgo: 1, hour: 10 },
    ],
  },
];

function daysAgo(days: number, hour = 9): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, 0, 0, 0);
  return date;
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60_000);
}

async function resetDemoData(userIds: string[]) {
  await prisma.$transaction([
    prisma.generatedImage.deleteMany({ where: { userId: { in: userIds } } }),
    prisma.analyticsEvent.deleteMany({ where: { userId: { in: userIds } } }),
    prisma.alert.deleteMany({ where: { userId: { in: userIds } } }),
    prisma.alertSubscription.deleteMany({ where: { userId: { in: userIds } } }),
    prisma.learningLogEntry.deleteMany({ where: { userId: { in: userIds } } }),
    prisma.researchResult.deleteMany({ where: { userId: { in: userIds } } }),
    prisma.session.deleteMany({ where: { userId: { in: userIds } } }),
    prisma.tweetDraft.deleteMany({ where: { userId: { in: userIds } } }),
    prisma.blendVoice.deleteMany({ where: { blend: { userId: { in: userIds } } } }),
    prisma.savedBlend.deleteMany({ where: { userId: { in: userIds } } }),
    prisma.referenceVoice.deleteMany({ where: { userId: { in: userIds } } }),
  ]);
}

async function seedUser(userSeed: DemoUserSeed, passwordHash: string) {
  const user = await prisma.user.upsert({
    where: { handle: userSeed.handle },
    update: {
      email: userSeed.email,
      displayName: userSeed.displayName,
      role: userSeed.role,
      onboardingTrack: userSeed.onboardingTrack ?? null,
      telegramChatId: userSeed.telegramChatId ?? null,
      passwordHash,
    },
    create: {
      handle: userSeed.handle,
      email: userSeed.email,
      displayName: userSeed.displayName,
      role: userSeed.role,
      onboardingTrack: userSeed.onboardingTrack,
      telegramChatId: userSeed.telegramChatId,
      passwordHash,
    },
  });

  if (userSeed.voiceProfile) {
    await prisma.voiceProfile.upsert({
      where: { userId: user.id },
      update: userSeed.voiceProfile,
      create: {
        userId: user.id,
        ...userSeed.voiceProfile,
      },
    });
  }

  const referenceVoiceIds = new Map<string, string>();
  for (const reference of userSeed.references ?? []) {
    const created = await prisma.referenceVoice.create({
      data: {
        userId: user.id,
        name: reference.name,
        handle: reference.handle,
        avatarUrl: reference.avatarUrl,
        isActive: reference.isActive ?? true,
      },
    });
    referenceVoiceIds.set(reference.key, created.id);
  }

  const blendIds = new Map<string, string>();
  for (const blend of userSeed.blends ?? []) {
    const created = await prisma.savedBlend.create({
      data: {
        userId: user.id,
        name: blend.name,
        voices: {
          create: blend.voices.map((voice) => ({
            label: voice.label,
            percentage: voice.percentage,
            referenceVoiceId: voice.referenceKey ? referenceVoiceIds.get(voice.referenceKey) : undefined,
          })),
        },
      },
    });
    blendIds.set(blend.name, created.id);
  }

  for (const subscription of userSeed.subscriptions ?? []) {
    await prisma.alertSubscription.upsert({
      where: {
        userId_type_value: {
          userId: user.id,
          type: subscription.type,
          value: subscription.value,
        },
      },
      update: {
        delivery: subscription.delivery,
        isActive: subscription.isActive ?? true,
      },
      create: {
        userId: user.id,
        type: subscription.type,
        value: subscription.value,
        delivery: subscription.delivery,
        isActive: subscription.isActive ?? true,
      },
    });
  }

  for (const alert of userSeed.alerts ?? []) {
    await prisma.alert.create({
      data: {
        type: alert.type,
        title: alert.title,
        context: alert.context,
        draftReply: alert.draftReply,
        sourceUrl: alert.sourceUrl,
        sentiment: alert.sentiment,
        relevance: alert.relevance,
        userId: user.id,
        createdAt: daysAgo(alert.daysAgo, alert.hour),
      },
    });
  }

  for (const entry of userSeed.learningLogs ?? []) {
    await prisma.learningLogEntry.create({
      data: {
        userId: user.id,
        event: entry.event,
        impact: entry.impact,
        positive: entry.positive,
        createdAt: daysAgo(entry.daysAgo, entry.hour),
      },
    });
  }

  for (let index = 0; index < (userSeed.sessions ?? []).length; index += 1) {
    const session = userSeed.sessions![index];
    const createdAt = daysAgo(session.daysAgo, session.hour);
    const sessionToken = `${SEED_TAG}:${userSeed.handle}:${session.suffix}:${index + 1}`;
    await prisma.session.upsert({
      where: { token: sessionToken },
      update: {},
      create: {
        userId: user.id,
        token: sessionToken,
        expiresAt: addDays(createdAt, 30),
        createdAt,
      },
    });

    await prisma.analyticsEvent.create({
      data: {
        userId: user.id,
        type: AnalyticsType.SESSION_START,
        metadata: {
          seedTag: SEED_TAG,
          session: session.suffix,
        },
        createdAt,
      },
    });
  }

  for (const draftSeed of userSeed.drafts ?? []) {
    const createdAt = daysAgo(draftSeed.daysAgo, draftSeed.hour);
    const draft = await prisma.tweetDraft.create({
      data: {
        userId: user.id,
        content: draftSeed.content,
        version: draftSeed.version ?? 1,
        status: draftSeed.status,
        confidence: draftSeed.confidence,
        predictedEngagement: draftSeed.predictedEngagement,
        actualEngagement: draftSeed.actualEngagement ?? null,
        engagementMetrics: draftSeed.engagementMetrics,
        sourceType: draftSeed.sourceType,
        sourceContent: draftSeed.sourceContent,
        blendId: draftSeed.blendName ? blendIds.get(draftSeed.blendName) : undefined,
        feedback: draftSeed.feedback,
        createdAt,
        updatedAt: addMinutes(createdAt, 45),
      },
    });

    const draftMetadata = {
      seedTag: SEED_TAG,
      draftId: draft.id,
      status: draft.status,
      sourceType: draft.sourceType,
      blendName: draftSeed.blendName ?? null,
    };

    await prisma.analyticsEvent.create({
      data: {
        userId: user.id,
        type: AnalyticsType.DRAFT_CREATED,
        metadata: draftMetadata,
        createdAt: addMinutes(createdAt, -10),
      },
    });

    if (draft.sourceType && draft.sourceType !== SourceType.MANUAL) {
      await prisma.analyticsEvent.create({
        data: {
          userId: user.id,
          type: AnalyticsType.RESEARCH_CONDUCTED,
          metadata: {
            ...draftMetadata,
            sourceContent: draft.sourceContent,
          },
          createdAt: addMinutes(createdAt, -20),
        },
      });
    }

    if ((draftSeed.version ?? 1) > 1 || draftSeed.feedback) {
      await prisma.analyticsEvent.create({
        data: {
          userId: user.id,
          type: AnalyticsType.VOICE_REFINEMENT,
          metadata: {
            ...draftMetadata,
            version: draft.version,
          },
          createdAt: addMinutes(createdAt, 5),
        },
      });
    }

    if (draftSeed.feedback) {
      await prisma.analyticsEvent.create({
        data: {
          userId: user.id,
          type: AnalyticsType.FEEDBACK_GIVEN,
          metadata: {
            ...draftMetadata,
            feedback: draftSeed.feedback,
          },
          createdAt: addMinutes(createdAt, 10),
        },
      });
    }

    if (draft.status === DraftStatus.POSTED) {
      await prisma.analyticsEvent.create({
        data: {
          userId: user.id,
          type: AnalyticsType.DRAFT_POSTED,
          metadata: draftMetadata,
          createdAt: addMinutes(createdAt, 20),
        },
      });
    }

    if (typeof draft.actualEngagement === "number") {
      await prisma.analyticsEvent.create({
        data: {
          userId: user.id,
          type: AnalyticsType.ENGAGEMENT_RECORDED,
          value: draft.actualEngagement,
          metadata: {
            ...draftMetadata,
            engagementMetrics: draft.engagementMetrics,
          },
          createdAt: addMinutes(createdAt, 30),
        },
      });
    }
  }

  const alertEventTargets = userSeed.alerts ?? [];
  for (const alert of alertEventTargets) {
    await prisma.analyticsEvent.create({
      data: {
        userId: user.id,
        type: AnalyticsType.ALERT_GENERATED,
        metadata: {
          seedTag: SEED_TAG,
          alertTitle: alert.title,
        },
        createdAt: daysAgo(alert.daysAgo, alert.hour),
      },
    });
  }

  return {
    user,
    draftCount: userSeed.drafts?.length ?? 0,
    subscriptionCount: userSeed.subscriptions?.length ?? 0,
  };
}

async function main() {
  const demoPassword = process.env.DEMO_SEED_PASSWORD;
  if (!demoPassword || demoPassword.length < 12) {
    throw new Error("DEMO_SEED_PASSWORD env var required (min 12 chars). Set it before running this seed.");
  }

  console.log("Seeding Atlas demo data for development and UAT...");

  const passwordHash = await bcrypt.hash(demoPassword, 10);

  const users = await Promise.all(
    demoUsers.map((user) =>
      prisma.user.upsert({
        where: { handle: user.handle },
        update: {
          email: user.email,
          displayName: user.displayName,
          role: user.role,
          onboardingTrack: user.onboardingTrack ?? null,
          telegramChatId: user.telegramChatId ?? null,
          passwordHash,
        },
        create: {
          handle: user.handle,
          email: user.email,
          displayName: user.displayName,
          role: user.role,
          onboardingTrack: user.onboardingTrack,
          telegramChatId: user.telegramChatId,
          passwordHash,
        },
      })
    )
  );

  await resetDemoData(users.map((user) => user.id));

  const seededUsers = [];
  for (const userSeed of demoUsers) {
    const seeded = await seedUser(userSeed, passwordHash);
    seededUsers.push(seeded);
  }

  const analystCount = demoUsers.filter((user) => user.role === Role.ANALYST).length;
  const managerCount = demoUsers.filter((user) => user.role === Role.MANAGER).length;
  const totalDrafts = seededUsers.reduce((sum, item) => sum + item.draftCount, 0);
  const totalSubscriptions = seededUsers.reduce((sum, item) => sum + item.subscriptionCount, 0);

  console.log(`Seeded ${analystCount} analysts and ${managerCount} manager.`);
  console.log(`Seeded ${totalDrafts} drafts and ${totalSubscriptions} alert subscriptions.`);
  console.log(`Demo password for all seeded users: ${demoPassword}`);
  console.log("Seed complete.");
}

main()
  .catch((error) => {
    console.error("Demo seed failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
