#!/usr/bin/env bash
set -euo pipefail

# Atlas Database Backup Script
# Usage: ./scripts/backup-db.sh [DATABASE_URL]
# Falls back to $DATABASE_URL env var if no argument provided.

DB_URL="${1:-${DATABASE_URL:-}}"
BACKUP_DIR="$(cd "$(dirname "$0")/.." && pwd)/backups"
RETENTION_DAYS=30
TIMESTAMP=$(date +"%Y-%m-%d-%H%M%S")
FILENAME="atlas-backup-${TIMESTAMP}.sql.gz"
FILEPATH="${BACKUP_DIR}/${FILENAME}"

if [[ -z "$DB_URL" ]]; then
  echo "ERROR: No DATABASE_URL provided. Pass as arg or set DATABASE_URL env var."
  exit 1
fi

mkdir -p "$BACKUP_DIR"

echo "[backup] Starting: ${TIMESTAMP}"
echo "[backup] Target: ${FILEPATH}"

# Run pg_dump with compression
if pg_dump "$DB_URL" --no-owner --no-privileges --clean --if-exists 2>/tmp/atlas-backup-err.log | gzip > "$FILEPATH"; then
  SIZE=$(du -h "$FILEPATH" | cut -f1)
  echo "[backup] Success: ${FILENAME} (${SIZE})"
else
  echo "[backup] FAILED — see /tmp/atlas-backup-err.log"
  cat /tmp/atlas-backup-err.log
  rm -f "$FILEPATH"
  exit 1
fi

# Verify file is non-empty
if [[ ! -s "$FILEPATH" ]]; then
  echo "[backup] ERROR: Backup file is empty"
  rm -f "$FILEPATH"
  exit 1
fi

# Retention: delete backups older than $RETENTION_DAYS days
DELETED=$(find "$BACKUP_DIR" -name "atlas-backup-*.sql.gz" -mtime "+${RETENTION_DAYS}" -print -delete | wc -l | tr -d ' ')
if [[ "$DELETED" -gt 0 ]]; then
  echo "[backup] Pruned ${DELETED} backup(s) older than ${RETENTION_DAYS} days"
fi

# Summary
TOTAL=$(find "$BACKUP_DIR" -name "atlas-backup-*.sql.gz" | wc -l | tr -d ' ')
TOTAL_SIZE=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)
echo "[backup] Total backups: ${TOTAL} (${TOTAL_SIZE})"
echo "[backup] Done."
