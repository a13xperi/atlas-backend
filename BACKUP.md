# Atlas Database Backup Strategy

## Summary

Atlas now has two backup layers:

1. Supabase-hosted backups for the primary Postgres project.
2. Atlas-managed snapshots recorded in `BackupLog` and triggered from the API.

Atlas-managed snapshots run automatically once per day at `02:00 UTC` from the API scheduler and can also be triggered manually before major deploys.

## Trigger Paths

- Manual: `POST /api/admin/backup/trigger`
- Status: `GET /api/admin/backup/status`
- Automated: in-process scheduler check every 60 seconds; first run after `02:00 UTC` creates that day's scheduled snapshot if none exists yet

Both paths write a `BackupLog` row with:

- `id`
- `triggeredAt`
- `status`
- `size`
- `storageUrl`
- `provider`
- `triggerSource`
- `errorMessage`
- `completedAt`

## Storage Order

The backup service prefers the first available strategy below:

1. `SUPABASE_PROJECT_REF` + `SUPABASE_MANAGEMENT_API_TOKEN`
   Creates a Supabase restore point through the Management API.
2. `R2_*` credentials
   Creates a compressed logical dump and uploads it to Cloudflare R2.
3. Local filesystem fallback
   Creates a compressed logical dump in `BACKUP_LOCAL_DIR` (defaults to `./backups`).

### Current Recommendation

Use R2 or another durable object store in production. The local filesystem fallback is useful for development and emergency fallback, but it should not be treated as durable storage on Railway.

## Supabase Plan Notes

Supabase-hosted projects already receive automated backups at the platform level. Retention and restore tooling depend on plan/features, and restore-point creation via the Management API is only available to selected customers.

This repo does not currently contain enough environment configuration to confirm the Atlas project's exact Supabase plan from code alone, so the API is built to:

- use Management API restore points when those credentials are present
- otherwise create Atlas-managed logical backups and log them locally in `BackupLog`

## Environment Variables

Add the following for durable backups:

```bash
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_BUCKET=atlas-backups
R2_ACCESS_KEY_ID=<access-key>
R2_SECRET_ACCESS_KEY=<secret-key>
BACKUP_RETENTION_DAYS=30
BACKUP_LOCAL_DIR=backups
```

Optional Supabase restore-point support:

```bash
SUPABASE_PROJECT_REF=<project-ref>
SUPABASE_MANAGEMENT_API_TOKEN=<management-token>
```

## Restore

### If the snapshot provider is `SUPABASE_RESTORE_POINT`

Restore from the Supabase Dashboard or Management API using the restore point name recorded in `storageUrl`.

### If the snapshot provider is `R2_LOGICAL`

1. Download the `.sql.gz` object from the R2 bucket.
2. Restore it into the target database:

```bash
gunzip -c atlas-backup-2026-04-09T02-00-00.sql.gz | psql "$DATABASE_URL"
```

### If the snapshot provider is `LOCAL_LOGICAL`

Restore directly from the file path recorded in `storageUrl`:

```bash
gunzip -c backups/atlas-backup-2026-04-09T02-00-00.sql.gz | psql "$DATABASE_URL"
```

## Operating Notes

- Automated frequency: daily at `02:00 UTC`
- Manual backup policy: trigger a backup before major deploys, destructive migrations, or data repair work
- Retention: local and R2 logical backups are pruned after `BACKUP_RETENTION_DAYS`
- Health check: `GET /api/admin/backup/status` returns the latest logged snapshot and the active configuration
