/**
 * index.js — WhatsApp → Google Calendar Bot (Baileys edition)
 *
 * Flujo:
 *  1. WhatsApp se conecta vía Baileys (WebSocket nativo, sin browser).
 *  2. Solo se procesan mensajes del grupo configurado en WHATSAPP_GROUP_ID.
 *  3. Groq analiza imágenes, links y texto para detectar anuncios de conciertos.
 *  4. createCalendarEvent() inserta el evento en Google Calendar (con comprobación de duplicados).
 *  5. Se aplica un delay humano (5-12 s) antes de cualquier respuesta al chat.
 *
 * Iniciar: node index.js
 */

'use strict';

require('dotenv').config();

// Añadir timestamp a todos los logs
const _origLog = console.log.bind(console);
console.log = (...args) => _origLog(`[${new Date().toISOString()}]`, ...args);

const path = require('path');
const fs   = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const qrcode             = require('qrcode-terminal');
const pino               = require('pino');
const { google }         = require('googleapis');
const { getAuthenticatedClient } = require('./auth');
const Groq               = require('groq-sdk');

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

const SESSION_DIR = path.join(__dirname, '.baileys_auth');


// ─── Variables de entorno ─────────────────────────────────────────────────────
const TIMEZONE    = process.env.TIMEZONE            || 'Europe/Madrid';
const GROUP_ID    = process.env.WHATSAPP_GROUP_ID   || '';
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID  || 'primary';
const GROQ_API_KEY = process.env.GROQ_API_KEY       || '';

// ─── Cliente Groq (singleton) ─────────────────────────────────────────────────
const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

// ─── Deduplicación de mensajes ────────────────────────────────────────────────

const PROCESSED_FILE    = path.join(__dirname, 'processed_messages.json');
const PROCESSED_TTL_DAYS = 7;

function loadProcessedIds() {
  try {
    if (fs.existsSync(PROCESSED_FILE)) {
      return JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('[dedup] ⚠️  No se pudo leer processed_messages.json:', e.message);
  }
  return {};
}

function saveProcessedIds(map) {
  const cutoff = Date.now() - PROCESSED_TTL_DAYS * 24 * 60 * 60 * 1000;
  const pruned = Object.fromEntries(
    Object.entries(map).filter(([, ts]) => ts > cutoff)
  );
  try {
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify(pruned));
  } catch (e) {
    console.warn('[dedup] ⚠️  No se pudo guardar processed_messages.json:', e.message);
  }
  return pruned;
}

let processedIds = loadProcessedIds();
console.log(`[dedup] 📋 IDs procesados en caché: ${Object.keys(processedIds).length}`);

// ─── Confirmaciones pendientes ────────────────────────────────────────────────

const CONFIRMATION_TTL_MS = 5 * 60 * 1000; // 5 minutos
const pendingConfirmations = new Map(); // chatId → { eventData, expiresAt }

// ─── Utilidades ───────────────────────────────────────────────────────────────

