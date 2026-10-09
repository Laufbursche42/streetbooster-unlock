'use strict';
/*
 * STREETBOOSTER Tuning - Web Bluetooth. Implements the BLE protocol proven from
 * com.zydtech.streetbooster.enduser (ZYD Technology / Hobbywing controller engine, com.zydtech.library.core.BleCore).
 * Proven (app_side, code-verified from classes2.dex): UUIDs (DATA_SERVICE 0xF1F0, write 0xF1F1, notify 0xF1F2),
 * CRC16/MODBUS framing, the READ frame (cmd 0x03), the RW-param WRITE frame (cmd 0x17) used for all tuning
 * registers incl. register 32 = speed limit (KPH*10, 0..60), and the 10-byte 0xAB monitor frame that carries
 * the live lock bit + status bits + per-gear speed limits. Telemetry decoded from the inbound 0xAB stream.
 * No session auth: writes carry only CRC16, no nonce/token (an optional cleartext AT+PWD exists but is not
 * sent here). Device_side UNKNOWN (needs on-device/HCI test): whether firmware honors a write, the exact
 * reply/ack framing, whether it streams 0xAB without a trigger, and whether it accepts a limit above eKFV.
 * Writes are gated, the risky ones confirm-boxed; an echo only means "accepted", live telemetry proves effect.
 */

// Pre-commit cache-buster auto-bumps BUILD and every ?v= on any web-asset change.
const BUILD = 'v7';

// =========================================================================================
//  VERIFIED PROTOCOL CORE (code-proven from com.zydtech.library.core.BleCore; self-test below runs at load)
// =========================================================================================
// --------------------------- UUIDs (Constant.java:46-51; Web Bluetooth wants lowercase) ---------------------------
const U = {
  DATA: '0000f1f0-0000-1000-8000-00805f9b34fb',   // DATA_SERVICE - primary; all data/control/telemetry I/O (BleCore.java:398)
  TX:   '0000f1f1-0000-1000-8000-00805f9b34fb',   // DATA_TX - write (setUuidWriteCha)
  RX:   '0000f1f2-0000-1000-8000-00805f9b34fb',   // DATA_RX - notify (setUuidNotifyCha)
  CMD:  '0000f2f0-0000-1000-8000-00805f9b34fb'    // CMD_SERVICE - declared extra service, not used for I/O by the lib
};
const CANDIDATE_SERVICES = [U.DATA, U.CMD];   // one generic ZYD/Hobbywing profile; list keeps the connect probe fleet-shaped

// --------------------------- helpers ---------------------------
const $ = (id) => document.getElementById(id);
const hex = (arr) => Array.from(arr, b => (b & 0xff).toString(16).padStart(2, '0').toUpperCase()).join(' ');
const short = (u) => String(u).slice(0, 8).toUpperCase();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const LS = { THEME: 'streetbooster_theme', OPEN: 'streetbooster_open', EKFV: 'streetbooster_ekfv', PUBLOG: 'streetbooster_publog', DEV: 'streetbooster_device' };

let dev = null, server = null, chWrite = null, chNotify = null, busy = false;
let connected = false;
let keepTimer = null;
let pendingDeepAction = null;   // 'unlock' | 'lock' from a ?do= shortcut

// live device state, rebuilt from the push frames (the command builders read from this)
const S = {
  gear: null, battPct: null, speed: null, voltage: null, current: null, power: null,
  escTemp: null, motorTemp: null, trip: null, odo: null, fault: null,
  lock: null, light: null, cruise: null, unitMi: null, bootMode: null, atmosphere: null,
  limitCruise: null, limitMode1: null, limitMode2: null, limitMode3: null, speedLimit: null
};
function resetState() { for (const k of Object.keys(S)) S[k] = null; }

// CRC16/MODBUS (poly 0xA001 reflected, init 0xFFFF; CRC16.java:45-48). Returns [lo, hi] = trailer order.
function crc16(bytes) {
  let crc = 0xFFFF;
  for (const b of bytes) {
    crc ^= (b & 0xff);
    for (let i = 0; i < 8; i++) { crc = (crc & 1) ? ((crc >>> 1) ^ 0xA001) : (crc >>> 1); }
  }
  return [crc & 0xff, (crc >>> 8) & 0xff];
}
// READ frame 8B: [0x01 HEAD_ESC][0x03 CMD_READ][addrHi][addrLo][cntHi][cntLo][crcLo][crcHi], CRC over 0-5 (BleCore.java:1522-1533)
function buildRead(addr, count) {
  const core = [0x01, 0x03, (addr >> 8) & 0xff, addr & 0xff, (count >> 8) & 0xff, count & 0xff];
  return [...core, ...crc16(core)];
}
// RW-param WRITE frame (cmd 0x17), one 16-bit register: doubled addr/count + nLo=2 + value, CRC over all but last 2 (BleCore.java:1580-1599)
function buildWriteReg(addr, value16) {
  const ah = (addr >> 8) & 0xff, al = addr & 0xff;
  const vh = (value16 >> 8) & 0xff, vl = value16 & 0xff;
  const core = [0x01, 0x17, ah, al, 0x00, 0x01, ah, al, 0x00, 0x01, 0x02, vh, vl];
  return [...core, ...crc16(core)];
}
// MONITOR/live-control 10B: [0xAB][0x00][0x0A][statusByte][limitCruise][limitMode1][limitMode2][limitMode3][crcLo][crcHi], CRC over 0-7 (BleCore.java:1407-1418)
// statusByte bits (BleCore.java:854): b7=lock b6=metric/imperial b5=bootMode(zero-start) b4=cruise b3=atmosphere b2=headlight b1:b0=gear.
// The limit bytes (per-gear km/h) carry the live speed caps, so a monitor write MUST preserve them - rebuilt from the last echo, fallback 25 (eKFV).
function buildMonitorFrame(over) {
  let st = 0;
  if (pick(over, 'lock', S.lock)) st |= 0x80;
  if (pick(over, 'unitMi', S.unitMi)) st |= 0x40;
  if (pick(over, 'bootMode', S.bootMode)) st |= 0x20;
  if (pick(over, 'cruise', S.cruise)) st |= 0x10;
  if (pick(over, 'atmosphere', S.atmosphere)) st |= 0x08;
  if (pick(over, 'light', S.light)) st |= 0x04;
  st |= (pick(over, 'gear', S.gear != null ? S.gear : 0) & 0x03);
  const lc = pick(over, 'limitCruise', S.limitCruise != null ? S.limitCruise : 25) & 0xff;
  const l1 = pick(over, 'limitMode1', S.limitMode1 != null ? S.limitMode1 : 25) & 0xff;
  const l2 = pick(over, 'limitMode2', S.limitMode2 != null ? S.limitMode2 : 25) & 0xff;
  const l3 = pick(over, 'limitMode3', S.limitMode3 != null ? S.limitMode3 : 25) & 0xff;
  const core = [0xAB, 0x00, 0x0A, st, lc, l1, l2, l3];
  return [...core, ...crc16(core)];
}
const KEEPALIVE = [0xA5, 0x02, 0xFD, 0x5A];   // monitor keep-alive to solicit the telemetry stream (BleCore.java:1484)
function pick(o, k, dflt) { return (o && o[k] != null) ? o[k] : (dflt == null ? false : dflt); }

