/**
 * C-3 rotation backfill — encrypt existing plaintext XOAuth tokens.
 *
 * Pairs with services/api/src/lib/crypto.ts. The crypto helper ships the
 * dual-column read/write path so encrypted reads are live BEFORE this
 * script runs; this is the one-shot rotation that moves any leftover
 * plaintext rows over to the encrypted columns.
 *
 * Behaviour:
 *   - Scans every User row that still has a non-null `xAccessToken` or
 *     `xRefreshToken`.
 *   - For each row: encrypts the plaintext (via encryptToken) and writes
 *     the ciphertext to the matching `*Enc` column. Plaintext columns are
 *     cleared once their encrypted twin is populated.
 *   - Idempotent: rows where the `*Enc` column is already populated are
 *     left alone — only the unmigrated half is touched. Re-running the
 *     script after a partial pass is safe.
 *   - Dry-run by default. Pass `--apply` to actually write.
 *
 * Required env:
 *   - DATABASE_URL          (Prisma)
 *   - TOKEN_ENCRYPTION_KEY  (32-byte hex or base64; same key the runtime uses)
 *
 * Run:
 *   npx tsx services/api/src/scripts/encrypt-xoauth-tokens.ts          # dry-run
 *   npx tsx services/api/src/scripts/encrypt-xoauth-tokens.ts --apply  # write
 *
 * Or via package script:
 *   npm run db:encrypt-xoauth -- --apply
 */

import * as dotenv from "dotenv";
dotenv.config();

import { PrismaClient } from "@prisma/client";
import { encryptToken, encryptionEnabled } from "../lib/crypto";

export interface BackfillUserRow {
  id: string;
  xAccessToken: string | null;
  xRefreshToken: string | null;
  xAccessTokenEnc: string | null;
  xRefreshTokenEnc: string | null;
}

export interface BackfillStats {
  scanned: number;
  /** Rows where at least one column was actually encrypted (or would be in dry-run). */
  migrated: number;
  /** Plaintext access tokens encrypted into xAccessTokenEnc. */
  accessEncrypted: number;
  /** Plaintext refresh tokens encrypted into xRefreshTokenEnc. */
  refreshEncrypted: number;
  /** Rows the script chose not to touch because both halves were already migrated. */
  skipped: number;
  /** Rows the script chose not to touch because they had no plaintext to migrate. */
  empty: number;
}

interface UserUpdate {
  xAccessToken?: null;
  xRefreshToken?: null;
  xAccessTokenEnc?: string;
  xRefreshTokenEnc?: string;
}

/**
 * Pure planner — given a row, decide what should change.
 * Extracted so the unit test can verify the decision matrix without
 * spinning up a Prisma client.
 */
export function planRowMigration(row: BackfillUserRow): UserUpdate | null {
  const update: UserUpdate = {};

  // Access token: encrypt-if-plaintext-only.
  if (row.xAccessToken && !row.xAccessTokenEnc) {
    update.xAccessTokenEnc = encryptToken(row.xAccessToken);
    update.xAccessToken = null;
  }

  // Refresh token: encrypt-if-plaintext-only.
  if (row.xRefreshToken && !row.xRefreshTokenEnc) {
    update.xRefreshTokenEnc = encryptToken(row.xRefreshToken);
    update.xRefreshToken = null;
  }

  return Object.keys(update).length > 0 ? update : null;
}

/**
 * Run the backfill against a Prisma client. Returns stats.
 *
 * Exported so the unit test can drive this with a mock client and the
 * runtime entrypoint at the bottom of the file just wraps it.
 */
export async function runBackfill(
  prisma: Pick<PrismaClient, "user">,
  options: { apply: boolean; logger?: (msg: string) => void } = { apply: false },
): Promise<BackfillStats> {
  const log = options.logger ?? (() => {});

  const stats: BackfillStats = {
    scanned: 0,
    migrated: 0,
    accessEncrypted: 0,
    refreshEncrypted: 0,
    skipped: 0,
    empty: 0,
  };

  // Pull only rows that still have plaintext on at least one side.
  // Rows already fully migrated (both Enc populated, both plaintext null)
  // never enter the candidate set.
  const candidates = (await prisma.user.findMany({
    where: {
      OR: [
        { xAccessToken: { not: null } },
        { xRefreshToken: { not: null } },
      ],
    },
    select: {
      id: true,
      xAccessToken: true,
      xRefreshToken: true,
      xAccessTokenEnc: true,
      xRefreshTokenEnc: true,
    },
  })) as BackfillUserRow[];

  stats.scanned = candidates.length;
  log(`Scanned ${stats.scanned} candidate user(s) with plaintext XOAuth columns.`);

  for (const row of candidates) {
    const update = planRowMigration(row);

    if (!update) {
      // Row needs no patch. Two reasons we land here:
      //   - Both halves are already encrypted (Enc populated, plaintext gone) → skipped
      //   - Both halves are fully empty (no plaintext, no Enc) → empty (defensive;
      //     the findMany filter normally excludes these, but a mock or a row
      //     in inconsistent state might still be returned)
      const hasAnyEnc = !!(row.xAccessTokenEnc || row.xRefreshTokenEnc);
      if (hasAnyEnc) {
        stats.skipped += 1;
      } else {
        stats.empty += 1;
      }
      continue;
    }

    if (update.xAccessTokenEnc !== undefined) stats.accessEncrypted += 1;
    if (update.xRefreshTokenEnc !== undefined) stats.refreshEncrypted += 1;
    stats.migrated += 1;

    if (options.apply) {
      await prisma.user.update({ where: { id: row.id }, data: update });
    }
  }

  return stats;
}

async function main() {
  const apply = process.argv.includes("--apply");

  if (!encryptionEnabled()) {
    console.error(
      "❌ TOKEN_ENCRYPTION_KEY is not set or invalid. Refusing to run — there is no key to encrypt to.",
    );
    process.exit(1);
  }

  console.log(
    `🔐 XOAuth token rotation backfill — ${apply ? "APPLY" : "DRY-RUN"} mode\n`,
  );

  const prisma = new PrismaClient();
  try {
    const stats = await runBackfill(prisma, {
      apply,
      logger: (msg) => console.log(`   ${msg}`),
    });

    console.log("");
    console.log("─── Results ───────────────────────────────");
    console.log(`Scanned candidates    : ${stats.scanned}`);
    console.log(`Rows migrated         : ${stats.migrated}${apply ? "" : " (would migrate)"}`);
    console.log(`  · access tokens     : ${stats.accessEncrypted}`);
    console.log(`  · refresh tokens    : ${stats.refreshEncrypted}`);
    console.log(`Already encrypted     : ${stats.skipped}`);
    console.log(`Empty plaintext       : ${stats.empty}`);
    console.log("───────────────────────────────────────────");

    if (!apply && stats.migrated > 0) {
      console.log(
        "\nRe-run with `--apply` to write the changes. Make sure DATABASE_URL points at the right environment.",
      );
    } else if (apply) {
      console.log("\n✅ Backfill complete.");
    } else {
      console.log("\nNothing to migrate. ✨");
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Only execute when run directly (allows the unit test to import without
// triggering a real Prisma connection).
if (require.main === module) {
  main().catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
}