function humanDelay(minSec = 5, maxSec = 12) {
  const ms = (Math.random() * (maxSec - minSec) + minSec) * 1000;
  console.log(`[bot] ⏳ Delay humano: ${(ms / 1000).toFixed(1)}s`);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toLocalISOString(date, tz = TIMEZONE) {
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
  const local = formatter.format(date).replace(' ', 'T');

  const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tzDate  = new Date(date.toLocaleString('en-US', { timeZone: tz }));
  const diffMin = (tzDate - utcDate) / 60000;
  const sign    = diffMin >= 0 ? '+' : '-';
  const absDiff = Math.abs(diffMin);
  const hh      = String(Math.floor(absDiff / 60)).padStart(2, '0');
  const mm      = String(absDiff % 60).padStart(2, '0');

  return `${local}${sign}${hh}:${mm}`;
}

// ─── Groq — utilidades compartidas ───────────────────────────────────────────

function concertPrompt(todayStr, extra = '') {
  return (
    `Eres un asistente que detecta y extrae información de anuncios de conciertos y eventos musicales.\n\n` +
    `Hoy es ${todayStr} (zona horaria: ${TIMEZONE}).\n\n` +
    extra +
    `Si el contenido NO es un anuncio de concierto o evento musical, responde exactamente con la palabra: null\n\n` +
    `Si SÍ es un anuncio, responde ÚNICAMENTE con este JSON (sin texto adicional, sin markdown):\n` +
    `{\n` +
    `  "artist": "Nombre del artista o banda (solo el nombre, sin tour ni año)",\n` +
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
    endDate.setHours(endDate.getHours() + 2);
  }

  const venue = [parsed.venue, parsed.city].filter(v => v && v !== 'null').join(', ');

  return {
    artist:        parsed.artist || null,
    summary:       `[IA] ${parsed.summary || 'Concierto'}`,
    description:   description + (venue ? `\n\nRecinto: ${venue}` : ''),
    startDateTime: toLocalISOString(startDate),
    endDateTime:   toLocalISOString(endDate),
    venue:         venue || null,
  };
}

function formatEventForConfirmation(eventData) {
  const dateStr = eventData.startDateTime.slice(0, 10);
  const timeStr = eventData.startDateTime.slice(11, 16);
  const lines = [
    `🎵 *He detectado este concierto:*`,
    ``,
    `👤 *Artista:* ${eventData.artist || 'Desconocido'}`,
    `📅 *Fecha:* ${dateStr}`,
    `🕐 *Hora:* ${timeStr}`,
  ];
  if (eventData.venue) lines.push(`📍 *Recinto:* ${eventData.venue}`);
  lines.push(``);
  lines.push(`¿Lo añado al calendario? Responde *sí* para confirmar o *no* para cancelar.`);
  lines.push(`Si algo no es correcto, escribe los datos correctos y lo ajustaré.`);
  return lines.join('\n');
}

async function handleConfirmationReply(sock, chatId, replyText, pending, quotedMsg) {
  const normalized = replyText.toLowerCase().trim();

  if (['sí', 'si', 'yes', 's', 'y'].includes(normalized)) {
    pendingConfirmations.delete(chatId);

    const existing = await isDuplicateEvent(pending.eventData.summary, pending.eventData.startDateTime, pending.eventData.artist);
    if (existing) {
      const dupMsg =
        `ℹ️ Este evento ya está en el calendario:\n` +
        `*${existing.summary}*\n` +
        `📅 ${pending.eventData.startDateTime.slice(0, 10)}\n` +
        `🔗 ${existing.htmlLink}`;
      await humanDelay(1, 3);
      await sock.sendMessage(chatId, { text: dupMsg }, { quoted: quotedMsg }).catch(() => {});
      return;
    }

    const eventLink = await createCalendarEvent(pending.eventData);
    const successMsg =
      `✅ *Evento agendado:* ${pending.eventData.summary}\n` +
      `📅 *Inicio:* ${pending.eventData.startDateTime}\n` +
      `🔚 *Fin:*   ${pending.eventData.endDateTime}\n` +
      `🔗 ${eventLink}`;
    console.log('[bot] ✅ Confirmado y agendado:', pending.eventData.summary);
    await humanDelay(1, 3);
    await sock.sendMessage(chatId, { text: successMsg }, { quoted: quotedMsg }).catch(() => {});

  } else if (['no', 'n', 'cancelar', 'cancel'].includes(normalized)) {
    pendingConfirmations.delete(chatId);
    console.log('[bot] ❌ Evento cancelado por el usuario.');
    await humanDelay(1, 3);
    await sock.sendMessage(chatId, { text: '❌ Evento cancelado. No se ha añadido nada al calendario.' }, { quoted: quotedMsg }).catch(() => {});

  } else {
    // Tratar como corrección: re-parsear con Groq
    console.log('[bot] ✏️  Procesando corrección del usuario...');
    const correctedEvent = await parseTextWithGroq(replyText);
    if (correctedEvent) {
      pendingConfirmations.set(chatId, { eventData: correctedEvent, expiresAt: Date.now() + CONFIRMATION_TTL_MS });
      const confirmMsg = `✏️ He actualizado los datos:\n\n${formatEventForConfirmation(correctedEvent)}`;
      await humanDelay(1, 3);
      await sock.sendMessage(chatId, { text: confirmMsg }, { quoted: quotedMsg }).catch(() => {});
    } else {
      await humanDelay(1, 3);
      await sock.sendMessage(chatId, {
        text: '❓ No he podido entender la corrección. Responde *sí* para confirmar, *no* para cancelar, o describe los datos correctos.',
      }, { quoted: quotedMsg }).catch(() => {});
    }
  }
}

function parseGroqResponse(rawText) {
  const clean = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (clean === 'null' || clean === '') return null;
  return JSON.parse(clean);
}

function extractUrls(text) {
  return (text || '').match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/g) || [];
}

async function fetchUrlText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CalendarBot/1.0)' },
      signal: AbortSignal.timeout(12_000),
    });
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 6000);
  } catch (err) {
    console.warn(`[url] ⚠️  No se pudo descargar "${url}": ${err.message}`);
    return null;
  }
}

