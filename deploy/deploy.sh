#!/usr/bin/env bash
# Deploy ulang SIMRS di VPS:  ./deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.prod"

if [ -n "$($COMPOSE ps -q postgres 2>/dev/null)" ]; then
  echo "▶ Backup database sebelum deploy"
  ./deploy/backup.sh
fi
echo "▶ Build image"
$COMPOSE build
echo "▶ Restart"
$COMPOSE up -d --remove-orphans
echo "▶ Health check"
for i in $(seq 1 40); do
  if $COMPOSE exec -T web wget -qO- http://127.0.0.1/health >/dev/null 2>&1; then
    echo "✔ SIMRS sehat"; docker image prune -f >/dev/null; exit 0
  fi
  sleep 3
done
echo "✘ Backend tidak sehat — log terakhir:"; $COMPOSE logs --tail=80 backend; exit 1