// speed limit register 32 (限速值, KPH, opv=10, 0..60) via 0x17, then commit by writing register 73 (BleCore.java:1014/1084; default_parameter.json no:10 addr:32)
const REG_SPEED = 32, REG_COMMIT = 73, SPEED_OPV = 10, SPEED_MAX_KMH = 60;

// strict validator for OUR built frames: head ok, length ok, CRC16/MODBUS trailer matches
function validFrame(f) {
  if (!Array.isArray(f) || f.length < 4) return false;
  const [lo, hi] = crc16(f.slice(0, f.length - 2));
  return f[f.length - 2] === lo && f[f.length - 1] === hi;
}

// RX decode helpers (big-endian; current is signed 16-bit)
const be16 = (b, i) => ((b[i] & 0xff) << 8) | (b[i + 1] & 0xff);
const s16 = (v) => v >= 0x8000 ? v - 0x10000 : v;
const u24 = (b, i) => ((b[i] & 0xff) << 16) | ((b[i + 1] & 0xff) << 8) | (b[i + 2] & 0xff);
const bit = (w, n) => ((w >> n) & 1) === 1;

// inbound 0xAB sub0 telemetry decode (BleCore.java:2302-2334). Needs >= 23 bytes.
function parseTelemetry(b) {
  if (b.length < 23) return;
  S.gear = b[4] & 0xff;
  S.battPct = b[5] & 0xff;
  S.speed = +(Math.max(be16(b, 6), be16(b, 8)) / 1000).toFixed(1);
  S.voltage = +(be16(b, 10) / 10).toFixed(1);
  S.current = +(s16(be16(b, 12)) / 64).toFixed(2);
  S.escTemp = b[14] & 0xff;
  S.motorTemp = b[15] & 0xff;
  S.trip = +(be16(b, 16) / 10).toFixed(1);
  S.odo = +(u24(b, 18) / 10).toFixed(1);
  const fb = b.slice(2, 21).some(x => (x & 0xff) !== 0);
  S.fault = fb ? hex(b.slice(2, 21)) : 0;
  S.power = +(S.voltage * S.current).toFixed(0);
  // registerZero (addr 0) status word, big-endian u16 at offset 21 (BleCore.java:2320-2334; default_parameter.json addr0)
  const rz = be16(b, 21);
  S.light = bit(rz, 2); S.bootMode = bit(rz, 5); S.unitMi = bit(rz, 6);
  S.cruise = bit(rz, 9); S.lock = bit(rz, 11); S.atmosphere = bit(rz, 15);
}
// inbound 0xAB sub1 echo: per-gear live speed limits (BleCore.java:2342-2357)
function parseLimitEcho(b) {
  if (b.length < 7) return;
  S.limitCruise = b[3] & 0xff; S.limitMode1 = b[4] & 0xff; S.limitMode2 = b[5] & 0xff; S.limitMode3 = b[6] & 0xff;
  S.speedLimit = Math.max(S.limitMode1, S.limitMode2, S.limitMode3);   // top-gear live cap = effective limit
}

// load-time self-test: builders must match hand-computed CRC16/MODBUS vectors, every built frame must re-validate
const FRAME_OK = (function () {
  const eq = (a, b) => a.length === b.length && a.every((v, i) => (v & 0xff) === (b[i] & 0xff));
  const t1 = eq(buildRead(REG_SPEED, 1), [0x01, 0x03, 0x00, 0x20, 0x00, 0x01, 0x85, 0xc0]);
  const t2 = eq(buildWriteReg(REG_SPEED, 250), [0x01, 0x17, 0x00, 0x20, 0x00, 0x01, 0x00, 0x20, 0x00, 0x01, 0x02, 0x00, 0xfa, 0xd2, 0xe7]);
  const t3 = eq(buildMonitorFrame({ lock: true }), [0xab, 0x00, 0x0a, 0x80, 0x19, 0x19, 0x19, 0x19, 0x16, 0x75]);
  return t1 && t2 && t3 && validFrame(buildWriteReg(REG_SPEED, 200)) && validFrame(buildMonitorFrame({ light: true })) && validFrame(buildRead(0, 1));
})();