// ─── Groq Vision ──────────────────────────────────────────────────────────────

async function parseImageWithGroq(media, captionText = '') {
  if (!groq) throw new Error('GROQ_API_KEY no configurada — no se pueden procesar imágenes.');

  console.log('[vision] 🖼️  Enviando imagen a Groq...');

  const todayStr = new Date().toLocaleDateString('es-ES', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: TIMEZONE,
  });

  const extra  = captionText ? `Pie de foto del mensaje: "${captionText}"\n\n` : '';
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
  try { parsed = parseGroqResponse(rawText); }
  catch (e) { throw new Error(`Respuesta no válida de Groq: ${rawText}`); }

  if (!parsed) throw new Error('Groq indica que la imagen no es un cartel de concierto.');

  const result = buildEventFromJson(
    parsed,
    `Agendado desde cartel de WhatsApp.${captionText ? `\n\nPie de foto: "${captionText}"` : ''}`
  );
  console.log('[vision] ✅ Evento:', JSON.stringify(result, null, 2));
  return result;
}

// ─── Groq Texto ───────────────────────────────────────────────────────────────

async function parseTextWithGroq(text) {
  if (!groq) return null;

  console.log('[groq] 📝 Analizando texto...');

  const todayStr = new Date().toLocaleDateString('es-ES', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: TIMEZONE,
  });

  const extra  = `Texto a analizar:\n"${text.slice(0, 3000)}"\n\n`;
  const prompt = concertPrompt(todayStr, extra);

  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  const rawText = (response.choices[0].message.content || '').trim();
  console.log('[groq] 📝 Respuesta:', rawText);

  try {
    const parsed = parseGroqResponse(rawText);
    if (!parsed) return null;
    return buildEventFromJson(parsed, `Agendado automáticamente desde WhatsApp.\n\nMensaje original:\n"${text.slice(0, 500)}"`);
  } catch {
    console.warn('[groq] ⚠️  Respuesta no parseable, ignorando mensaje.');
    return null;
  }
}

// ─── Google Calendar ──────────────────────────────────────────────────────────

let calendarClient = null;

function getCalendar() {
  if (!calendarClient) {
    const auth     = getAuthenticatedClient();
    calendarClient = google.calendar({ version: 'v3', auth });
  }
  return calendarClient;
}

async function createCalendarEvent(eventData) {
  const calendar = getCalendar();

  const event = {
    summary:     eventData.summary,
    description: eventData.description,
    start: { dateTime: eventData.startDateTime, timeZone: TIMEZONE },
    end:   { dateTime: eventData.endDateTime,   timeZone: TIMEZONE },
    ...(eventData.artist && {
      extendedProperties: { private: { artist: eventData.artist.toLowerCase().trim() } },
    }),
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 30 },
        { method: 'email', minutes: 60 },
      ],
    },
  };

  const response = await calendar.events.insert({ calendarId: CALENDAR_ID, resource: event });
  const created  = response.data;

  console.log(`[calendar] ✅ Evento creado: "${created.summary}"`);
  console.log(`[calendar]    Inicio : ${created.start.dateTime}`);
  console.log(`[calendar]    Fin    : ${created.end.dateTime}`);
  console.log(`[calendar]    Link   : ${created.htmlLink}`);

  return created.htmlLink;
}

async function isDuplicateEvent(summary, startDateTime, artist) {
  const calendar = getCalendar();
  const start    = new Date(startDateTime);

  const dayStart = new Date(start); dayStart.setHours(0,  0,  0,   0);
  const dayEnd   = new Date(start); dayEnd.setHours(  23, 59, 59, 999);

  try {
    const res = await calendar.events.list({
      calendarId:   CALENDAR_ID,
      timeMin:      dayStart.toISOString(),
      timeMax:      dayEnd.toISOString(),
      singleEvents: true,
      maxResults:   50,
    });

    const items = res.data.items || [];

    // Comparar por artista guardado en extendedProperties (más robusto)
    if (artist) {
      const artistNorm = artist.toLowerCase().trim();
      const match = items.find(e =>
        e.extendedProperties?.private?.artist === artistNorm
      );
      if (match) {
        console.log(`[calendar] ⚠️  Duplicado por artista: "${match.summary}" (${match.htmlLink})`);
        return match;
      }
    }

    // Fallback: comparar por título completo (eventos creados antes de este cambio)
    const summaryNorm = summary.toLowerCase().trim();
    const match = items.find(e => e.summary?.toLowerCase().trim() === summaryNorm);
    if (match) console.log(`[calendar] ⚠️  Duplicado por título: "${match.summary}" (${match.htmlLink})`);
    return match || null;
  } catch (err) {
    console.warn('[calendar] No se pudo comprobar duplicados:', err.message);
    return null;
  }
}

