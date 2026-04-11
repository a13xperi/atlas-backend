/**
 * rotate-x-tokens — backfill script for C-3 XOAuth token encryption.
 *
 * Advisor directive: "If backfill runs dirty in prod before demo, every
 *  linked X account breaks mid-demo. SHIP CODE, NOT DATA."
 *
 * This script is GATED. By default it does a dry-run (counts rows that
 * would be affected, then exits 0). It refuses to perform any writes
 * unless BOTH of the following are true:
 *
 *   1. TOKEN_ENCRYPTION_KEY is set and valid (encryptionEnabled() === true)
 *   2. RUN_ROTATE_X_TOKENS=1 is in the environment
 *
 * If either gate fails, no writes happen. The script can also be run in
 * `--verify` mode, which iterates rows that already have encrypted
 * columns populated and attempts to decrypt each — useful for
 * post-rotation smoke testing without any DB mutation.
 *
 * Usage:
 *   # dry-run (safe, counts rows only)
 *   npx ts-node services/api/src/scripts/rotate-x-tokens.ts
 *
 *   # actual rotation (after TOKEN_ENCRYPTION_KEY is live in Railway)
 *   RUN_ROTATE_X_TOKENS=1 npx ts-node services/api/src/scripts/rotate-x-tokens.ts
 *
 *   # post-rotation verification (read-only)
 *   npx ts-node services/api/src/scripts/rotate-x-tokens.ts --verify
 */

import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import {
  decryptToken,
  encryptToken,
  encryptionEnabled,
  isEncrypted,
} from "../lib/crypto";

const BATCH_SIZE = 100;

interface RotationStats {
  processed: number;
  encrypted: number;
  skipped: number;
  failed: number;
}

async function countCandidates(): Promise<number> {
  return prisma.user.count({
    where: {
      OR: [
        { AND: [{ xAccessToken: { not: null } }, { xAccessTokenEnc: null }] },
        { AND: [{ xRefreshToken: { not: null } }, { xRefreshTokenEnc: null }] },
      ],
    },
  });
}

async function rotateBatch(
  afterId: string | null,
): Promise<{ stats: RotationStats; lastId: string | null }> {
  const stats: RotationStats = { processed: 0, encrypted: 0, skipped: 0, failed: 0 };

  const users = await prisma.user.findMany({
    where: {
      OR: [
        { AND: [{ xAccessToken: { not: null } }, { xAccessTokenEnc: null }] },
        { AND: [{ xRefreshToken: { not: null } }, { xRefreshTokenEnc: null }] },
      ],
    },
    select: {
      id: true,
      xAccessToken: true,
      xRefreshToken: true,
      xAccessTokenEnc: true,
      xRefreshTokenEnc: true,
    },
    orderBy: { id: "asc" },
    ...(afterId ? { cursor: { id: afterId }, skip: 1 } : {}),
    take: BATCH_SIZE,
  });

  let lastId: string | null = null;

  for (const user of users) {
    stats.processed++;
    lastId = user.id;

    // Idempotent: if both plaintext fields are already null OR both enc
    // fields are populated, skip.
    const needsAccess = !!user.xAccessToken && !user.xAccessTokenEnc;
    const needsRefresh = !!user.xRefreshToken && !user.xRefreshTokenEnc;
    if (!needsAccess && !needsRefresh) {
      stats.skipped++;
      continue;
    }

    try {
      const data: {
        xAccessToken?: null;
        xRefreshToken?: null;
        xAccessTokenEnc?: string;
        xRefreshTokenEnc?: string;
      } = {};

      if (needsAccess && user.xAccessToken) {
        data.xAccessTokenEnc = encryptToken(user.xAccessToken);
        data.xAccessToken = null;
      }
      if (needsRefresh && user.xRefreshToken) {
        data.xRefreshTokenEnc = encryptToken(user.xRefreshToken);
        data.xRefreshToken = null;
      }

      await prisma.user.update({ where: { id: user.id }, data });
      stats.encrypted++;
    } catch (err: any) {
      logger.error(
        { err: err.message, userId: user.id },
        "rotate-x-tokens: failed to rotate user",
      );
      stats.failed++;
    }
  }

  return { stats, lastId };
}