// --------------------------- log (eg-unlock redaction pipeline: scrub secrets + anonymize PII) ---------------------------
let logBuffer = [];   // { raw, cls }
let publicLog = true; // anonymize device name/id/MAC on display/copy/save (default on)
let diag = false;     // verbose diagnostics (default off)
function redact(text) {
  let s = String(text);
  if (dev && dev.id) s = s.split(dev.id).join('[redacted-id]');
  s = s.replace(/\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, '[redacted-mac]');
  s = s.replace(/\b(secret|token|key|aes|pwd|password|pin|mac|serial|vin|uid|imei)\b(\s*[:=]\s*)("?)([^\s",]+)\3/gi,
    (m, k, sep) => k + sep + '[redacted]');
  s = s.replace(/\b[0-9A-Fa-f]{16,}\b/g, '[redacted-hex]');
  return s;
}
// Unconditional secret scrubber, runs at the source before the buffer (independent of the Public Log toggle).
function maskSecrets(text) {
  let s = String(text);
  s = s.replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '[redacted-jwt]');
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***');
  s = s.replace(/\b(access[_-]?token|refresh[_-]?token|token|jwt|password|passwd|pwd|secret|code|otp)\b(\s*[:=]\s*)("?)([^\s",}]+)\3/gi,
    (m, k, sep) => k + sep + '***');
  return s;
}
function anonymize(s) {
  if (!publicLog) return String(s).replace(/\x01/g, '');
  return redact(String(s).replace(/\x01[^\x01]*\x01/g, 'XX').replace(/\x01/g, ''));
}
function logLine(cls, text) {
  const safe = '[' + new Date().toTimeString().slice(0, 8) + '] ' + maskSecrets(text);
  logBuffer.push({ raw: safe, cls: cls });
  const el = $('log'); if (!el) return;
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = anonymize(safe) + '\n';
  el.appendChild(span); el.scrollTop = el.scrollHeight;
}
function renderLog() {
  const el = $('log'); if (!el) return;
  el.textContent = '';
  for (const e of logBuffer) { const span = document.createElement('span'); if (e.cls) span.className = e.cls; span.textContent = anonymize(e.raw) + '\n'; el.appendChild(span); }
  el.scrollTop = el.scrollHeight;
}
function logText() { return logBuffer.map(e => anonymize(e.raw)).join('\n'); }
const logTx = (b) => logLine('log-tx', '>>> ' + short(U.TX) + ' | ' + hex(b));
const logRx = (b) => logLine('log-rx', '<<< ' + short(U.RX) + ' | ' + hex(b));
const logSys = (t) => logLine('', '--- ' + t);
const logErr = (t) => logLine('log-err', '!!! ' + t);
const logDiag = (t) => { if (diag) logLine('', '... ' + t); };
// CRLF on Windows so the copied log pastes cleanly into Notepad (nv osNewline polish).
function osNewline() { return (navigator.platform || '').toLowerCase().indexOf('win') === 0 ? '\r\n' : '\n'; }
function saveLog() {
  try {
    const blob = new Blob([logText().split('\n').join(osNewline())], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'laufbursche42-streetbooster-log.txt';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    logSys('log saved');
  } catch (e) { logErr('save failed: ' + (e && e.message ? e.message : e)); }
}
function logDiagnosticHeader() {
  logLine('', '=== streetbooster-unlock diagnostic ===');
  logLine('', 'build: ' + BUILD);
  logLine('', 'time: ' + new Date().toISOString());
  logLine('', 'userAgent: ' + (navigator.userAgent || '?'));
  logLine('', 'platform: ' + (navigator.platform || '?'));
  logLine('', 'webBluetooth: ' + (navigator.bluetooth ? 'yes' : 'no'));
  logLine('', 'protocol self-test: ' + (FRAME_OK ? 'OK' : 'FAILED'));
  logLine('', '================================');
}

// --------------------------- tiles ---------------------------
const TILE_IDS = ['t-speedlimit', 't-speed', 't-gear', 't-batt', 't-volt', 't-current', 't-power', 't-esctemp',
  't-motortemp', 't-trip', 't-odo', 't-fault', 't-lock', 't-light', 't-cruise', 't-unit', 't-boot', 't-atmo'];
function setTile(id, val) { const el = $(id); if (el) el.textContent = (val == null ? '-' : val); }
function resetTiles() { TILE_IDS.forEach(id => setTile(id, null)); }
function onOff(v) { return v == null ? null : (v ? t('valOn') : t('valOff')); }
function refreshTiles() {
  setTile('t-speedlimit', S.speedLimit == null ? null : S.speedLimit + ' km/h');
  setTile('t-speed', S.speed == null ? null : S.speed + ' km/h');
  setTile('t-gear', S.gear == null ? null : String(S.gear));
  setTile('t-batt', S.battPct == null ? null : S.battPct + ' %');
  setTile('t-volt', S.voltage == null ? null : S.voltage + ' V');
  setTile('t-current', S.current == null ? null : S.current + ' A');
  setTile('t-power', S.power == null ? null : S.power + ' W');
  setTile('t-esctemp', S.escTemp == null ? null : S.escTemp + ' °C');
  setTile('t-motortemp', S.motorTemp == null ? null : S.motorTemp + ' °C');
  setTile('t-trip', S.trip == null ? null : S.trip + ' km');
  setTile('t-odo', S.odo == null ? null : S.odo + ' km');
  setTile('t-fault', S.fault == null ? null : (S.fault === 0 ? t('valNone') : S.fault));
  setTile('t-lock', S.lock == null ? null : (S.lock ? t('valLocked') : t('valOpen')));
  setTile('t-light', onOff(S.light));
  setTile('t-cruise', onOff(S.cruise));
  setTile('t-unit', S.unitMi == null ? null : (S.unitMi ? 'mi' : 'km'));
  setTile('t-boot', S.bootMode == null ? null : (S.bootMode ? t('bootZero') : t('bootKick')));
  setTile('t-atmo', onOff(S.atmosphere));
}

// --------------------------- i18n ---------------------------
let lang = 'de';
function table() { return (window.I18N && window.I18N[lang]) || {}; }
function t(key) { const v = table()[key]; return (typeof v === 'string') ? v : ''; }
function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-t]').forEach(n => { const v = t(n.getAttribute('data-t')); if (/[<&]/.test(v)) n.innerHTML = v; else n.textContent = v; }); // scan-ok: curated i18n values with markup (banner/disclaimer links); own table, not user input
  document.querySelectorAll('[data-t-ph]').forEach(n => { const v = t(n.getAttribute('data-t-ph')); if (v) n.setAttribute('placeholder', v); });
  ['GUIDE', 'README', 'LICENSE', 'PRIVACY', 'TRADEMARKS'].forEach(name => { const el = $('link-' + name.toLowerCase()); if (el) el.href = docFile(name); });
  { const el = $('langs'); if (el) el.setAttribute('aria-label', t('langGroup')); }
  { const el = $('build-ver'); if (el) el.textContent = t('buildLabel') + ' ' + BUILD; }
  document.querySelectorAll('#langs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
  refreshTiles(); syncSettings(); updateSpeedUI();
  { const el = $('status'); setStatus(el ? el.dataset.state : 'disconnected'); }
  { const dark = document.documentElement.getAttribute('data-theme') !== 'light'; const el = $('btn-theme'); if (el) { el.setAttribute('aria-label', t(dark ? 'themeToLight' : 'themeToDark')); el.title = el.getAttribute('aria-label'); } }
}
function initLangSwitch() { document.querySelectorAll('#langs button').forEach(b => b.addEventListener('click', () => { lang = b.dataset.lang; applyLang(); })); }

