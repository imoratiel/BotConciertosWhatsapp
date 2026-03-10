/**
 * index.js — WhatsApp → Google Calendar Bot
 *
 * Flujo:
 *  1. WhatsApp Web se conecta vía whatsapp-web.js (sesión persistente con LocalAuth).
 *  2. Solo se procesan mensajes del grupo configurado en WHATSAPP_GROUP_ID.
 *  3. Claude analiza imágenes, links y texto para detectar anuncios de conciertos.
 *  4. createCalendarEvent() inserta el evento en Google Calendar (con comprobación de duplicados).
 *  5. Se aplica un delay humano (5-12 s) antes de cualquier respuesta al chat.
 *
 * Iniciar: node index.js
 */

'use strict';

require('dotenv').config();

const path = require('path');
const fs   = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode                = require('qrcode-terminal');
const { google }            = require('googleapis');
const { getAuthenticatedClient } = require('./auth');
const Groq = require('groq-sdk');

// ─── Logging dual: consola + archivo ─────────────────────────────────────────
const LOG_FILE = path.join(__dirname, 'bot.log');
['log', 'warn', 'error'].forEach((method) => {
  const orig = console[method].bind(console);
  console[method] = (...args) => {
    orig(...args);
    const line = `[${new Date().toISOString()}] ${args.map(a =>
      typeof a === 'object' ? JSON.stringify(a) : String(a)
    ).join(' ')}\n`;
    fs.appendFileSync(LOG_FILE, line);
  };
});

// Ruta absoluta para que LocalAuth y puppeteer coincidan siempre,
// independientemente del directorio desde el que se ejecute node.
const SESSION_DIR = path.join(__dirname, '.wwebjs_auth');

// ─── Variables de entorno ─────────────────────────────────────────────────────
const TIMEZONE        = process.env.TIMEZONE         || 'Europe/Madrid';
const GROUP_ID        = process.env.WHATSAPP_GROUP_ID || '';   // vacío = deshabilitado
const CALENDAR_ID     = process.env.GOOGLE_CALENDAR_ID || 'primary';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

// ─── Cliente Groq (singleton) ─────────────────────────────────────────────────
const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

// ─── Utilidades ───────────────────────────────────────────────────────────────

/**
 * Pausa aleatoria entre min y max segundos para simular comportamiento humano.
 * Evita patrones de respuesta robótica que activan sistemas anti-spam de WhatsApp.
 */
function humanDelay(minSec = 5, maxSec = 12) {
  const ms = (Math.random() * (maxSec - minSec) + minSec) * 1000;
  console.log(`[bot] ⏳ Delay humano: ${(ms / 1000).toFixed(1)}s`);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Formatea una fecha Date a ISO 8601 con zona horaria local para Google Calendar.
 * Google Calendar acepta "YYYY-MM-DDTHH:mm:ss±HH:MM".
 */
function toLocalISOString(date, tz = TIMEZONE) {
  // Usamos Intl para obtener la representación local completa
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year:     'numeric',
    month:    '2-digit',
    day:      '2-digit',
    hour:     '2-digit',
    minute:   '2-digit',
    second:   '2-digit',
    hour12:   false,
  });
  // sv-SE produce "YYYY-MM-DD HH:mm:ss" — reemplazamos el espacio por T
  const local = formatter.format(date).replace(' ', 'T');

  // Calculamos el offset UTC para esa zona y fecha
  const utcDate   = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tzDate    = new Date(date.toLocaleString('en-US', { timeZone: tz }));
  const diffMin   = (tzDate - utcDate) / 60000;
  const sign      = diffMin >= 0 ? '+' : '-';
  const absDiff   = Math.abs(diffMin);
  const hh        = String(Math.floor(absDiff / 60)).padStart(2, '0');
  const mm        = String(absDiff % 60).padStart(2, '0');

  return `${local}${sign}${hh}:${mm}`;
}

// ─── Claude — utilidades compartidas ─────────────────────────────────────────

/**
 * Construye el prompt de extracción de conciertos que se reutiliza en imagen y texto.
 */
