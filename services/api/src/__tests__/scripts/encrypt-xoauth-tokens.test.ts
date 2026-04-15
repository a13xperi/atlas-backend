jest.mock("../../lib/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

import crypto from "node:crypto";
import {
  __resetKeyCacheForTests,
  decryptToken,
  isEncrypted,
} from "../../lib/crypto";
import {
  BackfillUserRow,
  planRowMigration,
  runBackfill,
} from "../../scripts/encrypt-xoauth-tokens";

const ORIGINAL_KEY = process.env.TOKEN_ENCRYPTION_KEY;

function setKey(key: string | undefined): void {
  if (key === undefined) {
    delete process.env.TOKEN_ENCRYPTION_KEY;
  } else {
    process.env.TOKEN_ENCRYPTION_KEY = key;
  }
  __resetKeyCacheForTests();
}

describe("encrypt-xoauth-tokens backfill", () => {
  beforeEach(() => {
    setKey(crypto.randomBytes(32).toString("hex"));
  });

  afterAll(() => {
    setKey(ORIGINAL_KEY);
  });

  describe("planRowMigration (pure decision matrix)", () => {
    it("encrypts both columns when only plaintext is set", () => {
      const row: BackfillUserRow = {
        id: "u1",
        xAccessToken: "access-plain",
        xRefreshToken: "refresh-plain",
        xAccessTokenEnc: null,
        xRefreshTokenEnc: null,
      };

      const update = planRowMigration(row);

      expect(update).not.toBeNull();
      expect(update!.xAccessToken).toBeNull();
      expect(update!.xRefreshToken).toBeNull();
      expect(isEncrypted(update!.xAccessTokenEnc!)).toBe(true);
      expect(isEncrypted(update!.xRefreshTokenEnc!)).toBe(true);
      expect(decryptToken(update!.xAccessTokenEnc!)).toBe("access-plain");
      expect(decryptToken(update!.xRefreshTokenEnc!)).toBe("refresh-plain");
    });

    it("only encrypts the plaintext half when the other side is already encrypted", () => {
      const row: BackfillUserRow = {
        id: "u2",
        xAccessToken: "still-plain",
        xRefreshToken: null,
        xAccessTokenEnc: null,
        xRefreshTokenEnc: "v1:already:encrypted:value",
      };

      const update = planRowMigration(row);

      expect(update).not.toBeNull();
      expect(update!.xAccessTokenEnc).toBeDefined();
      expect(update!.xAccessToken).toBeNull();
      // Refresh side untouched — both fields absent from the patch
      expect(update).not.toHaveProperty("xRefreshTokenEnc");
      expect(update).not.toHaveProperty("xRefreshToken");
    });

    it("returns null for rows that are already fully migrated", () => {
      const row: BackfillUserRow = {
        id: "u3",
        xAccessToken: null,
        xRefreshToken: null,
        xAccessTokenEnc: "v1:done:done:done",
        xRefreshTokenEnc: "v1:done:done:done",
      };

      expect(planRowMigration(row)).toBeNull();
    });

    it("returns null for rows that have no plaintext and no encrypted token at all", () => {
      const row: BackfillUserRow = {
        id: "u4",
        xAccessToken: null,
        xRefreshToken: null,
        xAccessTokenEnc: null,
        xRefreshTokenEnc: null,
      };

      expect(planRowMigration(row)).toBeNull();
    });
  });

  describe("runBackfill (with mock Prisma)", () => {
    function buildMockPrisma(rows: BackfillUserRow[]) {
      const updates: { id: string; data: any }[] = [];
      const prisma = {
        user: {
          findMany: jest.fn().mockResolvedValue(rows),
          update: jest
            .fn()
            .mockImplementation(({ where, data }: { where: { id: string }; data: any }) => {
              updates.push({ id: where.id, data });
              return Promise.resolve();
            }),
        },
      };
      return { prisma, updates };
    }

    it("dry-run does not call prisma.user.update", async () => {
      const { prisma, updates } = buildMockPrisma([
        {
          id: "a",
          xAccessToken: "plain-a",
          xRefreshToken: "plain-r",
          xAccessTokenEnc: null,
          xRefreshTokenEnc: null,
        },
      ]);

      const stats = await runBackfill(prisma as any, { apply: false });

      expect(updates).toHaveLength(0);
      expect(stats.scanned).toBe(1);
      expect(stats.migrated).toBe(1);
      expect(stats.accessEncrypted).toBe(1);
      expect(stats.refreshEncrypted).toBe(1);
    });

    it("apply mode writes encrypted columns and reports correct counts across mixed rows", async () => {
      const rows: BackfillUserRow[] = [
        // Row 1: full plaintext both sides → migrate both
        {
          id: "full-plain",
          xAccessToken: "access-1",
          xRefreshToken: "refresh-1",
          xAccessTokenEnc: null,
          xRefreshTokenEnc: null,
        },
        // Row 2: plaintext access only, refresh already encrypted → migrate access only
        {
          id: "half-migrated",
          xAccessToken: "access-2",
          xRefreshToken: null,
          xAccessTokenEnc: null,
          xRefreshTokenEnc: "v1:iv:tag:ct",
        },
        // Row 3: would never be returned by findMany in real life because the
        // OR filter excludes it, but defend in depth — script must classify
        // it as already migrated and skip.
        {
          id: "fully-migrated",
          xAccessToken: null,
          xRefreshToken: null,
          xAccessTokenEnc: "v1:iv:tag:ct",
          xRefreshTokenEnc: "v1:iv:tag:ct",
        },
      ];

      const { prisma, updates } = buildMockPrisma(rows);
      const stats = await runBackfill(prisma as any, { apply: true });

      expect(stats.scanned).toBe(3);
      expect(stats.migrated).toBe(2);
      expect(stats.accessEncrypted).toBe(2);
      expect(stats.refreshEncrypted).toBe(1);
      expect(stats.skipped).toBe(1);

      // Two writes — full-plain + half-migrated
      expect(updates).toHaveLength(2);
      const fullPlainUpdate = updates.find((u) => u.id === "full-plain")!;
      expect(fullPlainUpdate.data.xAccessToken).toBeNull();
      expect(fullPlainUpdate.data.xRefreshToken).toBeNull();
      expect(isEncrypted(fullPlainUpdate.data.xAccessTokenEnc)).toBe(true);
      expect(isEncrypted(fullPlainUpdate.data.xRefreshTokenEnc)).toBe(true);

      const halfUpdate = updates.find((u) => u.id === "half-migrated")!;
      expect(halfUpdate.data.xAccessToken).toBeNull();
      expect(isEncrypted(halfUpdate.data.xAccessTokenEnc)).toBe(true);
      // Refresh side must NOT be re-encrypted
      expect(halfUpdate.data).not.toHaveProperty("xRefreshTokenEnc");
      expect(halfUpdate.data).not.toHaveProperty("xRefreshToken");
    });

    it("is idempotent — re-running on already-migrated rows is a no-op", async () => {
      const rows: BackfillUserRow[] = [
        {
          id: "done",
          xAccessToken: null,
          xRefreshToken: null,
          xAccessTokenEnc: "v1:iv:tag:ct",
          xRefreshTokenEnc: "v1:iv:tag:ct",
        },
      ];

      const { prisma, updates } = buildMockPrisma(rows);
      const stats = await runBackfill(prisma as any, { apply: true });

      expect(updates).toHaveLength(0);
      expect(stats.migrated).toBe(0);
      expect(stats.skipped).toBe(1);
    });
  });
});
