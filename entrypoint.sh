#!/bin/sh
# entrypoint.sh — Limpia locks de Chrome/puppeteer antes de arrancar Node.
# Se ejecuta cada vez que el contenedor (re)arranca.
set -e

SESSION_PROFILE="/home/pptruser/app/.wwebjs_auth/session-calendar-bot"

echo "[entrypoint] Limpiando locks..."

# ── 1. Locks conocidos dentro del perfil de Chrome ──────────────────────────
for f in SingletonLock SingletonCookie SingletonSocket .puppeteer_lock lockfile; do
  if [ -f "$SESSION_PROFILE/$f" ]; then
    rm -f "$SESSION_PROFILE/$f"
    echo "[entrypoint] Eliminado: $SESSION_PROFILE/$f"
  fi
done

# ── 2. Borrado explícito del lock file de puppeteer-core v24 ─────────────────
# En v24 el lock es exactamente: <userDataDir>/lockfile (sin extensión)
rm -f "$SESSION_PROFILE/lockfile" 2>/dev/null && true

# ── 3. Cualquier otro *lock* en el árbol de sesión (captura versiones futuras) ─
find /home/pptruser/app/.wwebjs_auth -maxdepth 4 \
  \( -name "*.lock" -o -name "*Lock*" -o -name "*.puppeteer_lock" -o -name "lockfile" \) \
  -delete 2>/dev/null && true

# ── 4. Locks de puppeteer en /tmp (persisten entre reinicios del proceso) ───
find /tmp -maxdepth 2 \
  \( -name "*puppeteer*" -o -name "*chrome*" \) \
  -delete 2>/dev/null && true

echo "[entrypoint] Listo. Iniciando bot..."
exec node index.js
