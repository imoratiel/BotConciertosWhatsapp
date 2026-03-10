# WhatsApp → Google Calendar Bot

Bot que monitoriza un grupo de WhatsApp y agenda automáticamente los conciertos que se anuncian en él (imágenes, carteles y textos) en Google Calendar.

## Cómo funciona

1. Se conecta a WhatsApp Web mediante `whatsapp-web.js` con sesión persistente.
2. Escucha únicamente el grupo configurado en `WHATSAPP_GROUP_ID`.
3. Cuando llega un mensaje con imagen o texto, lo envía a **Groq** (Llama 4 Scout para visión, Llama 3.3 para texto) para extraer: artista, recinto, ciudad, fecha y hora.
4. Si detecta un concierto en León, lo inserta en **Google Calendar** (con comprobación de duplicados).
5. Responde en el chat con confirmación o error, con un delay aleatorio de 5-12 s para simular comportamiento humano.

### Reglas de extracción
- Si el cartel es de gira con varias ciudades, se extrae **solo la fecha de León**.
- Si no aparece ninguna ciudad, se asume que el evento es en León.
- Si no hay hora, se usa **21:00** por defecto.
- Las horas sin indicador AM/PM se interpretan siempre como **noche** (ej: "10" → 22:00).
- Los eventos creados por el bot llevan el prefijo **`[IA]`** en el título.

---

## Requisitos

- Node.js ≥ 18 (o Docker)
- Cuenta de [Groq](https://console.groq.com) (tier gratuito)
- Proyecto en [Google Cloud Console](https://console.cloud.google.com) con la API de Google Calendar habilitada

---

## Configuración

### 1. Credenciales de Google Calendar

1. En Google Cloud Console, crea un proyecto y habilita la **Google Calendar API**.
2. Crea credenciales OAuth 2.0 (tipo "Aplicación de escritorio") y descarga el archivo como `credentials.json` en la raíz del proyecto.
3. Ejecuta el flujo de autorización una vez:
   ```bash
   node auth.js
   ```
   Esto abrirá el navegador, pedirá permisos y generará `token.json`.

### 2. Variables de entorno

Copia el ejemplo y rellena los valores:

```bash
cp .env.example .env
```

| Variable | Descripción |
|---|---|
| `WHATSAPP_GROUP_ID` | ID del grupo de WhatsApp (formato `XXXXX@g.us`) |
| `TIMEZONE` | Zona horaria para fechas relativas (ej: `Europe/Madrid`) |
| `GOOGLE_CREDENTIALS_PATH` | Ruta al `credentials.json` (por defecto `./credentials.json`) |
| `GOOGLE_TOKEN_PATH` | Ruta al `token.json` (por defecto `./token.json`) |
| `GOOGLE_CALENDAR_ID` | ID del calendario destino (`primary` o el ID específico) |
| `GROQ_API_KEY` | Clave de API de Groq |

#### Cómo obtener el ID del grupo de WhatsApp

Arranca el bot una vez sin `WHATSAPP_GROUP_ID` configurado. En los logs aparecerán los IDs de todos los chats que reciban mensajes. Copia el que corresponde a tu grupo.

---

## Ejecución

### Con Node directamente

```bash
npm install
node index.js
```

La primera vez mostrará un **código QR** en la terminal. Escanéalo desde WhatsApp (Dispositivos vinculados → Vincular dispositivo). La sesión queda guardada en `.wwebjs_auth/` y no hace falta volver a escanear.

### Con Docker

```bash
docker compose up -d
```

La sesión de WhatsApp se persiste en un volumen Docker nombrado (`whatsapp_session`), por lo que sobrevive a reinicios del contenedor.

---

## Logs

El bot escribe logs simultáneamente en **consola** y en el archivo **`bot.log`** (en la raíz del proyecto).

---

## Pruebas

Con el bot en marcha, puedes simular un mensaje de texto mediante HTTP:

```powershell
Invoke-RestMethod -Uri http://localhost:3099/test `
  -Method POST `
  -ContentType 'application/json' `
  -Body '{"text":"Concierto de Vetusta Morla el 5 de abril en Espacio Vías, León. 21:00h"}'
```

---

## Archivos sensibles

Los siguientes archivos contienen credenciales y están excluidos del repositorio (`.gitignore`):

- `.env`
- `credentials.json`
- `token.json`
- `.wwebjs_auth/`
