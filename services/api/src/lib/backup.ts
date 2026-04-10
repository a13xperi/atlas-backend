import { spawn } from "child_process";
import { createReadStream, existsSync, mkdirSync } from "fs";
import { readdir, rm, stat, unlink } from "fs/promises";
import { resolve, join } from "path";
import { pathToFileURL } from "url";
import {
  BackupLog,
  BackupProvider,
  BackupStatus,
  BackupTriggerSource,
} from "@prisma/client";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { prisma } from "./prisma";
import { config } from "./config";
import { logger } from "./logger";
import { AppError } from "./errors";

export const DAILY_BACKUP_HOUR_UTC = 2;

export type BackupStrategy = "supabase-restore-point" | "r2-logical" | "local-logical";

type BackupExecutionDetails = {
  provider: BackupProvider;
  size: number | null;
  storageUrl: string;
};

type BackupRunOptions = {
  triggerSource: BackupTriggerSource;
};

type BackupConfigurationSummary = {
  preferredStrategy: BackupStrategy;
  supabaseRestorePointConfigured: boolean;
  r2Configured: boolean;
  localBackupDir: string;
  retentionDays: number;
};

let activeBackupPromise: Promise<BackupLog> | null = null;

export function getBackupConfigurationSummary(): BackupConfigurationSummary {
  const supabaseRestorePointConfigured = Boolean(
    config.SUPABASE_PROJECT_REF && config.SUPABASE_MANAGEMENT_API_TOKEN
  );
  const r2Configured = Boolean(
    config.R2_ENDPOINT &&
      config.R2_BUCKET &&
      config.R2_ACCESS_KEY_ID &&
      config.R2_SECRET_ACCESS_KEY
  );

  return {
    preferredStrategy: supabaseRestorePointConfigured
      ? "supabase-restore-point"
      : r2Configured
        ? "r2-logical"
        : "local-logical",
    supabaseRestorePointConfigured,
    r2Configured,
    localBackupDir: resolve(process.cwd(), config.BACKUP_LOCAL_DIR),
    retentionDays: config.BACKUP_RETENTION_DAYS,
  };
}

export function shouldRunScheduledBackup(
  now: Date,
  latestScheduledBackup: Pick<BackupLog, "triggeredAt"> | null
): boolean {
  if (now.getUTCHours() < DAILY_BACKUP_HOUR_UTC) {
    return false;
  }

  if (!latestScheduledBackup) {
    return true;
  }

  const last = latestScheduledBackup.triggeredAt;
  return (
    last.getUTCFullYear() !== now.getUTCFullYear() ||
    last.getUTCMonth() !== now.getUTCMonth() ||
    last.getUTCDate() !== now.getUTCDate()
  );
}

export async function getLatestBackupLog(): Promise<BackupLog | null> {
  return prisma.backupLog.findFirst({
    orderBy: { triggeredAt: "desc" },
  });
}

export async function getLatestScheduledBackupLog(): Promise<BackupLog | null> {
  return prisma.backupLog.findFirst({
    where: { triggerSource: BackupTriggerSource.SCHEDULED },
    orderBy: { triggeredAt: "desc" },
  });
}

export async function runScheduledBackupIfDue(now = new Date()): Promise<BackupLog | null> {
  const latestScheduledBackup = await getLatestScheduledBackupLog();
  if (!shouldRunScheduledBackup(now, latestScheduledBackup)) {
    return null;
  }

  return triggerBackup({ triggerSource: BackupTriggerSource.SCHEDULED });
}

