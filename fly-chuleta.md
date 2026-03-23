# Fly.io — Chuleta de comandos

App: `whatsapp-calendar-bot-falling-star-8140`
Máquina: `2873457b173d08`
Región: `cdg` (París)

---

## Estado y logs

```bash
# Ver estado general
fly status --app whatsapp-calendar-bot-falling-star-8140

# Ver logs en tiempo real
fly logs --app whatsapp-calendar-bot-falling-star-8140

# Ver estado de las máquinas
fly machine list --app whatsapp-calendar-bot-falling-star-8140
```

## Máquina

```bash
# Arrancar la máquina
fly machine start 2873457b173d08 --app whatsapp-calendar-bot-falling-star-8140

# Reiniciar la máquina
fly machine restart 2873457b173d08 --app whatsapp-calendar-bot-falling-star-8140

# Parar la máquina (no borra nada)
fly machine stop 2873457b173d08 --app whatsapp-calendar-bot-falling-star-8140
```

## Despliegue

```bash
# Desplegar (build local, requiere Docker Desktop)
fly deploy --local-only

# Desplegar (build remoto, requiere cuenta con tarjeta)
fly deploy
```

## Secrets (variables de entorno)

```bash
# Ver qué secrets están configurados
fly secrets list --app whatsapp-calendar-bot-falling-star-8140

# Actualizar una variable (reinicia el bot automáticamente)
fly secrets set WHATSAPP_GROUP_ID="XXXXXXXX@g.us"
fly secrets set GROQ_API_KEY="gsk_..."
fly secrets set GOOGLE_CALENDAR_ID="primary"

# Actualizar credentials.json (PowerShell)
fly secrets set GOOGLE_CREDENTIALS_B64="$([Convert]::ToBase64String([IO.File]::ReadAllBytes('credentials.json')))"

# Actualizar token.json (PowerShell) — solo si hay que renovarlo manualmente
fly secrets set GOOGLE_TOKEN_B64="$([Convert]::ToBase64String([IO.File]::ReadAllBytes('token.json')))"
```

## Acceso al servidor

```bash
# Abrir consola SSH en el servidor
fly ssh console --app whatsapp-calendar-bot-falling-star-8140

# Subir archivos al volumen via SFTP
fly sftp shell --app whatsapp-calendar-bot-falling-star-8140
# Dentro del shell: put archivo.json /data/archivo.json
```

## Volumen persistente

El volumen `bot_data` está montado en `/data` y contiene:
- `/data/.baileys_auth/` — sesión de WhatsApp (no borrar)
- `/data/token.json`     — token de Google Calendar
- `/data/processed_messages.json` — caché de mensajes procesados
- `/data/bot.log`        — log del bot

```bash
# Ver volúmenes
fly volumes list --app whatsapp-calendar-bot-falling-star-8140
```

## CI/CD

Cada push a `main` despliega automáticamente via GitHub Actions.
Requiere el secret `FLY_API_TOKEN` en GitHub → Settings → Secrets.

```bash
# Generar token de deploy para GitHub Actions
fly tokens create deploy -x 999999h
```

## Si WhatsApp pide nuevo QR

```bash
# 1. Ver logs para ver el QR
fly logs --app whatsapp-calendar-bot-falling-star-8140

# 2. Si no aparece el QR, borrar la sesión y reiniciar
fly ssh console --app whatsapp-calendar-bot-falling-star-8140
# Dentro: rm -rf /data/.baileys_auth && exit
fly machine restart 2873457b173d08 --app whatsapp-calendar-bot-falling-star-8140
# Escanear el QR en los logs
```