async function runRotation(): Promise<void> {
  logger.info("rotate-x-tokens: starting rotation pass");

  const total: RotationStats = { processed: 0, encrypted: 0, skipped: 0, failed: 0 };
  let afterId: string | null = null;
  let batchIndex = 0;

  while (true) {
    const { stats, lastId } = await rotateBatch(afterId);
    if (stats.processed === 0) break;

    total.processed += stats.processed;
    total.encrypted += stats.encrypted;
    total.skipped += stats.skipped;
    total.failed += stats.failed;
    batchIndex++;

    logger.info(
      {
        batch: batchIndex,
        batchStats: stats,
        totals: { ...total },
      },
      "rotate-x-tokens: batch complete",
    );

    if (stats.processed < BATCH_SIZE) break;
    afterId = lastId;
  }

  // eslint-disable-next-line no-console
  console.log("rotate-x-tokens: rotation complete", total);
  logger.info({ totals: total }, "rotate-x-tokens: rotation complete");
}

async function runVerify(): Promise<number> {
  logger.info("rotate-x-tokens: --verify mode, read-only");

  let checked = 0;
  let failed = 0;
  let afterId: string | null = null;

  while (true) {
    const batch: Array<{
      id: string;
      xAccessTokenEnc: string | null;
      xRefreshTokenEnc: string | null;
    }> = await prisma.user.findMany({
      where: {
        OR: [
          { xAccessTokenEnc: { not: null } },
          { xRefreshTokenEnc: { not: null } },
        ],
      },
      select: {
        id: true,
        xAccessTokenEnc: true,
        xRefreshTokenEnc: true,
      },
      orderBy: { id: "asc" },
      ...(afterId ? { cursor: { id: afterId }, skip: 1 } : {}),
      take: BATCH_SIZE,
    });

    if (batch.length === 0) break;

    for (const row of batch) {
      checked++;
      if (row.xAccessTokenEnc && isEncrypted(row.xAccessTokenEnc)) {
        try {
          decryptToken(row.xAccessTokenEnc);
        } catch (err: any) {
          failed++;
          logger.error(
            { err: err.message, userId: row.id, column: "xAccessTokenEnc" },
            "rotate-x-tokens: verify decrypt failed",
          );
        }
      }
      if (row.xRefreshTokenEnc && isEncrypted(row.xRefreshTokenEnc)) {
        try {
          decryptToken(row.xRefreshTokenEnc);
        } catch (err: any) {
          failed++;
          logger.error(
            { err: err.message, userId: row.id, column: "xRefreshTokenEnc" },
            "rotate-x-tokens: verify decrypt failed",
          );
        }
      }
    }

    afterId = batch[batch.length - 1]!.id;
    if (batch.length < BATCH_SIZE) break;
  }

  // eslint-disable-next-line no-console
  console.log("rotate-x-tokens: verify complete", { checked, failed });
  logger.info({ checked, failed }, "rotate-x-tokens: verify complete");
  return failed;
}

async function main(): Promise<number> {
  const verify = process.argv.includes("--verify");

  if (verify) {
    const failed = await runVerify();
    return failed > 0 ? 2 : 0;
  }

  // Dry-run gate: show what would happen without writing.
  const gateEnabled = process.env.RUN_ROTATE_X_TOKENS === "1";
  if (!gateEnabled) {
    const candidates = await countCandidates();
    // eslint-disable-next-line no-console
    console.log(
      "rotate-x-tokens: DRY RUN (RUN_ROTATE_X_TOKENS!=1) —",
      candidates,
      "row(s) would be rotated",
    );
    // eslint-disable-next-line no-console
    console.log(
      "rotate-x-tokens: to actually rotate, run with RUN_ROTATE_X_TOKENS=1 and TOKEN_ENCRYPTION_KEY set",
    );
    logger.info({ candidates }, "rotate-x-tokens: dry run — no writes");
    return 0;
  }

  // Write gate: key must be live. No point rotating without it.
  if (!encryptionEnabled()) {
    logger.error(
      "rotate-x-tokens: TOKEN_ENCRYPTION_KEY is not set or invalid — aborting",
    );
    // eslint-disable-next-line no-console
    console.error(
      "rotate-x-tokens: ABORT — TOKEN_ENCRYPTION_KEY must be a valid 32-byte key (hex or base64) before rotation",
    );
    return 1;
  }

  await runRotation();
  return 0;
}

if (require.main === module) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((err) => {
      logger.error(
        { err: err.message, stack: err.stack },
        "rotate-x-tokens: uncaught failure",
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