// ─── Procesamiento de mensajes ────────────────────────────────────────────────

async function handleMessage(sock, msg) {
  try {
    const { key, message: waMessage, pushName } = msg;

    if (!waMessage) return; // status updates, reacciones, etc.

    const chatId = key.remoteJid;
    const fromMe = key.fromMe;

    // ── Filtro: solo el grupo vigilado ────────────────────────────────────────
    console.log(`[debug] mensaje de chatId: ${chatId} | GROUP_ID: ${GROUP_ID} | match: ${chatId === GROUP_ID}`);
    if (!GROUP_ID || chatId !== GROUP_ID) return;

    // ── Ignorar mensajes propios del bot ─────────────────────────────────────
    if (fromMe) return;

    // ── Deduplicación ─────────────────────────────────────────────────────────
    const msgId = key.id;
    if (msgId) {
      if (processedIds[msgId]) {
        console.log(`[dedup] ⏭️  Mensaje ya procesado, ignorando: ${msgId}`);
        return;
      }
      processedIds[msgId] = Date.now();
      processedIds = saveProcessedIds(processedIds);
    }

    // ── Extraer body y tipo ───────────────────────────────────────────────────
    const isImage = !!waMessage.imageMessage;
    const body = (
      waMessage.conversation ||
      waMessage.extendedTextMessage?.text ||
      (isImage ? waMessage.imageMessage?.caption : '') ||
      ''
    ).trim();

    const senderName = pushName || (fromMe ? 'Tú' : 'Desconocido');
    const urls       = extractUrls(body);
    const typeLabel  = isImage ? '🖼️  imagen' : (urls.length ? '🔗 link' : '📝 texto');

    console.log(`\n[bot] 📨 ${senderName} | ${typeLabel} | "${body.slice(0, 60)}"`);

    // ── Comprobar si hay una confirmación pendiente ───────────────────────────
    const pending = pendingConfirmations.get(chatId);
    if (pending) {
      if (Date.now() > pending.expiresAt) {
        pendingConfirmations.delete(chatId);
        console.log('[bot] ⏰ Confirmación expirada, procesando como nuevo mensaje.');
      } else {
        await handleConfirmationReply(sock, chatId, body, pending, msg);
        return;
      }
    }

    // ── Extraer datos del evento ──────────────────────────────────────────────
    let eventData = null;

    if (isImage) {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}).catch(() => null);
      if (!buffer) { console.log('[bot] ⚠️  No se pudo descargar la imagen.\n'); return; }
      const mimetype = waMessage.imageMessage.mimetype || 'image/jpeg';
      const media    = { data: buffer.toString('base64'), mimetype };
      eventData = await parseImageWithGroq(media, body);

    } else if (urls.length > 0) {
      console.log(`[bot] 🔗 Descargando URL: ${urls[0]}`);
      const pageText    = await fetchUrlText(urls[0]);
      const contextText = pageText
        ? `${body}\n\n--- Contenido de la página ---\n${pageText}`
        : body;
      eventData = await parseTextWithGroq(contextText);

    } else {
      eventData = await parseTextWithGroq(body || '');
    }

    if (!eventData) {
      console.log('[bot] ℹ️  No es un anuncio de concierto. Ignorando.\n');
      return;
    }

    // ── Comprobar duplicado antes de pedir confirmación ───────────────────────
    const existing = await isDuplicateEvent(eventData.summary, eventData.startDateTime, eventData.artist);
    if (existing) {
      const dupMsg =
        `ℹ️ Este evento ya está en el calendario:\n` +
        `*${existing.summary}*\n` +
        `📅 ${eventData.startDateTime.slice(0, 10)}\n` +
        `🔗 ${existing.htmlLink}`;
      console.log('[bot] ℹ️  Duplicado —', existing.summary);
      await humanDelay(2, 4);
      await sock.sendMessage(chatId, { text: dupMsg }, { quoted: msg }).catch(() => {});
      return;
    }

    // ── Pedir confirmación al usuario ─────────────────────────────────────────
    pendingConfirmations.set(chatId, { eventData, expiresAt: Date.now() + CONFIRMATION_TTL_MS });
    const confirmMsg = formatEventForConfirmation(eventData);
    console.log('[bot] ❓ Pidiendo confirmación para:', eventData.summary);
    await humanDelay();
    await sock.sendMessage(chatId, { text: confirmMsg }, { quoted: msg }).catch(() => {});

  } catch (err) {
    console.error('[bot] ❌ Error:', err.message);
  }
}