// --------------------------- theme ---------------------------
function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const b = $('btn-theme');
  if (b) { b.textContent = dark ? '\u2600' : '\u263E'; b.setAttribute('aria-label', t(dark ? 'themeToLight' : 'themeToDark')); b.title = b.getAttribute('aria-label'); }
  try { localStorage.setItem(LS.THEME, dark ? 'dark' : 'light'); } catch (e) {}
}
function initTheme() {
  let saved = null; try { saved = localStorage.getItem(LS.THEME); } catch (e) {}
  applyTheme(saved !== 'light');
  const b = $('btn-theme'); if (b) b.addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') === 'light'));
}

// --------------------------- status ---------------------------
function statusLabel(s) {
  const map = { disconnected: 'stDisconnected', connecting: 'stConnecting', linking: 'stLinking', connected: 'stConnected', 'no-service': 'stNoService' };
  return t(map[s] || 'stDisconnected') || s;
}
function setStatus(s) {
  const el = $('status'); if (el) { el.dataset.state = s; el.textContent = statusLabel(s); }
  const cb = $('btn-conn');
  if (cb) { const on = (s === 'connecting' || s === 'linking' || s === 'connected'); cb.textContent = on ? t('btnDisconnect') : t('btnConnect'); cb.dataset.act = on ? 'disconnect' : 'connect'; }
}
function setControlsEnabled(on) {
  // cards hidden until connected (header/intro/connect/shortcut/log stay visible)
  ['live-card', 'batt-card', 'more-card', 'raw-card'].forEach(id => { const el = $(id); if (el) el.hidden = !on; });
  document.querySelectorAll('[data-conn]').forEach(e => { e.disabled = !on; });
}

// --------------------------- connect (acceptAll + GATT service is the real gate; 4x retry) ---------------------------
async function connect() {
  if (!navigator.bluetooth) { logErr(t('errNoWebBt')); return; }
  try {
    setStatus('connecting');
    const showAll = ($('showall') || {}).checked;
    const opts = showAll
      ? { acceptAllDevices: true, optionalServices: CANDIDATE_SERVICES }
      : { filters: [{ services: [U.DATA] }], optionalServices: CANDIDATE_SERVICES };
    dev = await navigator.bluetooth.requestDevice(opts);
    dev.addEventListener('gattserverdisconnected', onDisconnected);
    try { localStorage.setItem(LS.DEV, dev.id); } catch (e) {}
    logSys('device: \x01' + (dev.name || '(no name)') + '\x01');
    setStatus('linking');
    await connectGatt();
    setStatus('connected'); connected = true;
    setControlsEnabled(true);
    { const el = $('devinfo'); if (el) el.textContent = t('devPrefix') + ' \x01' + (dev.name || 'STREETBOOSTER') + '\x01'; }
    logSys('connected, subscribed to ' + short(U.RX));
    startKeepAlive();
    await maybeRunDeepAction();
  } catch (e) {
    logErr('connect failed: ' + (e && e.message ? e.message : e));
    connected = false; setStatus('disconnected'); setControlsEnabled(false);
  }
}
// tolerate the Android discovery race (nv 4x retry): service can be briefly absent right after link.
async function connectGatt() {
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      server = await dev.gatt.connect();
      const svc = await resolveService(server);
      if (!svc) { setStatus('no-service'); throw new Error('STREETBOOSTER service ' + short(U.DATA) + ' not found'); }
      chWrite = await svc.getCharacteristic(U.TX);
      chNotify = await svc.getCharacteristic(U.RX);
      await chNotify.startNotifications();
      chNotify.addEventListener('characteristicvaluechanged', onCharValue);
      return;
    } catch (e) {
      lastErr = e; logDiag('connect attempt ' + attempt + ' failed: ' + (e && e.message ? e.message : e));
      try { if (dev.gatt.connected) dev.gatt.disconnect(); } catch (_) {}
      await sleep(400);
    }
  }
  throw lastErr || new Error('gatt connect failed');
}
async function resolveService(srv) {
  for (const uuid of CANDIDATE_SERVICES) { try { return await srv.getPrimaryService(uuid); } catch (_) {} }
  return null;
}
function onDisconnected() {
  connected = false; chWrite = null; chNotify = null; stopKeepAlive(); setStatus('disconnected'); setControlsEnabled(false);
  resetState(); resetTiles(); clearAcks(); rxBuf = []; updateSpeedUI();
  const el = $('devinfo'); if (el) el.textContent = '';
  logSys('disconnected');
}
function disconnect() { if (dev && dev.gatt.connected) dev.gatt.disconnect(); }

// solicit the 0xAB telemetry stream with the monitor keep-alive (device_side: whether it streams unprompted is UNKNOWN)
function startKeepAlive() {
  stopKeepAlive();
  const tick = () => { if (connected && chWrite) writeRaw(KEEPALIVE).catch(() => {}); };
  tick();
  keepTimer = setInterval(tick, 2000);
}
function stopKeepAlive() { if (keepTimer) { clearInterval(keepTimer); keepTimer = null; } }