export async function triggerBackup({ triggerSource }: BackupRunOptions): Promise<BackupLog> {
  if (activeBackupPromise) {
    throw AppError.conflict("Backup already in progress");
  }

  const pendingLog = await prisma.backupLog.create({
    data: {
      triggerSource,
      status: BackupStatus.PENDING,
    },
  });

  activeBackupPromise = (async () => {
    try {
      const result = await executeBackupWithFallback(pendingLog.id);
      const updatedLog = await prisma.backupLog.update({
        where: { id: pendingLog.id },
        data: {
          status: BackupStatus.SUCCESS,
          provider: result.provider,
          size: result.size,
          storageUrl: result.storageUrl,
          errorMessage: null,
          completedAt: new Date(),
        },
      });

      logger.info(
        {
          backupLogId: updatedLog.id,
          triggerSource: updatedLog.triggerSource,
          provider: updatedLog.provider,
          storageUrl: updatedLog.storageUrl,
          size: updatedLog.size,
        },
        "Database backup completed"
      );

      return updatedLog;
    } catch (err: any) {
      const message = err instanceof Error ? err.message : "Backup failed";
      const updatedLog = await prisma.backupLog.update({
        where: { id: pendingLog.id },
        data: {
          status: BackupStatus.FAILED,
          errorMessage: message,
          completedAt: new Date(),
        },
      });

      logger.error(
        {
          backupLogId: updatedLog.id,
          triggerSource: updatedLog.triggerSource,
          err: message,
        },
        "Database backup failed"
      );

      throw err;
    } finally {
      activeBackupPromise = null;
    }
  })();

  return activeBackupPromise;
}

export function serializeBackupLog(log: BackupLog | null) {
  if (!log) {
    return null;
  }

  return {
    id: log.id,
    triggeredAt: log.triggeredAt.toISOString(),
    status: log.status,
    triggerSource: log.triggerSource,
    provider: log.provider,
    size: log.size,
    storageUrl: log.storageUrl,
    errorMessage: log.errorMessage,
    completedAt: log.completedAt?.toISOString() ?? null,
  };
}

async function executeBackupWithFallback(backupLogId: string): Promise<BackupExecutionDetails> {
  const attempts = buildBackupAttemptOrder();
  let lastError: Error | null = null;

  for (const strategy of attempts) {
    try {
      logger.info({ backupLogId, strategy }, "Attempting database backup");
      const result = await executeBackupStrategy(strategy);
      return result;
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = err instanceof Error ? err : new Error(message);
      logger.warn({ backupLogId, strategy, err: message }, "Database backup attempt failed");
    }
  }

  throw lastError ?? new Error("No backup strategy was available");
}

function buildBackupAttemptOrder(): BackupStrategy[] {
  const configSummary = getBackupConfigurationSummary();
  const attempts: BackupStrategy[] = [];

  if (configSummary.supabaseRestorePointConfigured) {
    attempts.push("supabase-restore-point");
  }
  if (configSummary.r2Configured) {
    attempts.push("r2-logical");
  }

  attempts.push("local-logical");
  return attempts;
}

async function executeBackupStrategy(strategy: BackupStrategy): Promise<BackupExecutionDetails> {
  switch (strategy) {
    case "supabase-restore-point":
      return createSupabaseRestorePoint();
    case "r2-logical":
      return createLogicalBackup({ uploadToR2: true });
    case "local-logical":
      return createLogicalBackup({ uploadToR2: false });
  }
}

async function createSupabaseRestorePoint(): Promise<BackupExecutionDetails> {
  if (!config.SUPABASE_PROJECT_REF || !config.SUPABASE_MANAGEMENT_API_TOKEN) {
    throw new Error("Supabase restore-point credentials are not configured");
  }

  const restorePointName = buildBackupName();
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${config.SUPABASE_PROJECT_REF}/database/backups/restore-point`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.SUPABASE_MANAGEMENT_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: restorePointName }),
    }
  );

  if (!response.ok) {
    const details = await response.text();
    throw new Error(
      `Supabase restore point request failed with ${response.status}: ${details || response.statusText}`
    );
  }

  return {
    provider: BackupProvider.SUPABASE_RESTORE_POINT,
    size: null,
    storageUrl: `supabase://${config.SUPABASE_PROJECT_REF}/restore-points/${restorePointName}`,
  };
}

