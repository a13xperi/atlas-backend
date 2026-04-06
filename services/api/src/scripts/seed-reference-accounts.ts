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
  { name: "Ansem", handle: "blknoiz06", category: "Crypto/VC" },
  { name: "Balaji", handle: "balajis", category: "Macro" },
  { name: "Cobie", handle: "cobie", category: "Crypto/VC" },
  { name: "Dan Koe", handle: "thedankoe", category: "Philosophy" },
  { name: "DegenSpartan", handle: "DegenSpartan", category: "DeFi" },
  { name: "Elon Musk", handle: "elonmusk", category: "Macro" },
  { name: "ThinkingUSD", handle: "ThinkingUSD", category: "Macro" },
  { name: "Alex Good", handle: "goodalexander", category: "Macro" },
  { name: "Haseeb Qureshi", handle: "hosseeb", category: "Crypto/VC" },
  { name: "Hasu", handle: "hasufl", category: "DeFi" },
  { name: "Hsaka", handle: "HsakaTrades", category: "Crypto/VC" },
  { name: "Ignas", handle: "DefiIgnas", category: "DeFi" },
  { name: "Mando", handle: "napgener", category: "Crypto/VC" },
  { name: "Naval", handle: "naval", category: "Philosophy" },
  { name: "thiccyth0t", handle: "thiccyth0t", category: "Crypto/VC" },
  { name: "Jason Yanowitz", handle: "JasonYanowitz", category: "Crypto/VC" },
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
        data: { name: resolvedName, avatarUrl, category: account.category, isActive: true },
      });
      updated++;
    } else {
      await prisma.referenceVoice.create({
        data: {
          name: resolvedName,
          handle: account.handle,
          avatarUrl,
          category: account.category,
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