// --------------------------- notify + ACK ---------------------------
let rxBuf = [];
function onCharValue(ev) {
  const b = Array.from(new Uint8Array(ev.target.value.buffer));
  logRx(b);
  for (const x of b) rxBuf.push(x);
  // frames arrive as 0xAB telemetry (len at buf[2]) or 0x01 ESC replies; reassemble by header + declared length.
  let guardN = 0;
  while (rxBuf.length >= 4 && guardN++ < 64) {
    const head = rxBuf[0];
    if (head === 0xAB) {
      const declared = rxBuf[2] & 0xff;                 // monitor/telemetry length byte
      const total = declared >= 8 ? declared + 2 : Math.min(rxBuf.length, 25);
      if (rxBuf.length < total) break;
      const frame = rxBuf.slice(0, total); rxBuf = rxBuf.slice(total);
      handleFrame(frame);
    } else if (head === 0x01) {
      // ESC reply: exact length is firmware-defined; take the buffer we have (one notify = one reply in practice).
      const frame = rxBuf.slice(0); rxBuf = [];
      handleFrame(frame);
    } else { rxBuf.shift(); }
  }
}
function handleFrame(frame) {
  const head = frame[0];
  if (head === 0xAB) {
    const sub = frame[1] & 0xff;
    if (sub === 0x00) parseTelemetry(frame); else if (sub === 0x01) parseLimitEcho(frame);
    resolveAck('monitor');
  } else if (head === 0x01) {
    resolveAck('esc');
  }
  refreshTiles(); updateSpeedUI(); syncSettings();
}
const pendingAcks = new Map();
const ACK_TIMEOUT_MS = 3000;
function armAck(key, label) {
  clearAckTimer(key);
  const timer = setTimeout(() => { pendingAcks.delete(key); logSys(label + ': ' + t('ackNone')); }, ACK_TIMEOUT_MS);
  pendingAcks.set(key, { timer, label });
}
function resolveAck(key) { const a = pendingAcks.get(key); if (a) { clearTimeout(a.timer); pendingAcks.delete(key); logSys(a.label + ': ' + t('ackOk')); } }
function clearAckTimer(key) { const a = pendingAcks.get(key); if (a) { clearTimeout(a.timer); pendingAcks.delete(key); } }
function clearAcks() { for (const a of pendingAcks.values()) clearTimeout(a.timer); pendingAcks.clear(); }

// --------------------------- transmit (single funnel: log TX, arm ack, write) ---------------------------
async function writeRaw(bytes) {
  const arr = Uint8Array.from(bytes.map(b => b & 0xff));
  if (chWrite.properties.writeWithoutResponse) return chWrite.writeValueWithoutResponse(arr);
  if (chWrite.properties.write) return chWrite.writeValueWithResponse(arr);
  return chWrite.writeValue(arr);
}
async function transmit(bytes, label, ackKey) {
  if (!connected || !chWrite) { logErr(t('errNotConnected')); return; }
  logTx(bytes);
  if (ackKey) armAck(ackKey, label);
  try { await writeRaw(bytes); logSys(label + ': ' + t('txSent')); }
  catch (e) { clearAckTimer(ackKey); logErr(label + ' ' + t('txFailed') + ': ' + (e && e.message ? e.message : e)); }
}
// serialize writes on the characteristic (eg guard mutex; vr/ap/vmax omit it)
async function guard(fn) { if (busy) return; busy = true; try { await fn(); } catch (e) { logErr(e && e.message ? e.message : String(e)); } finally { busy = false; } }

// --------------------------- commands ---------------------------
async function setMonitor(over, label) { await transmit(buildMonitorFrame(over), label, 'monitor'); }   // lock/light/cruise/unit/boot/atmo ride the 0xAB frame
async function writeRegister(addr, value, label) { await transmit(buildWriteReg(addr, value), label, 'esc'); }
async function readRegister(addr, count) { await transmit(buildRead(addr, count || 1), t('regReadLabel') + ' 0x' + addr.toString(16), 'esc'); }
// persistent speed limit: register 32 = KPH*opv, then commit by writing register 73 (BleCore.java:1014/1084)
async function setSpeedLimit(kmh) {
  const v = Math.max(0, Math.min(SPEED_MAX_KMH, kmh | 0));
  await transmit(buildWriteReg(REG_SPEED, v * SPEED_OPV), t('speedLabel') + ' ' + v + ' km/h', 'esc');
  await sleep(150);
  await transmit(buildWriteReg(REG_COMMIT, Math.floor(Math.random() * 51)), t('speedCommit'), 'esc');
}

// --------------------------- speed card (toggle open vs eKFV, labeled from the live limit) ---------------------------
function updateSpeedUI() {
  const info = $('speed-current');
  if (info) info.textContent = (S.speedLimit == null) ? t('speedCurUnknown') : (t('speedCurPrefix') + ' ' + S.speedLimit + ' km/h');
  const b = $('btn-toggle'); if (!b) return;
  const ekfv = parseInt(($('ekfv-in') || {}).value, 10) || 20;
  const locked = (S.speedLimit == null) ? true : (S.speedLimit <= ekfv);   // unknown -> offer unlock
  b.dataset.mode = locked ? 'unlock' : 'lock';
  b.textContent = locked ? t('btnUnlock') : t('btnLock');
}

