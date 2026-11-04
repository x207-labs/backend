#!/bin/sh
# BE-089: the read model lives on the volume (X207_DB_PATH); the first start copies the seed (the v013 circle replayed up to a block) and the indexer follows the chain from there
set -e
DB="${X207_DB_PATH:-/data/x207.sqlite}"
mkdir -p "$(dirname "$DB")"
if [ ! -f "$DB" ]; then
  echo '{"level":"info","msg":"first start: seeding the read model","seed":"seed/x207-seed.sqlite"}' >&2
  cp seed/x207-seed.sqlite "$DB"
fi
export X207_API_HOST="${X207_API_HOST:-0.0.0.0}"
export X207_API_PORT="${PORT:-${X207_API_PORT:-8080}}"
exec node dist/main.js