function concertPrompt(todayStr, extra = '') {
  return (
    `Eres un asistente que detecta y extrae información de anuncios de conciertos y eventos musicales.\n\n` +
    `Hoy es ${todayStr} (zona horaria: ${TIMEZONE}).\n\n` +
    extra +
    `Si el contenido NO es un anuncio de concierto o evento musical, responde exactamente con la palabra: null\n\n` +
    `Si SÍ es un anuncio, responde ÚNICAMENTE con este JSON (sin texto adicional, sin markdown):\n` +
    `{\n` +
    `  "summary": "Artista / banda — Nombre del tour (si existe)",\n` +
    `  "venue": "Nombre del recinto o null",\n` +
    `  "city": "Ciudad o null",\n` +
    `  "date": "YYYY-MM-DD o null si no se puede determinar",\n` +
    `  "time": "HH:MM o null",\n` +
    `  "endTime": "HH:MM o null"\n` +
    `}\n\n` +
    `Reglas:\n` +
    `- Varios artistas → únelos con " + "\n` +
    `- Fechas relativas → calcúlalas desde hoy\n` +
    `- Sin hora de inicio → usa "21:00"\n` +
    `- Las horas SIN indicador AM/PM son SIEMPRE de noche: "10" = "22:00", "9" = "21:00", "11" = "23:00", "8" = "20:00". Los conciertos nunca son de mañana.\n` +
    `- Si el cartel no menciona ninguna ciudad, asume que el evento es en León.\n` +
    `- Si el cartel es de gira con varias ciudades y fechas, extrae ÚNICAMENTE la fecha y recinto de León. Si no hay ninguna fecha para León, responde null.`
  );
}

/**
 * Convierte el JSON que devuelve Claude en el objeto de evento que espera createCalendarEvent.
 */
function buildEventFromJson(parsed, description) {
  const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); };
  const dateStr  = (parsed.date  && parsed.date  !== 'null') ? parsed.date  : tomorrow();
  const timeStr  = (parsed.time  && parsed.time  !== 'null') ? parsed.time  : '21:00';
  const [sh, sm] = timeStr.split(':').map(Number);

  const startDate = new Date(`${dateStr}T00:00:00`);
  startDate.setHours(sh, sm, 0, 0);

  const endDate = new Date(startDate);
  if (parsed.endTime && parsed.endTime !== 'null') {
    const [eh, em] = parsed.endTime.split(':').map(Number);
    endDate.setHours(eh, em, 0, 0);
  } else {
    endDate.setHours(endDate.getHours() + 2); // 2 h por defecto para conciertos
  }

  const venue = [parsed.venue, parsed.city].filter(v => v && v !== 'null').join(', ');

  return {
    summary:       `[IA] ${parsed.summary || 'Concierto'}`,
    description:   description + (venue ? `\n\nRecinto: ${venue}` : ''),
    startDateTime: toLocalISOString(startDate),
    endDateTime:   toLocalISOString(endDate),
  };
}

/**
 * Parsea la respuesta raw de Claude (puede venir con ```json```) y devuelve el objeto,
 * o null si Claude indica que no es un concierto.
 */
function parseClaudeResponse(rawText) {
  const clean = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (clean === 'null' || clean === '') return null;
  return JSON.parse(clean);
}

/**
 * Extrae URLs de un texto.
 */
function extractUrls(text) {
  return (text || '').match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/g) || [];
}

/**
 * Descarga el contenido de una URL y devuelve el texto limpio (sin HTML).
 * Usa el fetch nativo de Node 18+.
 */
async function fetchUrlText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CalendarBot/1.0)' },
      signal: AbortSignal.timeout(12_000),
    });
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 6000);
    return text;
  } catch (err) {
    console.warn(`[url] ⚠️  No se pudo descargar "${url}": ${err.message}`);
    return null;
  }
}

// ─── Groq Vision (cartel de concierto → imagen) ──────────────────────────────

/**
 * Envía una imagen a Groq vision y extrae los datos del evento.
 * Devuelve el objeto de evento o lanza un error si no puede procesarla.
 */
