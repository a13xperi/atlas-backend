/**
 * Atlas Database Backup → Cloudflare R2
 *
 * Runs pg_dump, compresses, uploads to R2, prunes old backups.
 * Designed to run as a Railway cron service or locally via:
 *   npx tsx scripts/backup-to-r2.ts
 *
 * Required env vars:
 *   DATABASE_URL          — Postgres connection string
 *   R2_ENDPOINT           — https://<account-id>.r2.cloudflarestorage.com
 *   R2_BUCKET             — e.g. atlas-backups
 *   R2_ACCESS_KEY_ID      — R2 API token access key
 *   R2_SECRET_ACCESS_KEY  — R2 API token secret key
 *
 * Optional:
 *   BACKUP_RETENTION_DAYS — days to keep backups (default: 30)
 */

import { execSync } from "child_process";
import { createReadStream, statSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

const required = (name: string): string => {
  const val = process.env[name];
  if (!val) {
    console.error(`[backup] ERROR: Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
};

async function main() {
  const DATABASE_URL = required("DATABASE_URL");
  const R2_ENDPOINT = required("R2_ENDPOINT");
  const R2_BUCKET = required("R2_BUCKET");
  const R2_ACCESS_KEY_ID = required("R2_ACCESS_KEY_ID");
  const R2_SECRET_ACCESS_KEY = required("R2_SECRET_ACCESS_KEY");
  const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || "30", 10);

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const datePrefix = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const filename = `atlas-backup-${timestamp}.sql.gz`;
  const s3Key = `${datePrefix}/${filename}`;
  const tmpDir = "/tmp/atlas-backups";
  const localPath = join(tmpDir, filename);

  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  // Step 1: pg_dump → gzip
  console.log(`[backup] Starting: ${timestamp}`);
  try {
    execSync(
      `pg_dump "${DATABASE_URL}" --no-owner --no-privileges --clean --if-exists | gzip > "${localPath}"`,
      { stdio: ["pipe", "pipe", "pipe"], timeout: 300_000 }
    );
  } catch (err: any) {
    console.error(`[backup] pg_dump failed: ${err.stderr?.toString() || err.message}`);
    process.exit(1);
  }

  const stat = statSync(localPath);
  if (stat.size === 0) {
    console.error("[backup] ERROR: Backup file is empty");
    unlinkSync(localPath);
    process.exit(1);
  }
  console.log(`[backup] Dump complete: ${filename} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);

  // Step 2: Upload to R2
  const s3 = new S3Client({
    region: "auto",
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });

  console.log(`[backup] Uploading to R2: ${s3Key}`);
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: s3Key,
        Body: createReadStream(localPath),
        ContentType: "application/gzip",
        ContentLength: stat.size,
      })
    );
    console.log(`[backup] Upload success: ${s3Key}`);
  } catch (err: any) {
    console.error(`[backup] Upload failed: ${err.message}`);
  }

  // Step 3: Clean up local file
  try {
    unlinkSync(localPath);
  } catch {}

  // Step 4: Prune old R2 objects
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  console.log(`[backup] Pruning R2 objects older than ${cutoff.toISOString().slice(0, 10)}`);

  try {
    const listed = await s3.send(
      new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: "20" })
    );

    const toDelete = (listed.Contents || []).filter(
      (obj) => obj.LastModified && obj.LastModified < cutoff && obj.Key
    );

    if (toDelete.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: R2_BUCKET,
          Delete: { Objects: toDelete.map((obj) => ({ Key: obj.Key! })) },
        })
      );
      console.log(`[backup] Pruned ${toDelete.length} old backup(s) from R2`);
    } else {
      console.log("[backup] No old backups to prune");
    }
  } catch (err: any) {
    console.error(`[backup] Pruning failed: ${err.message}`);
  }

  console.log("[backup] Done.");
}

main().catch((err) => {
  console.error(`[backup] Fatal: ${err.message}`);
  process.exit(1);
});
