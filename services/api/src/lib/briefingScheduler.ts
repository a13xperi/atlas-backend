/**
 * Briefing Scheduler — auto-dispatch daily briefings at user-configured times.
 *
 * Called every 60 seconds by startScheduler(). Finds BriefingPreference rows
 * that are due based on each user's local timezone and that haven't received
 * a briefing in the last 23 hours, then generates one for each.
 */

import { prisma } from "./prisma";
import { logger } from "./logger";
import { routeCompletion } from "./providers/router";
import { withTimeout } from "./timeout";

export interface BriefingDispatchResult {
  sent: number;
  failed: number;
}

const BRIEF_TYPE_PROMPTS: Record<
  string,
  { focus: string; titlePrefix: string }
> = {
  morning: {
    titlePrefix: "Morning Brief",
    focus: "Synthesize overnight crypto/macro developments that matter for today's trading and content creation.",
  },
  sector: {
    titlePrefix: "Sector Brief",
    focus: "Deep-dive on a specific DeFi/L2/NFT sector — protocols, flows, catalysts.",
  },
  alpha: {
    titlePrefix: "Alpha Brief",
    focus: "Surface non-obvious opportunities: small caps, narrative shifts, early signals.",
  },
  competitor: {
    titlePrefix: "Competitor Brief",
    focus: "Track what other analysts and KOLs are covering — gaps, angles to differentiate.",
  },
};

export async function generateBriefingForUser(
  userId: string,
  briefType: string = "morning"
): Promise<void> {
  const typeConfig =
    BRIEF_TYPE_PROMPTS[briefType] ?? BRIEF_TYPE_PROMPTS.morning;

  const preferences = await prisma.briefingPreference.findUnique({
    where: { userId },
  });

  const topics = preferences?.topics ?? ["DeFi", "Macro"];
  const sources = preferences?.sources ?? ["X/Twitter", "News"];

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const systemPrompt = `You are Atlas's briefing engine for crypto analysts.
${typeConfig.focus}

Output JSON with this exact structure:
{
  "title": "${typeConfig.titlePrefix} — [Day, Month Date]",
  "summary": "2-3 sentence executive summary of what matters today",
  "sections": [
    {
      "heading": "Section name",
      "emoji": "single emoji",
      "bullets": ["bullet 1", "bullet 2", "bullet 3"]
    }
  ]
}

Rules:
- 3-5 sections max
- 2-4 bullets per section
- Each bullet under 30 words
- Be specific — name projects, protocols, people
- Include actionable intel ("watch for...", "key level at...")
- No fluff, no disclaimers`;

  const userMessage = `Generate a ${typeConfig.titlePrefix.toLowerCase()} for ${today}.
Topics: ${topics.join(", ")}
Sources: ${sources.join(", ")}

Make it specific and actionable.`;

  const response = await withTimeout(
    routeCompletion({
      taskType: "research",
      maxTokens: 800,
      temperature: 0.7,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }),
    15_000,
    "briefing-schedule"
  );

  let briefingData: { title: string; summary: string; sections: any[] };
  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    briefingData = JSON.parse(jsonMatch?.[0] ?? response.content);
  } catch {
    briefingData = {
      title: `${typeConfig.titlePrefix} — ${today}`,
      summary: response.content.slice(0, 200),
      sections: [
        {
          heading: "Today's Intel",
          emoji: "📊",
          bullets: [response.content.slice(0, 100)],
        },
      ],
    };
  }

  await prisma.briefing.create({
    data: {
      userId,
      title: briefingData.title,
      summary: briefingData.summary,
      sections: briefingData.sections,
      topics,
      sources,
    },
  });
}

export async function runBriefingDispatch(): Promise<BriefingDispatchResult> {
  const now = new Date();
  const twentyThreeHoursAgo = new Date(now.getTime() - 23 * 3_600_000);

  const due = await prisma.briefingPreference.findMany({
    where: {
      OR: [
        { lastDeliveredAt: null },
        { lastDeliveredAt: { lt: twentyThreeHoursAgo } },
      ],
    },
  });
  const dueForTime = due.filter((pref) => {
    const tz = pref.timezone || "UTC";
    const localNow = new Date(now.toLocaleString("en-US", { timeZone: tz }));
    const hhmm = `${String(localNow.getHours()).padStart(2, "0")}:${String(
      localNow.getMinutes()
    ).padStart(2, "0")}`;

    return hhmm === pref.deliveryTime;
  });

  let sent = 0;
  let failed = 0;

  for (const pref of dueForTime) {
    try {
      await generateBriefingForUser(pref.userId, pref.briefType);
      await prisma.briefingPreference.update({
        where: { userId: pref.userId },
        data: { lastDeliveredAt: now },
      });
      sent++;
    } catch (err: any) {
      logger.error(
        { err: err.message, userId: pref.userId },
        "Failed to generate scheduled briefing"
      );
      failed++;
    }
  }

  return { sent, failed };
}