async function parseImageWithClaude(media, captionText = '') {
  if (!groq) {
    throw new Error('GROQ_API_KEY no configurada — no se pueden procesar imágenes.');
  }

  console.log('[vision] 🖼️  Enviando imagen a Groq...');

  const todayStr = new Date().toLocaleDateString('es-ES', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: TIMEZONE,
  });

  const extra = captionText ? `Pie de foto del mensaje: "${captionText}"\n\n` : '';
  const prompt = concertPrompt(todayStr, extra) + '\n\nAnaliza la imagen adjunta.';

  const response = await groq.chat.completions.create({
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${media.mimetype};base64,${media.data}` } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  const rawText = (response.choices[0].message.content || '').trim();
  console.log('[vision] 📝 Respuesta:', rawText);

  let parsed;
  try { parsed = parseClaudeResponse(rawText); }
  catch (e) { throw new Error(`Respuesta no válida de Groq: ${rawText}`); }

  if (!parsed) throw new Error('Groq indica que la imagen no es un cartel de concierto.');

  const result = buildEventFromJson(
    parsed,
    `Agendado desde cartel de WhatsApp.${captionText ? `\n\nPie de foto: "${captionText}"` : ''}`
  );
  console.log('[vision] ✅ Evento:', JSON.stringify(result, null, 2));
  return result;
}

// ─── Groq Texto (anuncio de concierto → texto / link) ────────────────────────

/**
 * Envía un texto (o contenido extraído de una URL) a Groq y extrae datos del evento.
 * Devuelve null si considera que no es un anuncio de concierto.
 */
async function parseTextWithClaude(text) {
  if (!groq) return null;

  console.log('[groq] 📝 Analizando texto...');

  const todayStr = new Date().toLocaleDateString('es-ES', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: TIMEZONE,
  });

  const extra = `Texto a analizar:\n"${text.slice(0, 3000)}"\n\n`;
  const prompt = concertPrompt(todayStr, extra);

  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  const rawText = (response.choices[0].message.content || '').trim();
  console.log('[groq] 📝 Respuesta:', rawText);

  try {
    const parsed = parseClaudeResponse(rawText);
    if (!parsed) return null;
    return buildEventFromJson(parsed, `Agendado automáticamente desde WhatsApp.\n\nMensaje original:\n"${text.slice(0, 500)}"`);
  } catch {
    console.warn('[groq] ⚠️  Respuesta no parseable, ignorando mensaje.');
    return null;
  }
}

// ─── Google Calendar ──────────────────────────────────────────────────────────

let calendarClient = null;

/**
 * Inicializa el cliente de Google Calendar (singleton).
 */
function getCalendar() {
  if (!calendarClient) {
    const auth      = getAuthenticatedClient();
    calendarClient  = google.calendar({ version: 'v3', auth });
  }
  return calendarClient;
}

/**
 * Inserta un evento en Google Calendar.
 *
 * @param {{ summary, description, startDateTime, endDateTime }} eventData
 * @returns {Promise<string>} — Link del evento creado
 */
async function createCalendarEvent(eventData) {
  const calendar = getCalendar();

  const event = {
    summary:     eventData.summary,
    description: eventData.description,
    start: {
      dateTime: eventData.startDateTime,
      timeZone: TIMEZONE,
    },
    end: {
      dateTime: eventData.endDateTime,
      timeZone: TIMEZONE,
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 30 },
        { method: 'email', minutes: 60 },
      ],
    },
  };

  const response = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    resource:   event,
  });

  const created = response.data;
  console.log(`[calendar] ✅ Evento creado: "${created.summary}"`);
  console.log(`[calendar]    Inicio : ${created.start.dateTime}`);
  console.log(`[calendar]    Fin    : ${created.end.dateTime}`);
  console.log(`[calendar]    Link   : ${created.htmlLink}`);

  return created.htmlLink;
}

/**
 * Comprueba si ya existe un evento con el mismo título en el mismo día.
 * Devuelve el evento existente o null si no hay duplicado.
 */
async function isDuplicateEvent(summary, startDateTime) {
  const calendar = getCalendar();
  const start    = new Date(startDateTime);

  const dayStart = new Date(start); dayStart.setHours(0,  0,  0,   0);
  const dayEnd   = new Date(start); dayEnd.setHours(  23, 59, 59, 999);

  try {
    const res = await calendar.events.list({
      calendarId:   CALENDAR_ID,
      timeMin:      dayStart.toISOString(),
      timeMax:      dayEnd.toISOString(),
      q:            summary,
      singleEvents: true,
      maxResults:   20,
    });

    const match = (res.data.items || []).find(
      e => e.summary?.toLowerCase().trim() === summary.toLowerCase().trim()
    );
    if (match) console.log(`[calendar] ⚠️  Duplicado encontrado: "${match.summary}" (${match.htmlLink})`);
    return match || null;
  } catch (err) {
    console.warn('[calendar] No se pudo comprobar duplicados:', err.message);
    return null;
  }
}

// ─── WhatsApp Client ──────────────────────────────────────────────────────────

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: 'calendar-bot',
    dataPath: SESSION_DIR,  // ruta absoluta → la sesión siempre se encuentra
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--disable-gpu',
      '--disable-extensions',
    ],
  },
  // User-Agent de Chrome real para minimizar detección
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/122.0.0.0 Safari/537.36',
});

// ─── Eventos del cliente ──────────────────────────────────────────────────────

client.on('qr', (qr) => {
  console.log('\n[whatsapp] 📱 Escanea este QR con tu WhatsApp:');
  qrcode.generate(qr, { small: true });
  console.log('[whatsapp] El QR expira en ~20 segundos. Si no lo ves, revisa la terminal.\n');
});

client.on('authenticated', () => {
  console.log('[whatsapp] 🔐 Sesión autenticada correctamente.');
});

client.on('auth_failure', (msg) => {
  console.error('[whatsapp] ❌ Fallo de autenticación:', msg);
  console.error('           Borra la carpeta .wwebjs_auth/ y reinicia para generar un nuevo QR.');
});

client.on('ready', async () => {
  console.log('\n[whatsapp] ✅ Bot conectado y listo.');
  console.log(`[whatsapp]    Grupo vigilado  : ${GROUP_ID || '(ninguno configurado)'}`);
  console.log(`[whatsapp]    Calendario      : ${CALENDAR_ID}`);
  console.log('[whatsapp]    Escuchando mensajes...\n');

  // Lista todos los grupos en los que está el bot al arrancar
  try {
    const chats = await client.getChats();
    const groups = chats.filter(c => c.isGroup);
    if (groups.length === 0) {
      console.log('[grupos] ℹ️  El bot no pertenece a ningún grupo.');
    } else {
      console.log(`[grupos] 📋 Grupos disponibles (${groups.length}):`);
      groups.forEach(g => {
        console.log(`[grupos]    • "${g.name}" → ID: ${g.id._serialized}`);
      });
    }
    console.log('');
  } catch (err) {
    console.warn('[grupos] No se pudo obtener la lista de grupos:', err.message);
  }
});

client.on('disconnected', (reason) => {
  console.warn('[whatsapp] ⚠️  Cliente desconectado:', reason);
  console.warn('[whatsapp]    Intentando reconectar en 10 segundos...');
  setTimeout(() => client.initialize(), 10_000);
});

// ─── Procesamiento de mensajes ────────────────────────────────────────────────

/**
 * Lógica compartida entre 'message' (mensajes ajenos) y 'message_create' (propios).
 * Para el grupo vigilado procesamos AMBOS: otros miembros comparten carteles,
 * y tú mismo puedes reenviar o pegar anuncios desde tu teléfono.
 */
async function handleMessage(message) {
  try {
    const body    = message.body?.trim();
    // Para mensajes propios, 'from' es tu número; el chat real está en 'to'.
    // Para mensajes ajenos, 'from' ES el chat (grupo o contacto).
    const chatId  = message.fromMe ? (message.to || message.from) : message.from;
    const isGroup = chatId.endsWith('@g.us');

    // ── Filtro: solo el grupo vigilado, nada más ─────────────────────────────
    if (!GROUP_ID || chatId !== GROUP_ID) return;

    // ── Log (solo mensajes del grupo) ─────────────────────────────────────────
    const TYPE_EMOJI = {
      chat: '💬', image: '🖼️ ', video: '🎥', audio: '🎵',
      document: '📄', sticker: '🪄', location: '📍', contact: '👤', poll: '📊',
    };
    const typeIcon  = TYPE_EMOJI[message.type] || '❓';
    const direction = message.fromMe ? '→ yo' : '← recibido';
    const chatName  = isGroup
      ? (await message.getChat().catch(() => null))?.name ?? chatId
      : chatId;
    const preview = body
      ? `"${body.slice(0, 60)}${body.length > 60 ? '…' : ''}"`
      : `(${message.type})`;
    console.log(`[msg] ${typeIcon} ${direction} | ${isGroup ? '👥 ' : '👤 '}${chatName} | ${preview}`);

    const isImage = message.hasMedia && message.type === 'image';
    const urls    = extractUrls(body || '');

    const contact    = await message.getContact().catch(() => null);
    const senderName = contact?.pushname || contact?.number || (message.fromMe ? 'Tú' : 'Desconocido');
    const typeLabel  = isImage ? '🖼️  imagen' : (urls.length ? '🔗 link' : '📝 texto');
    console.log(`\n[bot] 📨 ${senderName} | ${typeLabel} | "${(body || '').slice(0, 60)}"`);

    // ── Extraer datos del evento ──────────────────────────────────────────────
    let eventData = null;

    if (isImage) {
      const media = await message.downloadMedia().catch(() => null);
      if (!media) { console.log('[bot] ⚠️  No se pudo descargar la imagen. Ignorando.\n'); return; }
      eventData   = await parseImageWithClaude(media, body || '');

    } else if (urls.length > 0) {
      console.log(`[bot] 🔗 Descargando URL: ${urls[0]}`);
      const pageText    = await fetchUrlText(urls[0]);
      const contextText = pageText
        ? `${body}\n\n--- Contenido de la página ---\n${pageText}`
        : body;
      eventData = await parseTextWithClaude(contextText);

    } else {
      eventData = await parseTextWithClaude(body || '');
    }

    if (!eventData) {
      console.log('[bot] ℹ️  No es un anuncio de concierto. Ignorando.\n');
      return;
    }

    // ── Comprobar duplicado ───────────────────────────────────────────────────
    const existing = await isDuplicateEvent(eventData.summary, eventData.startDateTime);
    if (existing) {
      const dupMsg =
        `ℹ️ Este evento ya está en el calendario:\n` +
        `*${existing.summary}*\n` +
        `📅 ${eventData.startDateTime.slice(0, 10)}\n` +
        `🔗 ${existing.htmlLink}`;
      console.log('[bot] ℹ️  Duplicado —', existing.summary);
      if (!message.fromMe) {
        await humanDelay(2, 4);
        await message.reply(dupMsg).catch(() => {});
      }
      return;
    }

    // ── Crear el evento ───────────────────────────────────────────────────────
    const eventLink = await createCalendarEvent(eventData);

    const successMsg =
      `✅ *Evento agendado:* ${eventData.summary}\n` +
      `📅 *Inicio:* ${eventData.startDateTime}\n` +
      `🔚 *Fin:*   ${eventData.endDateTime}\n` +
      `🔗 ${eventLink}`;
    console.log('[bot] ✅ Agendado:', eventData.summary);
    if (!message.fromMe) {
      await humanDelay();
      await message.reply(successMsg).catch(() => {});
    }

  } catch (err) {
    console.error('[bot] ❌ Error:', err.message);
  }
}

// Mensajes de otros miembros
client.on('message', (message) => handleMessage(message));

// Mensajes enviados por ti mismo (reenvíos de carteles, etc.)
client.on('message_create', async (message) => {
  if (!message.fromMe) return;
  // Para mensajes propios, el destinatario está en 'to', no en 'from'
  const dest = message.to || message.from;
  if (!GROUP_ID || dest !== GROUP_ID) return;
  await handleMessage(message);
});


// ─── Limpieza de locks de Chrome ─────────────────────────────────────────────

/**
 * Elimina los archivos de bloqueo que Chrome deja al cerrarse de forma abrupta
 * (crash del contenedor, SIGKILL, reinicio de Docker, etc.).
 * Sin esta limpieza, puppeteer lanza "The browser is already running" en el
 * siguiente arranque porque el SingletonLock sigue en el directorio de sesión.
 */
function clearChromeLocks() {
  const fs = require('fs');
  const os = require('os');

  // LocalAuth crea el perfil en: SESSION_DIR/session-<clientId>/
  const profileDir = path.join(SESSION_DIR, 'session-calendar-bot');

  // ── 1. Locks dentro del directorio de perfil ─────────────────────────────
  // Chrome crea SingletonLock; puppeteer v21 crea .puppeteer_lock / lockfile.
  const profileLocks = [
    'SingletonLock', 'SingletonCookie', 'SingletonSocket',
    '.puppeteer_lock', 'lockfile',
  ];
  for (const file of profileLocks) {
    const p = path.join(profileDir, file);
    try {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { force: true });
        console.log(`[startup] 🔓 Lock eliminado (perfil): ${file}`);
      }
    } catch { /* ignorar */ }
  }

  // ── 2. Lock adyacente al directorio (<userDataDir>.puppeteer_lock) ────────
  // Algunas versiones de puppeteer-core crean el lock JUNTO AL directorio.
  const adjacentLock = `${profileDir}.puppeteer_lock`;
  try {
    if (fs.existsSync(adjacentLock)) {
      fs.rmSync(adjacentLock, { force: true });
      console.log('[startup] 🔓 Lock eliminado (adyacente)');
    }
  } catch { /* ignorar */ }

  // ── 3. Locks en /tmp que sobreviven a reinicios del proceso ───────────────
  // Docker restart no recrea /tmp; los locks de puppeteer/chrome persisten.
  try {
    const tmp = os.tmpdir();
    for (const entry of fs.readdirSync(tmp)) {
      if (/puppeteer|chrome/i.test(entry)) {
        fs.rmSync(path.join(tmp, entry), { force: true, recursive: true });
        console.log(`[startup] 🔓 Lock eliminado (tmp): ${entry}`);
      }
    }
  } catch { /* /tmp puede tener entradas sin permisos — ignorar */ }

  // ── 4. Log de diagnóstico: muestra qué hay en el directorio de sesión ─────
  try {
    if (fs.existsSync(profileDir)) {
      const entries = fs.readdirSync(profileDir);
      const suspicious = entries.filter(e =>
        /lock|Lock|singleton|Singleton/i.test(e)
      );
      if (suspicious.length) {
        console.warn('[startup] ⚠️  Posibles locks restantes:', suspicious);
      }
    }
  } catch { /* ignorar */ }
}

// ─── Arranque ─────────────────────────────────────────────────────────────────

console.log('╔══════════════════════════════════════════╗');
console.log('║   WhatsApp → Google Calendar Bot  v1.0  ║');
console.log('╚══════════════════════════════════════════╝\n');

// Verificamos que el token de Google existe antes de arrancar WhatsApp
try {
  getCalendar();
  console.log('[startup] ✅ Credenciales de Google Calendar cargadas.\n');
} catch (err) {
  console.error('[startup] ❌', err.message);
  process.exit(1);
}

// Limpiamos locks antes de que puppeteer intente abrir el perfil
clearChromeLocks();

// ─── Servidor HTTP de pruebas ─────────────────────────────────────────────────
// Solo activo si TEST_PORT está definido en .env
// Permite simular mensajes de "otro usuario" sin necesitar un segundo teléfono.
//
// Uso desde PowerShell / cmd:
//   Invoke-RestMethod -Uri http://localhost:3099/test -Method POST -ContentType 'application/json' -Body '{"text":"Concierto de Vetusta Morla el 5 de abril en WiZink Center, Madrid. 21:00h"}'
//   Invoke-RestMethod -Uri http://localhost:3099/test -Method POST -ContentType 'application/json' -Body '{"text":"https://www.ticketmaster.es/event/..."}'
//
// Desde bash / curl:
//   curl -X POST http://localhost:3099/test -H 'Content-Type: application/json' \
//        -d '{"text":"Concierto de Vetusta Morla el 5 de abril en WiZink Center"}'
if (process.env.TEST_PORT) {
  const http = require('http');
  const PORT = parseInt(process.env.TEST_PORT);

  http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/test') {
      res.writeHead(200);
      res.end('WhatsApp Bot — test server OK. POST /test {"text":"...","type":"chat"}');
      return;
    }

    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', async () => {
      try {
        const { text = '', type = 'chat' } = JSON.parse(raw || '{}');

        // Objeto que imita la interfaz mínima de un whatsapp-web.js Message
        const fakeMessage = {
          body:     text,
          from:     GROUP_ID || 'TEST_GROUP@g.us',
          type,
          hasMedia: false,
          fromMe:   false,
          getChat:    async () => ({ name: 'Grupo de prueba', isGroup: true }),
          getContact: async () => ({ pushname: '🤖 TestUser', number: '34600000000' }),
          downloadMedia: async () => null,
          reply: async (txt) => {
            console.log('\n[test] 🤖 El bot respondería:\n' + txt + '\n');
          },
        };

        console.log(`\n[test] 🧪 Simulando mensaje: "${text.slice(0, 80)}"`);
        await handleMessage(fakeMessage);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error('[test] ❌', err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }).listen(PORT, () => {
    console.log(`[test] 🧪 Servidor de pruebas escuchando en http://localhost:${PORT}/test`);
  });
}

client.initialize();
