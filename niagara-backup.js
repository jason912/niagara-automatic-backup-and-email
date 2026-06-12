#!/usr/bin/env node
/**
 * Niagara Station Auto Backup
 * 
 * SCRAM-SHA-256 auth → download .dist → NAS archive → email delivery
 * Supports Niagara 4.10+ (including JACE-8000)
 * 
 * Configuration: Copy .env.example to .env and fill in your values.
 * 
 * Usage:
 *   node niagara-backup.js                   # Full flow
 *   node niagara-backup.js --no-email        # Skip email
 *   node niagara-backup.js --dir ./backups   # Custom dir
 *   node niagara-backup.js --dry-run         # Auth test only
 *   node niagara-backup.js --verbose         # Detailed logs
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Config Loader ────────────────────────────────────────────────────
function loadConfig() {
  const envPath = path.join(__dirname, '.env');
  const env = {};

  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const eq = trimmed.indexOf('=');
      const key = trimmed.substring(0, eq).trim();
      const val = trimmed.substring(eq + 1).trim();
      env[key] = val;
    }
  }

  return {
    host:     process.env.STATION_HOST || env.STATION_HOST,
    port:     parseInt(process.env.STATION_PORT || env.STATION_PORT || '80'),
    ssl:      (process.env.STATION_SSL || env.STATION_SSL || 'false') === 'true',
    user:     process.env.STATION_USER || env.STATION_USER,
    pass:     process.env.STATION_PASS || env.STATION_PASS,
    name:     process.env.STATION_NAME || env.STATION_NAME || 'Niagara_Station',
    email: {
      user: process.env.EMAIL_USER || env.EMAIL_USER,
      pass: process.env.EMAIL_PASS || env.EMAIL_PASS,
      host: process.env.EMAIL_HOST || env.EMAIL_HOST || 'smtp.exmail.qq.com',
      port: parseInt(process.env.EMAIL_PORT || env.EMAIL_PORT || '465'),
      to:   process.env.EMAIL_TO   || env.EMAIL_TO,
    },
    nasPath:  process.env.NAS_PATH  || env.NAS_PATH,
    saveDir:  process.env.SAVE_DIR  || env.SAVE_DIR  || path.join(__dirname, 'backups'),
  };
}

// ─── Cookie Jar ────────────────────────────────────────────────────────
const jar = [];

// ─── HTTP Request ──────────────────────────────────────────────────────
function request(station, urlPath, method = 'GET', headers = {}, body, noFollow) {
  return new Promise((resolve, reject) => {
    const proto = station.ssl ? https : http;
    const opts = {
      hostname: station.host, port: station.port, path: urlPath, method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...headers,
        'Cookie': jar.join('; ')
      },
      timeout: 300000
    };
    const r = proto.request(opts, (res) => {
      const sc = res.headers['set-cookie'] || [];
      for (const c of sc) {
        const val = c.split(';')[0];
        const name = val.split('=')[0];
        const idx = jar.findIndex(j => j.startsWith(name + '='));
        if (idx >= 0) jar[idx] = val;
        else jar.push(val);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const resp = { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) };
        if (resp.status >= 300 && resp.status < 400 && !noFollow) {
          const loc = resp.headers['location'] || '';
          if (loc) {
            const u = new URL(loc, `${station.ssl ? 'https' : 'http'}://${station.host}:${station.port}`);
            return request(station, u.pathname + u.search, 'GET', {}, null, true).then(resolve).catch(reject);
          }
        }
        resolve(resp);
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('Request timeout')); });
    if (body) r.write(body);
    r.end();
  });
}

// ─── SCRAM Helpers ────────────────────────────────────────────────────
function randomNonce() {
  return crypto.randomBytes(16).toString('base64').replace(/[=+/]/g, '');
}

function usernamePrep(u) {
  return u.replace(/=/g, '=3D').replace(/,/g, '=2C');
}

// ─── SCRAM-SHA-256 3-Step Auth (N4.10 AJAX compatible) ──────────────
async function scramLogin(station) {
  console.log('[1] POST /prelogin...');
  await request(station, '/prelogin', 'POST', {
    'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8'
  }, 'j_username=' + encodeURIComponent(station.user));

  const nonce = randomNonce();
  const cBare = 'n=' + usernamePrep(station.user) + ',r=' + nonce;
  const cFirst = 'n,,' + cBare;

  // Step 1: Send client-first-message
  const body1 = 'action=sendClientFirstMessage&clientFirstMessage=' + cFirst;
  let r = await request(station, '/j_security_check/', 'POST', {
    'Content-Type': 'application/x-niagara-login-support',
    'Content-Length': Buffer.byteLength(body1)
  }, body1);

  const resp1 = r.body.toString().trim();
  if (!resp1.includes('r=') || !resp1.includes('s=')) {
    throw new Error('SCRAM step 1 failed: ' + resp1);
  }

  // Parse server response: r=...,s=...,i=...
  const srv = {};
  resp1.split(',').forEach(p => {
    const eq = p.indexOf('=');
    if (eq > 0) srv[p[0]] = p.substring(eq + 1);
  });

  const iterations = parseInt(srv.i);
  const salt = Buffer.from(srv.s, 'base64');

  // Compute SCRAM proof
  const saltedPassword = crypto.pbkdf2Sync(station.pass, salt, iterations, 32, 'sha256');
  const clientKey = crypto.createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = crypto.createHash('sha256').update(clientKey).digest();
  const authMessage = cBare + ',' + resp1 + ',c=biws,r=' + srv.r;
  const clientSignature = crypto.createHmac('sha256', storedKey).update(Buffer.from(authMessage, 'utf8')).digest();
  const clientProof = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) clientProof[i] = clientKey[i] ^ clientSignature[i];
  const cFinal = 'c=biws,r=' + srv.r + ',p=' + Buffer.from(clientProof).toString('base64');

  // Step 2: Send client-final-message
  const body2 = 'action=sendClientFinalMessage&clientFinalMessage=' + cFinal;
  r = await request(station, '/j_security_check/', 'POST', {
    'Content-Type': 'application/x-niagara-login-support',
    'Content-Length': Buffer.byteLength(body2)
  }, body2);

  const resp2 = r.body.toString().trim();
  if (!resp2.includes('v=')) throw new Error('SCRAM step 2 failed: ' + resp2);

  // Step 3: Get final session cookie
  r = await request(station, '/j_security_check/', 'GET');

  if (!jar.some(c => c.startsWith('niagara_userid='))) {
    throw new Error('Login failed - no user cookie');
  }

  console.log('  ✅ Authenticated');
}

// ─── Backup Download ──────────────────────────────────────────────────
async function downloadBackup(station, saveDir) {
  console.log('[2] Fetching BackupService...');
  let r = await request(station, '/ord?station:|slot:/Services/BackupService', 'GET');
  const html = r.body.toString();

  // Extract CSRF token
  let csrf = '';
  const m1 = html.match(/csrfToken=([A-Za-z0-9_\-+/=]+)/);
  if (m1) csrf = m1[1];
  const m2 = html.match(/value=['"]([A-Za-z0-9_\-+/=]{40,})['"]/);
  if (!csrf && m2) csrf = m2[1];
  if (!csrf) throw new Error('CSRF token not found');

  console.log('[3] Triggering backup (may take 1-3 min)...');
  const bUrl = '/ord?station:%7Cslot:/Services/BackupService%7Cview:backup:BackupManager' +
    '?startBackup=true;fullScreen=true;csrfToken=' + encodeURIComponent(csrf);

  r = await request(station, bUrl, 'GET');

  if (r.body.length < 50000) {
    throw new Error('Unexpected response: ' + r.body.length + ' bytes');
  }

  // Extract filename from Content-Disposition
  const cd = r.headers['content-disposition'] || '';
  const fnMatch = cd.match(/filename[=:]\s*"?([^";\n]+)"?/i);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').substring(0, 19);
  const filename = fnMatch
    ? fnMatch[1].replace(/['"]/g, '').trim()
    : `backup_${station.name}_${ts}.dist`;

  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
  const fpath = path.join(saveDir, filename);
  fs.writeFileSync(fpath, r.body);

  const mb = (r.body.length / 1024 / 1024).toFixed(1);
  console.log(`  ✅ Saved: ${filename} (${mb} MB)`);

  return { fpath, filename, data: r.body, size: r.body.length };
}

// ─── NAS Storage ──────────────────────────────────────────────────────
async function saveToNAS(fpath, nasPath) {
  if (!nasPath) { console.log('  ⏭️ NAS not configured, skipped'); return false; }
  try {
    if (!fs.existsSync(nasPath)) fs.mkdirSync(nasPath, { recursive: true });
    const dest = path.join(nasPath, path.basename(fpath));
    fs.copyFileSync(fpath, dest);
    console.log('  ✅ NAS: ' + dest);
    return true;
  } catch (e) {
    console.log('  ⚠️  NAS unavailable: ' + e.message);
    return false;
  }
}

// ─── Email Sending ────────────────────────────────────────────────────
async function sendEmail(filename, data, size, emailConfig) {
  if (!emailConfig.user || !emailConfig.pass) {
    console.log('  ⏭️ Email not configured, skipped');
    return false;
  }
  try {
    const nm = require('nodemailer');
    const t = nm.createTransport({
      host: emailConfig.host,
      port: emailConfig.port,
      secure: emailConfig.port === 465,
      auth: { user: emailConfig.user, pass: emailConfig.pass }
    });
    const mb = (size / 1024 / 1024).toFixed(1);
    await t.sendMail({
      from: emailConfig.user,
      to: emailConfig.to || emailConfig.user,
      subject: `Niagara Backup - ${filename}`,
      text: [
        `Station: ${process.env.STATION_NAME || 'Niagara Station'}`,
        `File: ${filename}`,
        `Size: ${mb} MB (${size} bytes)`,
        `Time: ${new Date().toISOString()}`,
      ].join('\n'),
      attachments: [{ filename, content: data }]
    });
    console.log('  ✅ Email sent');
    return true;
  } catch (e) {
    console.log('  ❌ Email failed: ' + e.message);
    return false;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
  const config = loadConfig();
  const args = process.argv.slice(2);
  const noEmail = args.includes('--no-email');
  const dryRun = args.includes('--dry-run');
  const saveDir = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : config.saveDir;

  // Validate config
  if (!config.host || !config.user || !config.pass) {
    console.error('❌ Missing configuration. Copy .env.example to .env and fill in your values.');
    console.error('   Or set environment variables: STATION_HOST, STATION_USER, STATION_PASS');
    process.exit(1);
  }

  const station = {
    host: config.host, port: config.port, ssl: config.ssl,
    user: config.user, pass: config.pass, name: config.name
  };

  console.log('\n═══════════════════════════════════════');
  console.log(`  ${config.name} @ ${config.host}:${config.port}`);
  if (dryRun) console.log('  🔍 DRY RUN (auth test only)');
  console.log('═══════════════════════════════════════\n');

  const start = Date.now();

  try {
    await scramLogin(station);
    if (dryRun) { console.log('\n✅ Auth OK!'); return; }

    const backup = await downloadBackup(station, saveDir);
    await saveToNAS(backup.fpath, config.nasPath);

    if (!noEmail) {
      await sendEmail(backup.filename, backup.data, backup.size, config.email);
    }

    const secs = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n✅ Done (${secs}s)`);

  } catch (e) {
    console.error(`\n❌ ${e.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { scramLogin, downloadBackup, saveToNAS, sendEmail };