async function createLogicalBackup({
  uploadToR2,
}: {
  uploadToR2: boolean;
}): Promise<BackupExecutionDetails> {
  const backupName = buildBackupName();
  const localDir = resolve(process.cwd(), config.BACKUP_LOCAL_DIR);
  const localPath = join(localDir, `${backupName}.sql.gz`);

  if (!existsSync(localDir)) {
    mkdirSync(localDir, { recursive: true });
  }

  await runShellCommand(
    'pg_dump "$DATABASE_URL" --no-owner --no-privileges --clean --if-exists | gzip > "$BACKUP_OUTPUT_PATH"',
    {
      DATABASE_URL: config.DATABASE_URL,
      BACKUP_OUTPUT_PATH: localPath,
    }
  );

  const backupStats = await stat(localPath);
  if (backupStats.size === 0) {
    await unlink(localPath).catch(() => undefined);
    throw new Error("Backup file was empty");
  }

  let storageUrl = pathToFileURL(localPath).toString();
  let provider: BackupProvider = BackupProvider.LOCAL_LOGICAL;

  if (uploadToR2) {
    storageUrl = await uploadBackupToR2(localPath, `${backupName}.sql.gz`, backupStats.size);
    provider = BackupProvider.R2_LOGICAL;
    await unlink(localPath).catch(() => undefined);
  }

  await pruneLocalBackups(localDir, config.BACKUP_RETENTION_DAYS);
  if (uploadToR2) {
    await pruneR2Backups(config.BACKUP_RETENTION_DAYS);
  }

  return {
    provider,
    size: normalizeBackupSize(backupStats.size),
    storageUrl,
  };
}

function buildBackupName(now = new Date()): string {
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `atlas-backup-${timestamp}`;
}

function normalizeBackupSize(size: number): number {
  if (!Number.isSafeInteger(size) || size > 2_147_483_647) {
    throw new Error("Backup file is too large to persist in BackupLog.size");
  }
  return size;
}

async function uploadBackupToR2(
  localPath: string,
  fileName: string,
  size: number
): Promise<string> {
  if (
    !config.R2_ENDPOINT ||
    !config.R2_BUCKET ||
    !config.R2_ACCESS_KEY_ID ||
    !config.R2_SECRET_ACCESS_KEY
  ) {
    throw new Error("R2 backup storage is not configured");
  }

  const now = new Date();
  const objectKey = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${fileName}`;
  const client = new S3Client({
    region: "auto",
    endpoint: config.R2_ENDPOINT,
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY,
    },
  });

  await client.send(
    new PutObjectCommand({
      Bucket: config.R2_BUCKET,
      Key: objectKey,
      Body: createReadStream(localPath),
      ContentType: "application/gzip",
      ContentLength: size,
    })
  );

  return `r2://${config.R2_BUCKET}/${objectKey}`;
}

async function pruneR2Backups(retentionDays: number): Promise<void> {
  if (
    !config.R2_ENDPOINT ||
    !config.R2_BUCKET ||
    !config.R2_ACCESS_KEY_ID ||
    !config.R2_SECRET_ACCESS_KEY
  ) {
    return;
  }

  const client = new S3Client({
    region: "auto",
    endpoint: config.R2_ENDPOINT,
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY,
    },
  });

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const listed = await client.send(
    new ListObjectsV2Command({
      Bucket: config.R2_BUCKET,
      Prefix: "20",
    })
  );

  const deleteTargets = (listed.Contents || [])
    .filter((entry) => entry.Key && entry.LastModified && entry.LastModified < cutoff)
    .map((entry) => ({ Key: entry.Key! }));

  if (deleteTargets.length === 0) {
    return;
  }

  await client.send(
    new DeleteObjectsCommand({
      Bucket: config.R2_BUCKET,
      Delete: { Objects: deleteTargets },
    })
  );
}

async function pruneLocalBackups(directory: string, retentionDays: number): Promise<void> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);

  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.startsWith("atlas-backup-") && entry.name.endsWith(".sql.gz"))
      .map(async (entry) => {
        const filePath = join(directory, entry.name);
        const fileStats = await stat(filePath);
        if (fileStats.mtimeMs < cutoff) {
          await rm(filePath, { force: true });
        }
      })
  );
}

async function runShellCommand(command: string, extraEnv: Record<string, string>): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let stdout = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      rejectPromise(err);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      const output = stderr.trim() || stdout.trim();
      rejectPromise(new Error(output || `Shell command failed with exit code ${code}`));
    });
  });
}