// --------------------------- settings rows (static set-rows; monitor-bit toggles + register writes) ---------------------------
// monitor-bit toggles ride the 0xAB frame (setMonitor); register rows go via the 0x17 write frame (writeRegister).
const MON_TOGGLES = [
  { sel: 'set-light',  btn: 'btn-set-light',  key: 'light',      label: 'setLight' },
  { sel: 'set-atmo',   btn: 'btn-set-atmo',   key: 'atmosphere', label: 'setAtmo' },
  { sel: 'set-unit',   btn: 'btn-set-unit',   key: 'unitMi',     label: 'setUnit' },
  { sel: 'set-cruise', btn: 'btn-set-cruise', key: 'cruise',     label: 'setCruise' },
  { sel: 'set-boot',   btn: 'btn-set-boot',   key: 'bootMode',   label: 'setBoot' }
];
// register rows: controller register address + scale (encode = round(value * scale)) + optional confirm warn key.
// Addresses and scaling are the app's own default_parameter.json values, no scaling is invented.
const REG_ROWS = [
  { inp: 'set-throttle-accel', btn: 'btn-set-throttle-accel', addr: 9,  scale: 1,    label: 'setThrottleAccel' },
  { inp: 'set-throttle-brake', btn: 'btn-set-throttle-brake', addr: 10, scale: 1,    label: 'setThrottleBrake' },
  { inp: 'set-cruise-time',    btn: 'btn-set-cruise-time',    addr: 51, scale: 1,    label: 'setCruiseTime' },
  { inp: 'set-auto-off',       btn: 'btn-set-auto-off',       addr: 52, scale: 1,    label: 'setAutoOff' },
  { inp: 'set-service-km',     btn: 'btn-set-service-km',     addr: 73, scale: 1,    label: 'setServiceKm' },
  { inp: 'set-max-mod',        btn: 'btn-set-max-mod',        addr: 2,  scale: 1,    label: 'setMaxMod',       confirm: 'warnMotor' },
  { inp: 'set-motor-poles',    btn: 'btn-set-motor-poles',    addr: 4,  scale: 1,    label: 'setMotorPoles',   confirm: 'warnMotor' },
  { inp: 'set-max-discharge',  btn: 'btn-set-max-discharge',  addr: 11, scale: 64,   label: 'setMaxDischarge', confirm: 'warnMotor' },
  { inp: 'set-max-brake',      btn: 'btn-set-max-brake',      addr: 12, scale: 64,   label: 'setMaxBrake',     confirm: 'warnMotor' },
  { inp: 'set-low-volt',       btn: 'btn-set-low-volt',       addr: 19, scale: 10,   label: 'setLowVolt',      confirm: 'warnMotor' },
  { inp: 'set-wheel',          btn: 'btn-set-wheel',          addr: 23, scale: 25.4, label: 'setWheel',        confirm: 'warnMotor' }
];
// enumerated register rows: a select whose written value is the chosen option index (no opv), via the same 0x17 write.
// carrier/PWM frequency: register 33, options [8K,10K,12K,15K,AUTO] (default_parameter.json no:12 addr:33, mode enum).
const ENUM_REGS = [
  { sel: 'set-carrier', btn: 'btn-set-carrier', addr: 33, label: 'setCarrier', confirm: 'warnMotor' }
];
// reflect the reported monitor-bit state into the toggle selects (skip the control the user is editing)
function syncSettings() {
  for (const m of MON_TOGGLES) {
    const sel = $(m.sel); if (!sel || document.activeElement === sel) continue;
    const v = S[m.key]; if (v != null) sel.value = v ? '1' : '0';
  }
  const lk = $('set-lock'); if (lk && document.activeElement !== lk && S.lock != null) lk.value = S.lock ? '1' : '0';
}
function wireSettings() {
  for (const m of MON_TOGGLES) {
    const b = $(m.btn); if (!b) continue;
    b.addEventListener('click', () => guard(async () => {
      const on = (parseInt(($(m.sel) || {}).value, 10) || 0) === 1;
      await setMonitor({ [m.key]: on }, t(m.label));
    }));
  }
  { const b = $('btn-set-lock'); if (b) b.addEventListener('click', () => guard(async () => {
      const on = (parseInt(($('set-lock') || {}).value, 10) || 0) === 1;
      if (!await confirmRisky(t(on ? 'warnLock' : 'warnUnlock'))) return;
      await setMonitor({ lock: on }, t('setLock'));
    })); }
  for (const r of REG_ROWS) {
    const b = $(r.btn); if (!b) continue;
    b.addEventListener('click', () => guard(async () => {
      const raw = parseFloat(($(r.inp) || {}).value);
      if (isNaN(raw)) { logErr(t('errBadVal')); return; }
      if (r.confirm && !await confirmRisky(t(r.confirm))) return;
      const v = Math.max(0, Math.min(0xffff, Math.round(raw * r.scale)));
      await writeRegister(r.addr, v, t(r.label) + ' (' + raw + ')');
    }));
  }
  for (const e of ENUM_REGS) {
    const b = $(e.btn); if (!b) continue;
    b.addEventListener('click', () => guard(async () => {
      const sel = $(e.sel); const idx = parseInt((sel || {}).value, 10) || 0;
      if (e.confirm && !await confirmRisky(t(e.confirm))) return;
      const opt = (sel && sel.selectedOptions && sel.selectedOptions[0]) ? sel.selectedOptions[0].textContent : idx;
      await writeRegister(e.addr, idx, t(e.label) + ' (' + opt + ')');
    }));
  }
}

// --------------------------- engine level (register read/write + raw frame + build-a-frame) ---------------------------
function hexToBytes(s) {
  const clean = String(s).replace(/[^0-9a-fA-F]/g, '');   // strip spaces/punctuation
  const out = []; for (let i = 0; i + 2 <= clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));   // pairs; drop a dangling nibble
  return out;
}
async function cmdRaw() {
  const bytes = hexToBytes(($('raw-in') || {}).value || '');
  if (!bytes.length) { logErr(t('errNoBytes')); return; }
  await transmit(bytes, t('rawLabel'));   // sent verbatim, no header/checksum added
}
async function cmdRegWrite() {
  const addr = parseInt(($('free-op') || {}).value, 16);
  if (isNaN(addr)) { logErr(t('errBadReg')); return; }
  const val = parseInt(($('free-payload') || {}).value, 10);
  if (isNaN(val)) { logErr(t('errBadVal')); return; }
  if (!await confirmRisky(t('warnRegWrite'))) return;
  await writeRegister(addr & 0xffff, val & 0xffff, t('regLabel') + ' 0x' + (addr & 0xffff).toString(16) + '=' + val);   // proper 0x17 CRC16 frame
}
async function cmdRegRead() {
  const addr = parseInt(($('free-op') || {}).value, 16);
  if (isNaN(addr)) { logErr(t('errBadReg')); return; }
  await readRegister(addr & 0xffff, 1);
}
// build-a-frame: head byte + hex body, CRC16/MODBUS appended; shows the full frame, then can send it verbatim
function buildCustomFrame() {
  const head = parseInt(($('build-head') || {}).value, 16);
  if (isNaN(head)) { logErr(t('errBadHead')); return null; }
  const core = [head & 0xff, ...hexToBytes(($('build-payload') || {}).value || '')];
  const frame = [...core, ...crc16(core)];
  const out = $('build-out'); if (out) out.value = hex(frame);
  return frame;
}
async function cmdBuildSend() { const f = buildCustomFrame(); if (f) await transmit(f, t('builtFrameLabel')); }

// --------------------------- shortcut deep-link (?do=unlock|lock) ---------------------------
function parseDeepLink() {
  const q = new URLSearchParams(location.search); let a = q.get('do');
  if (!a && location.hash) { const m = location.hash.match(/do=([a-z]+)/i); if (m) a = m[1]; }
  if (!a) return;
  a = a.toLowerCase();
  if (a === 'unlock' || a === 'fast') pendingDeepAction = 'unlock';
  else if (a === 'lock' || a === 'slow') pendingDeepAction = 'lock';
}
async function maybeRunDeepAction() {
  if (!pendingDeepAction) return;
  const act = pendingDeepAction; pendingDeepAction = null;
  if (act === 'unlock') { const v = parseInt(($('open-in') || {}).value, 10) || 30; await guard(() => setSpeedLimit(v)); }
  else { const v = parseInt(($('ekfv-in') || {}).value, 10) || 20; await guard(() => setSpeedLimit(v)); }
}
async function tryAutoReconnect() {
  if (!pendingDeepAction || !navigator.bluetooth || !navigator.bluetooth.getDevices) return;
  try {
    const list = await navigator.bluetooth.getDevices(); let saved = null; try { saved = localStorage.getItem(LS.DEV); } catch (e) {}
    const d = list.find(x => x.id === saved) || list[0]; if (!d) return;
    dev = d; dev.addEventListener('gattserverdisconnected', onDisconnected);
    setStatus('linking'); await connectGatt(); setStatus('connected'); connected = true; setControlsEnabled(true);
    startKeepAlive(); logSys('auto-reconnect (shortcut)'); await maybeRunDeepAction();
  } catch (e) { logDiag('auto-reconnect skipped: ' + (e && e.message ? e.message : e)); }
}

