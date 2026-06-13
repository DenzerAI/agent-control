#!/bin/bash
# Agent Control Backup — sichert den gesamten ~/agent Ordner inkl. .env
# Lokal nach ~/Backups/agent/ (chmod 700), 3er Rotation.

set -euo pipefail

SOURCE="$HOME/agent"
BACKUP_DIR="$HOME/Backups/agent"
DATE=$(date +%Y-%m-%d_%H%M)
ARCHIVE="$BACKUP_DIR/agent-$DATE.tar.gz"
START_TS=$(date +%Y-%m-%dT%H:%M:%S)
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
JOB_NAME="backup"
JOB_DIR="$HOME/agent/jobs/$JOB_NAME"
DATA_DIR="$JOB_DIR/data"
RUNS_LOG="$HOME/agent/jobs/_runs.log"
TODAY=$(date +%Y-%m-%d)
RESULT_OUT="$DATA_DIR/$TODAY-$JOB_NAME.md"
META_OUT="$DATA_DIR/$TODAY-$JOB_NAME.meta.json"
START_EPOCH=$(date +%s)

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
mkdir -p "$DATA_DIR"

echo "$START_TS $JOB_NAME started" >> "$RUNS_LOG"

tar -czf "$ARCHIVE" \
  --exclude='.venv' \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='frontend/dist' \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  --exclude='data/uploads' \
  --exclude='jobs/_runs.log' \
  --exclude='.server.pid' \
  -C "$(dirname "$SOURCE")" "$(basename "$SOURCE")"

chmod 600 "$ARCHIVE"

ls -t "$BACKUP_DIR"/agent-*.tar.gz | tail -n +4 | xargs rm -f 2>/dev/null || true

SIZE=$(du -h "$ARCHIVE" | cut -f1)
COUNT=$(ls "$BACKUP_DIR"/agent-*.tar.gz 2>/dev/null | wc -l | tr -d ' ')
END_TS=$(date +%Y-%m-%dT%H:%M:%S)
ENDED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DURATION=$(( $(date +%s) - START_EPOCH ))

cat > "$RESULT_OUT" <<EOF
Backup done: $ARCHIVE ($SIZE)
Backups in rotation: $COUNT
EOF

cat > "$META_OUT" <<EOF
{
  "job": "backup",
  "status": "ok",
  "exit_code": 0,
  "duration_seconds": $DURATION,
  "started_at": "$STARTED_AT",
  "ended_at": "$ENDED_AT",
  "archive": "$(basename "$ARCHIVE")",
  "size_human": "$SIZE",
  "backups_in_rotation": $COUNT
}
EOF

echo "$END_TS $JOB_NAME ok ${DURATION}s" >> "$RUNS_LOG"

echo "Backup done: $ARCHIVE ($SIZE)"
echo "Backups in rotation: $COUNT"
