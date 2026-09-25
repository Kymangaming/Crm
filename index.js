const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'change-this-to-a-long-random-string-please-1234567890';
const AUTH_DIR = path.join(__dirname, 'auth_session');

let sock = null;
let qrDataUrl = null;
let isConnected = false;
let isConnecting = false;

function requireKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (key !== API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

async function connectToWhatsApp() {
  if (isConnecting || isConnected) return;
  isConnecting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      browser: ['Nova CRM', 'Chrome', '1.0.0'],
      generateHighQualityLinkPreview: false
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 1 });
        console.log('[WA] QR generated');
      }
      if (connection === 'open') {
        isConnected = true;
        isConnecting = false;
        qrDataUrl = null;
        console.log('[WA] Connected to WhatsApp');
      }
      if (connection === 'close') {
        isConnected = false;
        isConnecting = false;
        const code = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output?.statusCode : null;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        if (shouldReconnect) setTimeout(connectToWhatsApp, 3000);
        else { try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch(e){} }
      }
    });
  } catch(e) {
    console.error('[WA] Connect error:', e.message);
    isConnecting = false;
    setTimeout(connectToWhatsApp, 5000);
  }
}

if (fs.existsSync(AUTH_DIR) && fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
  connectToWhatsApp();
}

app.get('/', (req, res) => res.json({ connected: isConnected, hasQr: !!qrDataUrl }));
app.get('/status', requireKey, (req, res) => res.json({ connected: isConnected, connecting: isConnecting, qr: qrDataUrl }));
app.post('/connect', requireKey, async (req, res) => {
  if (isConnected) return res.json({ connected: true });
  if (isConnecting) return res.json({ connecting: true });
  connectToWhatsApp();
  for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 500)); if (qrDataUrl || isConnected) break; }
  res.json({ connected: isConnected, qr: qrDataUrl });
});
app.post('/disconnect', requireKey, async (req, res) => {
  try { if (sock) { try { await sock.logout(); } catch(e){} } } catch(e){}
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch(e){}
  isConnected = false; qrDataUrl = null; sock = null;
  res.json({ ok: true });
});
app.post('/send', requireKey, async (req, res) => {
  try {
    if (!isConnected || !sock) return res.status(503).json({ error: 'WhatsApp not connected' });
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
    let num = String(phone).replace(/[^0-9]/g, '');
    if (num.startsWith('0')) num = '98' + num.substring(1);
    if (!num.startsWith('98') && num.length === 10) num = '98' + num;
    const jid = num + '@s.whatsapp.net';
    await sock.sendMessage(jid, { text: message });
    res.json({ ok: true, to: num });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`[WA] Gateway running on port ${PORT}`);
});