// --------------------------- confirm dialog (themed; window.confirm fallback) ---------------------------
function confirmRisky(msg) {
  return new Promise(resolve => {
    const dlg = $('confirm'); const body = $('confirm-body');
    if (!dlg || !dlg.showModal) { resolve(window.confirm(msg)); return; }
    if (body) body.textContent = msg;
    const ok = $('confirm-ok'), cancel = $('confirm-x'), no = $('confirm-no');
    const done = (v) => { dlg.close(); ok.removeEventListener('click', onOk); if (no) no.removeEventListener('click', onNo); if (cancel) cancel.removeEventListener('click', onNo); resolve(v); };
    const onOk = () => done(true), onNo = () => done(false);
    ok.addEventListener('click', onOk); if (no) no.addEventListener('click', onNo); if (cancel) cancel.addEventListener('click', onNo);
    dlg.showModal();
  });
}

// --------------------------- doc viewer (markdown of our own docs) ---------------------------
const DOC_TITLES = { 'GUIDE.de.md': 'footGuide', 'GUIDE.en.md': 'footGuide', 'README.md': 'footReadme', 'LICENSE.de.md': 'footLicense', 'LICENSE.md': 'footLicense', 'PRIVACY.de.md': 'footPrivacy', 'PRIVACY.md': 'footPrivacy', 'TRADEMARKS.de.md': 'footTrademarks', 'TRADEMARKS.md': 'footTrademarks', 'DISCLAIMER.de.md': 'footDisclaimer', 'DISCLAIMER.md': 'footDisclaimer' };
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
const escHtml = esc;
const slug = s => s.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
function docFile(name) { if (name === 'README') return 'README.md'; if (name === 'GUIDE') return 'GUIDE.' + lang + '.md'; return name + (lang === 'de' ? '.de.md' : '.md'); }
// inlineMd receives ALREADY-escaped text (mdToHtml escapes first); DOC_TITLES hrefs stay in-modal.
function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, text, href) {
      if (DOC_TITLES[href]) return '<a href="' + href + '" data-docfile="' + href + '">' + text + '</a>';
      return '<a href="' + href + '" target="_blank" rel="noopener">' + text + '</a>';
    });
}
function mdToHtml(md) {
  var codeBlocks = [];
  // 1) pull fenced code blocks out first so their content is never treated as markdown
  md = String(md).replace(/```[^\n]*\n?([\s\S]*?)```/g, function (m, code) {
    var i = codeBlocks.length;
    codeBlocks.push('<pre><code>' + esc(code.replace(/\n$/, '')) + '</code></pre>');
    return '\x00CB' + i + '\x00';
  });
  var lines = md.split(/\r?\n/);
  var out = [], para = [], list = null;
  function flushPara() { if (para.length) { out.push('<p>' + inlineMd(esc(para.join(' '))) + '</p>'); para = []; } }
  function flushList() { if (list) { out.push('<' + list.type + '>' + list.items.join('') + '</' + list.type + '>'); list = null; } }
  function isTableSep(s) { var tt = s.replace(/\s/g, ''); return /^\|?:?-+:?(\|:?-+:?)+\|?$/.test(tt); }
  function splitRow(s) { return s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); }); }
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    var cb = ln.match(/^\x00CB(\d+)\x00$/);
    if (cb) { flushPara(); flushList(); out.push(codeBlocks[Number(cb[1])]); continue; }
    if (/^\s*$/.test(ln)) { flushPara(); flushList(); continue; }
    var h = ln.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); flushList(); var lvl = Math.min(h[1].length, 4); out.push('<h' + lvl + '>' + inlineMd(esc(h[2])) + '</h' + lvl + '>'); continue; }
    if (/^---+$/.test(ln.trim())) { flushPara(); flushList(); out.push('<hr>'); continue; }
    if (ln.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {   // GFM table: header, |---| sep, rows
      flushPara(); flushList();
      var head = splitRow(ln); i++;   // consume the separator row
      var body = '';
      while (i + 1 < lines.length && lines[i + 1].indexOf('|') >= 0 && lines[i + 1].trim() !== '') {
        body += '<tr>' + splitRow(lines[++i]).map(function (c) { return '<td>' + inlineMd(esc(c)) + '</td>'; }).join('') + '</tr>';
      }
      out.push('<table><thead><tr>' + head.map(function (c) { return '<th>' + inlineMd(esc(c)) + '</th>'; }).join('') + '</tr></thead><tbody>' + body + '</tbody></table>');
      continue;
    }
    if (/^\s*>/.test(ln)) {                             // merge consecutive > lines into ONE callout
      flushPara(); flushList();
      var q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      i--;                                              // step back; the for-loop re-increments
      while (q.length && /^\s*$/.test(q[0])) q.shift();
      while (q.length && /^\s*$/.test(q[q.length - 1])) q.pop();
      if (q.length) out.push('<blockquote>' + mdToHtml(q.join('\n')) + '</blockquote>');  // inner rendered as markdown
      continue;
    }
    var ul = ln.match(/^\s*[-*]\s+(.*)$/);
    var ol = ln.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      var type = ul ? 'ul' : 'ol';
      if (!list || list.type !== type) { flushList(); list = { type: type, items: [] }; }
      list.items.push('<li>' + inlineMd(esc((ul ? ul[1] : ol[1]))) + '</li>');
      continue;
    }
    para.push(ln.trim());
  }
  flushPara(); flushList();
  return out.join('\n');
}
const docCache = {};
async function openDocFile(file) {
  const dlg = $('doc'); const titleEl = $('doc-title'); const bodyEl = $('doc-body');
  titleEl.textContent = t(DOC_TITLES[file] || 'footReadme');
  if (lang === 'de' && /\.md$/.test(file) && !/\.de\.md$/.test(file) && file !== 'README.md') titleEl.textContent += ' (englisch)';
  try { if (!docCache[file]) { const r = await fetch(file); docCache[file] = await r.text(); } bodyEl.innerHTML = mdToHtml(docCache[file]); } // scan-ok: own in-repo markdown rendered via mdToHtml; not user input
  catch (e) { bodyEl.textContent = 'Could not load ' + file; }
  if (dlg.showModal) dlg.showModal();
}
function wireDocViewer() {
  // delegated: footer doc links, the intro guide link (injected by i18n at runtime), in-doc links, disclaimer
  document.addEventListener('click', e => {
    const d = e.target.closest('a[data-doc]'); if (d) { e.preventDefault(); openDocFile(docFile(d.getAttribute('data-doc'))); return; }
    const df = e.target.closest('a[data-docfile]'); if (df) { e.preventDefault(); openDocFile(df.getAttribute('data-docfile')); return; }
    const disc = e.target.closest('[data-open-disclaimer]'); if (disc) { e.preventDefault(); openDocFile(docFile('DISCLAIMER')); return; }
  });
  ['doc-x', 'doc-close'].forEach(id => { const b = $(id); if (b) b.addEventListener('click', () => $('doc').close()); });
}

