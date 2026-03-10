/**
 * auth.js — Flujo OAuth2 para Google Calendar
 *
 * Ejecuta este script UNA VEZ para autorizar la aplicación:
 *   node auth.js
 *
 * Generará un token.json que index.js reutilizará en cada arranque.
 */

'use strict';

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const { google } = require('googleapis');

// Importamos open de forma compatible con ESM y CJS
let openBrowser;
async function launchBrowser(url) {
  if (!openBrowser) {
    // open v10+ es ESM puro; lo importamos dinámicamente
    const mod = await import('open');
    openBrowser = mod.default;
  }
  return openBrowser(url);
}

// ─── Scopes necesarios ────────────────────────────────────────────────────────
const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

// ─── Rutas desde .env ─────────────────────────────────────────────────────────
const CREDENTIALS_PATH = path.resolve(process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json');
const TOKEN_PATH        = path.resolve(process.env.GOOGLE_TOKEN_PATH       || './token.json');

// ─── Carga credenciales de la aplicación ─────────────────────────────────────
function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error(`[auth] ❌ No se encontró el archivo de credenciales en: ${CREDENTIALS_PATH}`);
    console.error('       Descárgalo desde Google Cloud Console → APIs & Services → Credentials.');
    process.exit(1);
  }
  const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
  return JSON.parse(raw);
}

// ─── Construye el cliente OAuth2 ─────────────────────────────────────────────
function buildOAuth2Client(credentials) {
  // El JSON de credenciales puede venir de "web" o "installed"
  const { client_secret, client_id, redirect_uris } =
    credentials.web || credentials.installed;

  return new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
}

// ─── Flujo interactivo de autorización ───────────────────────────────────────
async function authorize() {
  const credentials = loadCredentials();
  const oAuth2Client = buildOAuth2Client(credentials);

  // Si ya existe un token válido, informamos y salimos
  if (fs.existsSync(TOKEN_PATH)) {
    console.log(`[auth] ✅ Ya existe un token en ${TOKEN_PATH}.`);
    console.log('       Si quieres re-autorizar, borra ese archivo y vuelve a ejecutar auth.js.');
    return;
  }

  // Genera la URL de consentimiento
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline', // necesario para obtener refresh_token
    scope: SCOPES,
    prompt: 'consent',      // fuerza la pantalla de consentimiento para obtener refresh_token
  });

  console.log('\n[auth] 🔑 Abriendo navegador para autorización de Google Calendar...');
  console.log('[auth]    Si el navegador no se abre, visita esta URL manualmente:\n');
  console.log(`   ${authUrl}\n`);

  try {
    await launchBrowser(authUrl);
  } catch {
    // En entornos sin GUI simplemente mostramos la URL
  }

  // Leemos el código de autorización desde stdin
  const code = await readLineFromStdin('[auth] Pega aquí el código de autorización: ');

  try {
    const { tokens } = await oAuth2Client.getToken(code.trim());
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    console.log(`\n[auth] ✅ Token guardado en: ${TOKEN_PATH}`);
    console.log('[auth]    Ya puedes iniciar el bot con: node index.js\n');
  } catch (err) {
    console.error('[auth] ❌ Error al obtener el token:', err.message);
    process.exit(1);
  }
}

// ─── Helper: leer una línea de stdin ─────────────────────────────────────────
function readLineFromStdin(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (data.includes('\n')) {
        process.stdin.pause();
        resolve(data.split('\n')[0]);
      }
    });
  });
}

// ─── Función exportable para index.js ────────────────────────────────────────
/**
 * Devuelve un cliente OAuth2 autenticado listo para usarse con la API de Calendar.
 * Si el token ha expirado, googleapis lo renueva automáticamente con el refresh_token.
 *
 * @returns {google.auth.OAuth2}
 */
function getAuthenticatedClient() {
  const credentials = loadCredentials();
  const oAuth2Client = buildOAuth2Client(credentials);

  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(
      `No se encontró el token de Google en ${TOKEN_PATH}. ` +
      'Ejecuta primero: node auth.js'
    );
  }

  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  oAuth2Client.setCredentials(token);

  // Cuando googleapis renueva el token, lo persiste automáticamente
  oAuth2Client.on('tokens', (newTokens) => {
    const current = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    const merged  = { ...current, ...newTokens };
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
    console.log('[auth] 🔄 Token de Google renovado y guardado.');
  });

  return oAuth2Client;
}

module.exports = { getAuthenticatedClient };

// ─── Punto de entrada cuando se ejecuta directamente ─────────────────────────
if (require.main === module) {
  authorize().catch((err) => {
    console.error('[auth] Error inesperado:', err);
    process.exit(1);
  });
}
