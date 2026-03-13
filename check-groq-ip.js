#!/usr/bin/env node
// Comprueba si las IPs de api.groq.com han cambiado y notifica si es así.
// Uso: node check-groq-ip.js
// Tarea programada recomendada: cada 6-12 horas

import dns from 'dns/promises';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.groq-ips.json');
const HOSTNAME = 'api.groq.com';

function notify(title, message) {
  try {
    // Notificación de Windows via PowerShell
    const ps = `
      Add-Type -AssemblyName System.Windows.Forms;
      $notify = New-Object System.Windows.Forms.NotifyIcon;
      $notify.Icon = [System.Drawing.SystemIcons]::Warning;
      $notify.Visible = $true;
      $notify.ShowBalloonTip(10000, '${title}', '${message}', [System.Windows.Forms.ToolTipIcon]::Warning);
      Start-Sleep -Seconds 10;
      $notify.Dispose();
    `.replace(/\n/g, ' ');
    execSync(`powershell -Command "${ps}"`, { stdio: 'ignore' });
  } catch {
    // Si falla la notificación visual, al menos lo imprime
  }
  console.log(`[${new Date().toISOString()}] ⚠️  ${title}: ${message}`);
}

async function main() {
  const lookup = await dns.resolve4(HOSTNAME);
  const current = lookup.sort();

  let previous = [];
  if (fs.existsSync(STATE_FILE)) {
    previous = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).sort();
  }

  const added   = current.filter(ip => !previous.includes(ip));
  const removed = previous.filter(ip => !current.includes(ip));
  const changed = added.length > 0 || removed.length > 0;

  if (changed) {
    const msg = [
      removed.length ? `Eliminadas: ${removed.join(', ')}` : '',
      added.length   ? `Nuevas: ${added.join(', ')}` : '',
    ].filter(Boolean).join(' | ');

    notify('IPs de Groq cambiaron', msg);
    console.log('Actualiza el split tunneling de ProtonVPN con las nuevas IPs:');
    current.forEach(ip => console.log(`  + ${ip}`));
  } else {
    console.log(`[${new Date().toISOString()}] ✅ Sin cambios: ${current.join(', ')}`);
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(current));
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