// --------------------------- help modal ---------------------------
const HELP = ['connect', 'live', 'speed', 'more', 'raw', 'publiclog', 'diaglog'];
function openHelp(key) { openHelpText(t('help_' + key + '_t'), t('help_' + key + '_b')); }
function openHelpText(title, body) {
  const dlg = $('help'); $('help-title').textContent = title || ''; const b = $('help-body'); if (/[<&]/.test(body || '')) b.innerHTML = body; else b.textContent = body || ''; // scan-ok: curated i18n help text; own table, not user input
  if (dlg.showModal) dlg.showModal();
}
function closeHelp() { const d = $('help'); if (d) d.close(); }

// --------------------------- init ---------------------------
window.addEventListener('DOMContentLoaded', () => {
  initLangSwitch(); initTheme(); wireDocViewer(); wireSettings();
  try { const o = localStorage.getItem(LS.OPEN); if (o && $('open-in')) $('open-in').value = o; } catch (e) {}
  try { const k = localStorage.getItem(LS.EKFV); if (k && $('ekfv-in')) $('ekfv-in').value = k; } catch (e) {}
  applyLang(); setStatus('disconnected'); resetTiles();
  logDiagnosticHeader();

  $('btn-conn').addEventListener('click', () => { if ($('btn-conn').dataset.act === 'disconnect') disconnect(); else guard(connect); });
  { const o = $('open-in'); if (o) o.addEventListener('change', () => { try { localStorage.setItem(LS.OPEN, o.value); } catch (e) {} }); }
  { const k = $('ekfv-in'); if (k) k.addEventListener('change', () => { try { localStorage.setItem(LS.EKFV, k.value); } catch (e) {} updateSpeedUI(); }); }

  $('btn-toggle').addEventListener('click', () => guard(async () => {
    const id = ($('btn-toggle').dataset.mode === 'lock') ? 'ekfv-in' : 'open-in';
    const v = parseInt($(id).value, 10);
    if (!(v >= 1 && v <= SPEED_MAX_KMH)) { logErr(t('errSpeedRange')); return; }
    await setSpeedLimit(v);
  }));
  { const b = $('btn-setspeed'); if (b) b.addEventListener('click', () => guard(async () => { const v = parseInt(($('speed-in') || {}).value, 10); if (!(v >= 1 && v <= SPEED_MAX_KMH)) { logErr(t('errSpeedRange')); return; } await setSpeedLimit(v); })); }

  { const b = $('btn-raw'); if (b) b.addEventListener('click', () => guard(cmdRaw)); }
  { const b = $('btn-regwrite'); if (b) b.addEventListener('click', () => guard(cmdRegWrite)); }
  { const b = $('btn-regread'); if (b) b.addEventListener('click', () => guard(cmdRegRead)); }
  { const b = $('btn-build'); if (b) b.addEventListener('click', () => { buildCustomFrame(); }); }
  { const b = $('btn-build-send'); if (b) b.addEventListener('click', () => guard(cmdBuildSend)); }

  document.querySelectorAll('.help-btn[data-help]').forEach(btn => btn.addEventListener('click', () => openHelp(btn.getAttribute('data-help'))));
  ['help-x', 'help-close'].forEach(id => { const b = $(id); if (b) b.addEventListener('click', closeHelp); });
  { const b = $('link-disclaimer'); if (b) b.addEventListener('click', e => { e.preventDefault(); openDocFile(docFile('DISCLAIMER')); }); }

  { const cb = $('public-log'); if (cb) { let saved = null; try { saved = localStorage.getItem(LS.PUBLOG); } catch (e) {} publicLog = saved !== '0'; cb.checked = publicLog; cb.addEventListener('change', () => { publicLog = cb.checked; try { localStorage.setItem(LS.PUBLOG, cb.checked ? '1' : '0'); } catch (e) {} logSys('public-log: ' + (cb.checked ? 'on (anonymizing device name/id)' : 'off')); renderLog(); }); } }
  { const cb = $('diag-log'); if (cb) { cb.addEventListener('change', () => { diag = cb.checked; logSys(diag ? 'diagnostic log on' : 'diagnostic log off'); }); } }
  { const cb = $('showall'); if (cb) cb.addEventListener('change', () => { logSys('show-all-frames: ' + (cb.checked ? 'on' : 'off')); renderLog(); }); }
  { const b = $('btn-clear-log'); if (b) b.addEventListener('click', () => { logBuffer = []; $('log').textContent = ''; logDiagnosticHeader(); }); }
  { const b = $('btn-copy-log'); if (b) b.addEventListener('click', () => navigator.clipboard.writeText(logText()).then(() => logSys('log copied')).catch(() => {})); }
  { const b = $('btn-save-log'); if (b) b.addEventListener('click', saveLog); }

  parseDeepLink();
  if (pendingDeepAction) { logSys(t('scPending')); tryAutoReconnect(); }
});
