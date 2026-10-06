#!/bin/bash
set -euo pipefail

case "${EMBEDDING_DIMENSIONS:-1536}" in
  ''|*[!0-9]*)
    echo "EMBEDDING_DIMENSIONS must be a positive integer" >&2
    exit 1
    ;;
esac

EMBEDDING_DIMENSIONS="${EMBEDDING_DIMENSIONS:-1536}"
if [ "${EMBEDDING_DIMENSIONS}" -lt 1 ] || [ "${EMBEDDING_DIMENSIONS}" -gt 2000 ]; then
  echo "EMBEDDING_DIMENSIONS must be an integer from 1 to 2000" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "CREATE ROLE wx_semantic_search LOGIN"

sql=$(sed "s/__DIM__/${EMBEDDING_DIMENSIONS}/g" /init.sql)
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v wxpw="$POSTGRES_PASSWORD" <<< "$sql"
