# WhatsApp → Google Calendar Bot

Bot de Node.js que escucha un grupo de WhatsApp y agenda automáticamente conciertos en Google Calendar usando IA (Groq).

## Cómo funciona

1. Se conecta a WhatsApp vía `@whiskeysockets/baileys` (WebSocket nativo, sin browser) con sesión persistente en `.baileys_auth/`
2. Escucha únicamente el grupo configurado en `WHATSAPP_GROUP_ID`
3. Cuando llega un mensaje, lo clasifica y lo manda a **Groq**:
   - **Imagen** → modelo de visión (Llama 4 Scout) lee el cartel
   - **Link** → scraping de la página + análisis de texto
   - **Texto** → análisis directo (Llama 3.3)
4. La IA extrae: artista, recinto, ciudad, fecha y hora en formato JSON
5. Comprueba duplicados en Google Calendar (por artista + día)
6. Si no existe, crea el evento y responde en el chat con confirmación
7. Aplica un delay aleatorio de 5-12 s antes de responder para simular comportamiento humano

### Reglas de extracción

- Si el cartel es de gira con varias ciudades, se extrae **solo la fecha de León**
- Si no aparece ninguna ciudad, se asume que el evento es en **León**
- Si no hay hora, se usa **21:00** por defecto
- Las horas sin AM/PM se interpretan siempre como noche (ej: "10" → 22:00)
- Los eventos creados llevan el prefijo **`[IA]`** en el título
- Duración por defecto: **2 horas**

---

## Requisitos

- Node.js ≥ 18 (o Docker)
- Cuenta de [Groq](https://console.groq.com) (tier gratuito suficiente)
- Proyecto en [Google Cloud Console](https://console.cloud.google.com) con la API de Google Calendar habilitada

---

## Configuración local

### 1. Credenciales de Google Calendar

1. En Google Cloud Console, crea un proyecto y habilita la **Google Calendar API**
2. Crea credenciales OAuth 2.0 (tipo "Aplicación de escritorio") y descarga el archivo como `credentials.json`
3. Autoriza el acceso una vez:
   ```bash
   node auth.js
   ```
   Abre el navegador, pide permisos y genera `token.json`.

### 2. Variables de entorno

```bash
cp .env.example .env
```

| Variable | Descripción | Default |
|---|---|---|
| `WHATSAPP_GROUP_ID` | ID del grupo WhatsApp (`XXXXXXXX@g.us`) | requerido |
| `TIMEZONE` | Zona horaria para fechas relativas | `Europe/Madrid` |
| `GOOGLE_CREDENTIALS_PATH` | Ruta al `credentials.json` | `./credentials.json` |
| `GOOGLE_TOKEN_PATH` | Ruta al `token.json` | `./token.json` |
| `GOOGLE_CALENDAR_ID` | ID del calendario destino | `primary` |
| `GROQ_API_KEY` | Clave de API de Groq | requerido |
| `TEST_PORT` | Puerto para servidor HTTP de pruebas | — |

#### Obtener el ID del grupo de WhatsApp

Arranca el bot sin `WHATSAPP_GROUP_ID` configurado. En los logs aparecerán los IDs de todos los grupos. Copia el que corresponde al tuyo.

### 3. Iniciar

```bash
npm install
node index.js
```

La primera vez mostrará un **código QR** en la terminal. Escanéalo desde WhatsApp → Dispositivos vinculados → Vincular dispositivo. La sesión queda guardada en `.baileys_auth/`.

---

## Pruebas

Con el bot en marcha y `TEST_PORT` configurado, puedes simular un mensaje:

```bash
# curl
curl -X POST http://localhost:3099/test \
  -H 'Content-Type: application/json' \
  -d '{"text":"Concierto de Vetusta Morla el 5 de abril en WiZink Center"}'

# PowerShell
Invoke-RestMethod -Uri http://localhost:3099/test -Method POST `
  -ContentType 'application/json' `
  -Body '{"text":"Concierto de Vetusta Morla el 5 de abril en WiZink Center"}'
```

---

## Despliegue en Fly.io

El bot está desplegado en [Fly.io](https://fly.io) con CI/CD desde GitHub Actions. Cada push a `main` despliega automáticamente.

Los archivos sensibles se gestionan como secrets (nunca en el repo):

```bash
fly secrets set WHATSAPP_GROUP_ID="XXXXXXXX@g.us"
fly secrets set GROQ_API_KEY="gsk_..."
fly secrets set GOOGLE_CALENDAR_ID="primary"

# credentials.json y token.json en base64 (PowerShell)
fly secrets set GOOGLE_CREDENTIALS_B64="$([Convert]::ToBase64String([IO.File]::ReadAllBytes('credentials.json')))"
fly secrets set GOOGLE_TOKEN_B64="$([Convert]::ToBase64String([IO.File]::ReadAllBytes('token.json')))"
```

El volumen persistente `bot_data` (montado en `/data`) conserva la sesión de WhatsApp, el token de Google y el caché de mensajes entre deploys.

Ver [fly-chuleta.md](fly-chuleta.md) para referencia completa de comandos.

---

## Docker (local)

```bash
docker build -t whatsapp-calendar-bot .

docker run --env-file .env \
           -v $(pwd)/.baileys_auth:/data/.baileys_auth \
           -v $(pwd)/credentials.json:/app/credentials.json \
           -v $(pwd)/token.json:/data/token.json \
           whatsapp-calendar-bot
```

---

## Archivos sensibles (no commitear)

```
.env
credentials.json
token.json
.baileys_auth/
processed_messages.json
bot.log
```
