#!/usr/bin/env bash
# Backup harian PostgreSQL SIMRS (simpan 14 hari).
# Cron:  30 2 * * * /opt/simrs/deploy/backup.sh >> /opt/simrs/backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="/opt/simrs/backups"; umask 077; mkdir -p "$DIR"
FILE="$DIR/simrs-$(date +%Y%m%d-%H%M%S).dump"
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T postgres pg_dump -U simrs -d simrs --format=custom --compress=9 > "$FILE"
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T postgres pg_restore --list < "$FILE" > /dev/null
echo "[$(date -Is)] backup ok $FILE ($(du -h "$FILE" | cut -f1))"
find "$DIR" -name 'simrs-*.dump' -mtime +14 -delete
