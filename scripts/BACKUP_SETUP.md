# Backup Setup

The current backup strategy is documented in [`/BACKUP.md`](../BACKUP.md).

This `scripts/` directory still contains the ad hoc backup helpers:

- `backup-db.sh` for local compressed dumps
- `backup-to-r2.ts` for manual dump-and-upload runs

The application-level backup scheduler and admin endpoints are now the primary path for daily backups and status reporting.
