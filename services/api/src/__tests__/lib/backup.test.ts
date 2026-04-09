import { config } from "../../lib/config";
import {
  DAILY_BACKUP_HOUR_UTC,
  getBackupConfigurationSummary,
  shouldRunScheduledBackup,
} from "../../lib/backup";

describe("backup library", () => {
  const originalConfig = {
    SUPABASE_PROJECT_REF: config.SUPABASE_PROJECT_REF,
    SUPABASE_MANAGEMENT_API_TOKEN: config.SUPABASE_MANAGEMENT_API_TOKEN,
    R2_ENDPOINT: config.R2_ENDPOINT,
    R2_BUCKET: config.R2_BUCKET,
    R2_ACCESS_KEY_ID: config.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: config.R2_SECRET_ACCESS_KEY,
  };

  afterEach(() => {
    config.SUPABASE_PROJECT_REF = originalConfig.SUPABASE_PROJECT_REF;
    config.SUPABASE_MANAGEMENT_API_TOKEN = originalConfig.SUPABASE_MANAGEMENT_API_TOKEN;
    config.R2_ENDPOINT = originalConfig.R2_ENDPOINT;
    config.R2_BUCKET = originalConfig.R2_BUCKET;
    config.R2_ACCESS_KEY_ID = originalConfig.R2_ACCESS_KEY_ID;
    config.R2_SECRET_ACCESS_KEY = originalConfig.R2_SECRET_ACCESS_KEY;
  });

  it("prefers Supabase restore points when management credentials are configured", () => {
    config.SUPABASE_PROJECT_REF = "atlas-ref";
    config.SUPABASE_MANAGEMENT_API_TOKEN = "token";
    config.R2_ENDPOINT = "https://example.r2.cloudflarestorage.com";
    config.R2_BUCKET = "atlas-backups";
    config.R2_ACCESS_KEY_ID = "key";
    config.R2_SECRET_ACCESS_KEY = "secret";

    expect(getBackupConfigurationSummary().preferredStrategy).toBe("supabase-restore-point");
  });

  it("falls back to R2 logical backups when Supabase restore points are unavailable", () => {
    config.SUPABASE_PROJECT_REF = undefined;
    config.SUPABASE_MANAGEMENT_API_TOKEN = undefined;
    config.R2_ENDPOINT = "https://example.r2.cloudflarestorage.com";
    config.R2_BUCKET = "atlas-backups";
    config.R2_ACCESS_KEY_ID = "key";
    config.R2_SECRET_ACCESS_KEY = "secret";

    expect(getBackupConfigurationSummary().preferredStrategy).toBe("r2-logical");
  });

  it("uses local logical backups when no remote backup credentials are configured", () => {
    config.SUPABASE_PROJECT_REF = undefined;
    config.SUPABASE_MANAGEMENT_API_TOKEN = undefined;
    config.R2_ENDPOINT = undefined;
    config.R2_BUCKET = undefined;
    config.R2_ACCESS_KEY_ID = undefined;
    config.R2_SECRET_ACCESS_KEY = undefined;

    expect(getBackupConfigurationSummary().preferredStrategy).toBe("local-logical");
  });

  it("does not run the scheduled backup before the target UTC hour", () => {
    const now = new Date("2026-04-09T01:59:00.000Z");
    expect(shouldRunScheduledBackup(now, null)).toBe(false);
  });

  it("runs the scheduled backup after the target UTC hour when none ran today", () => {
    const now = new Date(`2026-04-09T${String(DAILY_BACKUP_HOUR_UTC).padStart(2, "0")}:05:00.000Z`);
    expect(shouldRunScheduledBackup(now, null)).toBe(true);
  });

  it("skips the scheduled backup when one has already been recorded today", () => {
    const now = new Date(`2026-04-09T${String(DAILY_BACKUP_HOUR_UTC).padStart(2, "0")}:30:00.000Z`);
    expect(
      shouldRunScheduledBackup(now, {
        triggeredAt: new Date("2026-04-09T02:01:00.000Z"),
      })
    ).toBe(false);
  });
});
