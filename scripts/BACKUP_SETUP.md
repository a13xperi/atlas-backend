# Atlas Database Backups — Cloudflare R2 Setup

## Architecture
- **Schedule:** Daily at 03:00 UTC via Railway Cron Service
- **Storage:** Cloudflare R2 (S3-compatible, free egress)
- **Retention:** 30 days (automatic pruning)
- **Script:** `npm run db:backup:r2` (runs `scripts/backup-to-r2.ts`)

## Step 1: Create R2 Bucket

1. Go to Cloudflare Dashboard → R2 Object Storage
2. Create bucket: `atlas-backups`
3. Settings: no public access needed

## Step 2: Create R2 API Token

1. R2 → Manage R2 API Tokens → Create API Token
2. Permissions: Object Read & Write
3. Scope: Bucket `atlas-backups` only
4. Save the Access Key ID and Secret Access Key
5. Note your Account ID from the R2 dashboard URL

## Step 3: Add Railway Cron Service

In the Railway dashboard for the atlas-backend project:

1. New → Cron Service
2. Connect the same GitHub repo (a13xperi/atlas-backend)
3. Branch: main
4. Schedule: `0 3 * * *` (daily at 03:00 UTC)
5. Start command: `npx tsx scripts/backup-to-r2.ts`

### Environment Variables

Set these in the cron service (not the main API service):

```
DATABASE_URL=<same as API service>
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_BUCKET=atlas-backups
R2_ACCESS_KEY_ID=<from step 2>
R2_SECRET_ACCESS_KEY=<from step 2>
BACKUP_RETENTION_DAYS=30
```

## Step 4: Verify

After the first run:
- Check Railway logs for `[backup] Upload success`
- Check R2 bucket for `2026/04/atlas-backup-*.sql.gz`

## Manual Backup

```bash
npm run db:backup       # local dump only
npm run db:backup:r2    # dump + R2 upload (needs env vars)
```

## Restore

```bash
gunzip -c atlas-backup-2026-04-03.sql.gz | psql $DATABASE_URL
```

## Cost
~$0.002/month at current scale (5MB daily × 30 days = 150MB @ $0.015/GB).
