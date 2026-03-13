#!/bin/sh
set -e

DATA_DIR="${DATA_DIR:-/data}"

# Decodificar credentials.json desde secret
if [ -n "$GOOGLE_CREDENTIALS_B64" ]; then
  echo "$GOOGLE_CREDENTIALS_B64" | base64 -d > /app/credentials.json
  echo "[entrypoint] credentials.json escrito desde secret"
fi

# Decodificar token.json desde secret (solo si no existe ya en el volumen)
if [ -n "$GOOGLE_TOKEN_B64" ] && [ ! -f "$DATA_DIR/token.json" ]; then
  echo "$GOOGLE_TOKEN_B64" | base64 -d > "$DATA_DIR/token.json"
  echo "[entrypoint] token.json escrito desde secret"
fi

# Enlazar archivos persistentes al volumen
mkdir -p "$DATA_DIR/.baileys_auth"

[ ! -L /app/.baileys_auth ] && rm -rf /app/.baileys_auth && ln -s "$DATA_DIR/.baileys_auth" /app/.baileys_auth
[ ! -L /app/token.json ]    && ln -sf "$DATA_DIR/token.json" /app/token.json
[ ! -L /app/processed_messages.json ] && ln -sf "$DATA_DIR/processed_messages.json" /app/processed_messages.json
[ ! -L /app/bot.log ]       && ln -sf "$DATA_DIR/bot.log" /app/bot.log

exec node index.js
