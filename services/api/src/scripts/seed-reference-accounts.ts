/**
 * Atlas — Seed Global Reference Accounts
 *
 * Fetches real X profile images and upserts preset reference
 * accounts as global (userId: null, isGlobal: true).
 *
 * Run: npx tsx services/api/src/scripts/seed-reference-accounts.ts
 *
 * Idempotent: upserts by handle + isGlobal.
 * Graceful: if X API fails for one account, sets avatarUrl null and continues.
 */

import * as dotenv from "dotenv";
import { resolve } from "path";
// Load .env.local first (has Twitter creds), then .env as fallback
dotenv.config({ path: resolve(process.cwd(), ".env.local"), override: true });
dotenv.config();

import { PrismaClient } from "@prisma/client";
import { lookupUser } from "../lib/twitter";

const prisma = new PrismaClient();

const PRESET_ACCOUNTS = [
  { name: "Haseeb Qureshi", handle: "hosseeb" },
  { name: "Ignas", handle: "DefiIgnas" },
  { name: "Alex Good", handle: "goodalexander" },
  { name: "Dan Koe", handle: "thedankoe" },
  { name: "thiccyth0t", handle: "thiccyth0t" },
  { name: "ThinkingUSD", handle: "ThinkingUSD" },
  { name: "Jason Yanowitz", handle: "JasonYanowitz" },
  { name: "Balaji", handle: "balaboris" },
  { name: "Naval", handle: "naval" },
  { name: "Elon Musk", handle: "elonmusk" },
];

async function main() {
  console.log("Seeding global reference accounts\n");

  let created = 0;
  let updated = 0;

  for (const account of PRESET_ACCOUNTS) {
    let avatarUrl: string | null = null;
    let resolvedName = account.name;

    try {
      const user = await lookupUser(account.handle);
      avatarUrl = user.profile_image_url ?? null;
      resolvedName = user.name || account.name;
      console.log(`  [ok] @${account.handle} -> ${resolvedName} (avatar: ${avatarUrl ? "yes" : "no"})`);
    } catch (err: any) {
      console.log(`  [warn] @${account.handle} lookup failed: ${err.message} — continuing without avatar`);
    }

    // Upsert: find existing global ref by handle, or create
    const existing = await prisma.referenceVoice.findFirst({
      where: { handle: account.handle, isGlobal: true },
    });

    if (existing) {
      await prisma.referenceVoice.update({
        where: { id: existing.id },
        data: { name: resolvedName, avatarUrl, isActive: true },
      });
      updated++;
    } else {
      await prisma.referenceVoice.create({
        data: {
          name: resolvedName,
          handle: account.handle,
          avatarUrl,
          isGlobal: true,
          isActive: true,
          userId: null,
        },
      });
      created++;
    }
  }

  console.log(`\nDone: ${created} created, ${updated} updated (${PRESET_ACCOUNTS.length} total)`);
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
