# WhatsApp → Google Calendar Bot

Bot de Node.js que escucha un grupo de WhatsApp y agenda automáticamente conciertos en Google Calendar usando IA (Groq).

## Flujo principal

1. **WhatsApp** se conecta vía `@whiskeysockets/baileys` (WebSocket nativo, sin browser) con sesión persistente en `.baileys_auth/`
2. Solo se procesan mensajes del grupo configurado en `WHATSAPP_GROUP_ID`
3. **Groq** analiza imágenes (vision), links (scraping) y texto para detectar anuncios de conciertos
4. Se comprueba si el evento ya existe en el calendario (deduplicación por título + día)
5. Se inserta el evento en **Google Calendar** y se responde en el chat
6. Se aplica un delay humano (5-12 s) antes de responder, para evitar detección anti-spam

## Archivos clave

- [index.js](index.js) — Lógica principal: WhatsApp client, procesamiento de mensajes, integración con Groq y Google Calendar
- [auth.js](auth.js) — Flujo OAuth2 para Google Calendar; exporta `getAuthenticatedClient()`
- [Dockerfile](Dockerfile) — Imagen basada en `node:20-slim` (sin Chrome, Baileys no lo necesita)
- [.env.example](.env.example) — Variables de entorno requeridas
- `processed_messages.json` — Caché en disco de IDs de mensajes procesados (TTL 7 días)
- `credentials.json` — Credenciales OAuth2 de Google Cloud (no commitear)
- `token.json` — Token de acceso de Google generado por `auth.js` (no commitear)

## Variables de entorno (.env)

| Variable | Descripción | Default |
|---|---|---|
| `WHATSAPP_GROUP_ID` | ID del grupo WhatsApp (`XXXXXXXX@g.us`) | requerido |
| `TIMEZONE` | Zona horaria para fechas relativas | `Europe/Madrid` |
| `GOOGLE_CREDENTIALS_PATH` | Ruta al JSON de credenciales OAuth2 | `./credentials.json` |
| `GOOGLE_TOKEN_PATH` | Ruta donde se guarda el token | `./token.json` |
| `GOOGLE_CALENDAR_ID` | ID del calendario destino | `primary` |
| `GROQ_API_KEY` | Clave de API de Groq para IA | requerido |
| `TEST_PORT` | Puerto para servidor HTTP de pruebas (opcional) | — |

> Nota: `.env.example` menciona `MISTRAL_API_KEY` pero el código usa `GROQ_API_KEY` (Groq SDK). Usar `GROQ_API_KEY`.

## Comandos

```bash
# Autorizar Google Calendar (ejecutar UNA VEZ antes del bot)
node auth.js

# Iniciar el bot
node index.js

# Simular un mensaje de texto (requiere TEST_PORT en .env)
curl -X POST http://localhost:3099/test \
  -H 'Content-Type: application/json' \
  -d '{"text":"Concierto de Vetusta Morla el 5 de abril en WiZink Center"}'

# Con PowerShell
Invoke-RestMethod -Uri http://localhost:3099/test -Method POST `
  -ContentType 'application/json' `
  -Body '{"text":"Concierto de Vetusta Morla el 5 de abril en WiZink Center"}'
```

## Modelos de Groq usados

- **Imágenes** (carteles): `meta-llama/llama-4-scout-17b-16e-instruct` (vision)
- **Texto y links**: `llama-3.3-70b-versatile`

## Reglas de extracción de eventos (prompt)

- Ciudad por defecto si no se menciona: **León**
- Hora por defecto si no se indica: **21:00**
- Horas sin AM/PM → siempre de noche (ej: "10" = 22:00, "9" = 21:00)
- Giras con varias ciudades → extraer solo la fecha de León; si no hay, devolver `null`
- Duración por defecto: **2 horas**
- Eventos creados con prefijo `[IA]` en el título

## Requisitos previos

- Node.js >= 18.0.0
- Credenciales OAuth2 de Google Cloud Console (scope: `calendar.events`)
- Clave de API de Groq
- El bot debe estar añadido al grupo de WhatsApp

## Docker

```bash
# Build
docker build -t whatsapp-calendar-bot .

# Run (con volúmenes para sesión y credenciales)
docker run -v $(pwd)/.wwebjs_auth:/home/pptruser/app/.wwebjs_auth \
           -v $(pwd)/credentials.json:/home/pptruser/app/credentials.json \
           -v $(pwd)/token.json:/home/pptruser/app/token.json \
           --env-file .env \
           whatsapp-calendar-bot
```

## Archivos a ignorar en git

```
.env
credentials.json
token.json
.wwebjs_auth/
processed_messages.json
bot.log
node_modules/
```