// ─── Monitor de IPs de Groq ───────────────────────────────────────────────────


// ─── WhatsApp Client (Baileys) ────────────────────────────────────────────────

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth:               state,
    printQRInTerminal:  false,
    logger:             pino({ level: 'silent' }),
    // Necesario para retransmisión de mensajes offline
    getMessage: async () => ({ conversation: '' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n[whatsapp] 📱 Escanea este QR con tu WhatsApp:');
      qrcode.generate(qr, { small: true });
      console.log('[whatsapp] El QR expira en ~20 segundos.\n');
    }

    if (connection === 'open') {
      // Comprobar IPs de Groq al arrancar y cada 6 horas
      // checkGroqIPs(sock);
      // setInterval(() => checkGroqIPs(sock), 6 * 60 * 60 * 1000);

      console.log('\n[whatsapp] ✅ Bot conectado y listo.');
      console.log(`[whatsapp]    Grupo vigilado  : ${GROUP_ID || '(ninguno configurado)'}`);
      console.log(`[whatsapp]    Calendario      : ${CALENDAR_ID}`);
      console.log('[whatsapp]    Escuchando mensajes...\n');

      // Listar grupos disponibles para facilitar la configuración de WHATSAPP_GROUP_ID
      try {
        const chats = await sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        console.log(`[whatsapp] 📋 Grupos disponibles (${groups.length}):`);
        groups.forEach(g => {
          const marker = g.id === GROUP_ID ? ' ← VIGILADO' : '';
          console.log(`[whatsapp]    ${g.id}  "${g.subject}"${marker}`);
        });
        console.log('');
      } catch (err) {
        console.warn('[whatsapp] ⚠️  No se pudieron listar los grupos:', err.message);
      }
    }

    if (connection === 'close') {
      const code            = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.warn(`[whatsapp] ⚠️  Conexión cerrada (código: ${code}). Reconectar: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(() => startBot(), 5_000);
      } else {
        console.error('[whatsapp] ❌ Sesión cerrada (loggedOut). Borra .baileys_auth/ y reinicia.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      await handleMessage(sock, msg);
    }
  });

  return sock;
}

// ─── Arranque ─────────────────────────────────────────────────────────────────

console.log('╔══════════════════════════════════════════╗');
console.log('║   WhatsApp → Google Calendar Bot  v2.0  ║');
console.log('║            (Baileys — sin browser)       ║');
console.log('╚══════════════════════════════════════════╝\n');

try {
  getCalendar();
  console.log('[startup] ✅ Credenciales de Google Calendar cargadas.\n');
} catch (err) {
  console.error('[startup] ❌', err.message);
  process.exit(1);
}

// ─── Servidor HTTP de pruebas ─────────────────────────────────────────────────
// Solo activo si TEST_PORT está definido en .env
if (process.env.TEST_PORT) {
  const http = require('http');
  const PORT = parseInt(process.env.TEST_PORT);

  http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/test') {
      res.writeHead(200);
      res.end('WhatsApp Bot v2 — test server OK. POST /test {"text":"..."}');
      return;
    }

    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', async () => {
      try {
        const { text = '' } = JSON.parse(raw || '{}');

        // Objeto mínimo que imita un mensaje de Baileys
        const fakeMsg = {
          key: {
            remoteJid: GROUP_ID || 'TEST_GROUP@g.us',
            fromMe:    false,
            id:        `TEST_${Date.now()}`,
          },
          message:  { conversation: text },
          pushName: '🤖 TestUser',
        };

        // Sock falso con sendMessage simulado
        const fakeSock = {
          sendMessage: async (_jid, { text: t }) => {
            console.log('\n[test] 🤖 El bot respondería:\n' + t + '\n');
          },
        };

        console.log(`\n[test] 🧪 Simulando mensaje: "${text.slice(0, 80)}"`);
        await handleMessage(fakeSock, fakeMsg);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error('[test] ❌', err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }).listen(PORT, () => {
    console.log(`[test] 🧪 Servidor de pruebas escuchando en http://localhost:${PORT}/test\n`);
  });
}

startBot().catch(err => {
  console.error('[startup] ❌ Error fatal al iniciar Baileys:', err.message);
  process.exit(1);
});
