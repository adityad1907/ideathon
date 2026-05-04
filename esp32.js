// ============================================================
//  MediSense AI — esp32.js
//  ESP32 Sensor Integration Layer
//
//  HOW IT WORKS:
//    1. A small Node.js bridge server runs on your PC
//    2. Your ESP32 POSTs vitals JSON to the bridge every N seconds
//    3. This module polls the bridge from the browser
//    4. New readings are shown live and can be saved to the dashboard
//
//  FILES:
//    esp32.js         ← this file (runs in browser)
//    esp32-bridge.js  ← run on your PC with: node esp32-bridge.js
//    MediSenseESP32.ino ← flash onto your ESP32
// ============================================================

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────
  const esp32 = {
    bridgeUrl:      null,   // e.g. http://192.168.1.10:3456
    pollInterval:   10,     // seconds
    pollTimer:      null,
    connected:      false,
    lastReading:    null,
    readingCount:   0,
    autoSave:       false,
    consecutiveFails: 0,
  };

  // ── Config keys ────────────────────────────────────────────
  const CFG_IP       = 'esp32_bridge_ip';
  const CFG_PORT     = 'esp32_bridge_port';
  const CFG_INTERVAL = 'esp32_poll_interval';

  // ── DOM refs ───────────────────────────────────────────────
  const $ = id => document.getElementById(id);

  // ── Wait for DOM ───────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', () => {
    loadSavedConfig();
    bindUI();
  });

  // ── Load saved config from localStorage ───────────────────
  function loadSavedConfig() {
    const ip       = localStorage.getItem(CFG_IP)       || '';
    const port     = localStorage.getItem(CFG_PORT)     || '3456';
    const interval = localStorage.getItem(CFG_INTERVAL) || '10';

    if ($('esp32-bridge-ip'))       $('esp32-bridge-ip').value       = ip;
    if ($('esp32-bridge-port'))     $('esp32-bridge-port').value     = port;
    if ($('esp32-poll-interval'))   $('esp32-poll-interval').value   = interval;

    if (ip) {
      esp32.bridgeUrl    = `http://${ip}:${port}`;
      esp32.pollInterval = parseInt(interval, 10);
    }
  }

  // ── Bind all UI events ─────────────────────────────────────
  function bindUI() {
    // Save & Connect
    const saveBtn = $('esp32-save-config-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const ip       = $('esp32-bridge-ip')?.value.trim();
        const port     = $('esp32-bridge-port')?.value.trim() || '3456';
        const interval = parseInt($('esp32-poll-interval')?.value || '10', 10);

        if (!ip) { showToast('Enter your bridge server IP address', 'error'); return; }

        localStorage.setItem(CFG_IP,       ip);
        localStorage.setItem(CFG_PORT,     port);
        localStorage.setItem(CFG_INTERVAL, interval);

        esp32.bridgeUrl    = `http://${ip}:${port}`;
        esp32.pollInterval = interval;

        startPolling();
      });
    }

    // Disconnect
    const discBtn = $('esp32-disconnect-btn');
    if (discBtn) discBtn.addEventListener('click', stopPolling);

    // Test connection
    const testBtn = $('esp32-test-btn');
    if (testBtn) testBtn.addEventListener('click', testConnection);

    // Save reading manually
    const saveReadingBtn = $('esp32-save-reading-btn');
    if (saveReadingBtn) saveReadingBtn.addEventListener('click', saveCurrentReading);

    // User ID display (for Arduino sketch)
    const uidEl = $('esp32-user-id-display');
    if (uidEl) {
      // update when user logs in (state may not exist yet)
      const trySetUid = () => {
        if (typeof state !== 'undefined' && state.user?.id) {
          uidEl.textContent = state.user.id;
        }
      };
      setTimeout(trySetUid, 1000);
      document.addEventListener('medisense:loggedin', trySetUid);
    }

    // Download bridge script
    const dlBridge = $('esp32-dl-bridge');
    if (dlBridge) dlBridge.addEventListener('click', downloadBridgeScript);

    // Download Arduino sketch
    const dlSketch = $('esp32-dl-sketch');
    if (dlSketch) dlSketch.addEventListener('click', downloadArduinoSketch);
  }

  // ── Test connection once ───────────────────────────────────
  async function testConnection() {
    if (!esp32.bridgeUrl) {
      const ip   = $('esp32-bridge-ip')?.value.trim();
      const port = $('esp32-bridge-port')?.value.trim() || '3456';
      if (!ip) { showToast('Enter IP address first', 'error'); return; }
      esp32.bridgeUrl = `http://${ip}:${port}`;
    }

    setStatus('connecting', 'Testing connection…', '');
    showToast('Testing bridge connection…', 'info');

    try {
      const res  = await fetchWithTimeout(`${esp32.bridgeUrl}/ping`, 4000);
      const data = await res.json();
      if (data.ok) {
        setStatus('connected', 'Bridge reachable ✓', `Bridge v${data.version || '1.0'} responding`);
        showToast('Bridge is online! Click Save & Connect to start polling.', 'success');
      } else {
        setStatus('error', 'Bridge error', data.error || 'Unexpected response');
        showToast('Bridge responded but returned an error', 'error');
      }
    } catch (err) {
      setStatus('error', 'Cannot reach bridge', 'Check IP, port, and that node esp32-bridge.js is running');
      showToast('Cannot reach bridge — is node esp32-bridge.js running?', 'error');
    }
  }

  // ── Start polling loop ─────────────────────────────────────
  function startPolling() {
    stopPolling();
    setStatus('connecting', 'Connecting…', 'Waiting for first reading…');
    showToast(`Polling ESP32 bridge every ${esp32.pollInterval}s`, 'info');

    const liveBadge = $('esp32-nav-badge');
    if (liveBadge) { liveBadge.textContent = '...'; liveBadge.style.background = '#F59E0B'; }

    poll(); // immediate first poll
    esp32.pollTimer = setInterval(poll, esp32.pollInterval * 1000);
  }

  // ── Stop polling ───────────────────────────────────────────
  function stopPolling() {
    clearInterval(esp32.pollTimer);
    esp32.pollTimer  = null;
    esp32.connected  = false;
    esp32.consecutiveFails = 0;

    setStatus('disconnected', 'Disconnected', 'Polling stopped');
    const badge = $('esp32-nav-badge');
    if (badge) { badge.textContent = 'OFF'; badge.style.background = '#64748B'; }

    const liveCard = $('esp32-live-card');
    if (liveCard) liveCard.style.display = 'none';
  }

  // ── One poll cycle ─────────────────────────────────────────
  async function poll() {
    if (!esp32.bridgeUrl) return;

    try {
      const res  = await fetchWithTimeout(`${esp32.bridgeUrl}/latest`, 5000);
      const data = await res.json();

      if (!data.ok || !data.reading) {
        esp32.consecutiveFails++;
        if (esp32.consecutiveFails >= 3) {
          setStatus('error', 'No data', 'Bridge connected but no ESP32 readings received yet');
        }
        return;
      }

      // ── Got a reading ──────────────────────────────────────
      esp32.consecutiveFails = 0;
      esp32.connected        = true;
      esp32.lastReading      = data.reading;
      esp32.readingCount++;

      const badge = $('esp32-nav-badge');
      if (badge) { badge.textContent = 'LIVE'; badge.style.background = '#10B981'; }

      updateLiveUI(data.reading);
      setStatus('connected', 'Connected — Live', `ESP32 @ ${data.reading.recorded_at ? new Date(data.reading.recorded_at).toLocaleTimeString() : 'just now'}`);

      const lastPing = $('esp32-last-ping');
      if (lastPing) lastPing.textContent = 'Last: ' + new Date().toLocaleTimeString();

      // Auto-save if enabled
      if (esp32.autoSave) saveCurrentReading(true);

    } catch (err) {
      esp32.consecutiveFails++;
      if (esp32.consecutiveFails === 1) {
        setStatus('error', 'Bridge unreachable', 'Check that node esp32-bridge.js is still running');
        const badge = $('esp32-nav-badge');
        if (badge) { badge.textContent = 'ERR'; badge.style.background = '#EF4444'; }
      }
    }
  }

  // ── Update live stats UI ───────────────────────────────────
  function updateLiveUI(r) {
    const liveCard = $('esp32-live-card');
    if (liveCard) liveCard.style.display = 'block';

    const set = (id, val, dec = 0) => {
      const el = $(id);
      if (el && val != null) {
        const num = parseFloat(val);
        const parts = el.innerHTML.split('<span>');
        const unit  = parts[1] ? '<span>' + parts[1] : '';
        el.innerHTML = (isNaN(num) ? val : num.toFixed(dec)) + unit;
      }
    };

    set('esp32-hr',      r.heart_rate,    0);
    set('esp32-spo2',    r.spo2,          1);
    set('esp32-temp',    r.temperature,   1);
    set('esp32-resp',    r.resp_rate,     0);
    set('esp32-glucose', r.blood_glucose, 0);

    const bpEl = $('esp32-bp');
    if (bpEl && r.bp_systolic != null) {
      bpEl.innerHTML = `${r.bp_systolic}/${r.bp_diastolic}<span> mmHg</span>`;
    }

    const countEl = $('esp32-reading-count');
    if (countEl) countEl.textContent = `${esp32.readingCount} received`;
  }

  // ── Save current reading to MediSense dashboard ───────────
  function saveCurrentReading(silent = false) {
    const r = esp32.lastReading;
    if (!r) { if (!silent) showToast('No reading to save', 'error'); return; }

    if (typeof state === 'undefined' || !state.user) {
      if (!silent) showToast('Please log in first', 'error'); return;
    }

    const payload = {
      recorded_by:   state.user.id,
      recorded_at:   r.recorded_at || new Date().toISOString(),
      heart_rate:    r.heart_rate    ?? null,
      spo2:          r.spo2          ?? null,
      temperature:   r.temperature   ?? null,
      bp_systolic:   r.bp_systolic   ?? null,
      bp_diastolic:  r.bp_diastolic  ?? null,
      resp_rate:     r.resp_rate     ?? null,
      blood_glucose: r.blood_glucose ?? null,
    };

    const saved = DB.insert('vital_signs', payload);

    // Sync to Sheets
    if (typeof Sheets !== 'undefined' && Sheets.isConfigured()) {
      Sheets.appendVital(saved, state.role).catch(() => {});
    }

    // Refresh dashboard
    if (typeof loadVitals === 'function') loadVitals();

    if (!silent) {
      showToast('ESP32 reading saved to dashboard ✓', 'success');
      $('esp32-auto-save-label').textContent = 'Saved at ' + new Date().toLocaleTimeString();
    }
  }

  // ── Set status UI ──────────────────────────────────────────
  function setStatus(state, text, detail) {
    const dot    = $('esp32-dot');
    const txt    = $('esp32-status-text');
    const det    = $('esp32-detail');

    if (dot) { dot.className = 'esp32-dot'; dot.classList.add(state === 'connected' ? 'connected' : state === 'connecting' ? 'connecting' : state === 'error' ? 'error' : ''); }
    if (txt) txt.textContent = text;
    if (det) det.textContent = detail;
  }

  // ── Fetch with timeout ─────────────────────────────────────
  function fetchWithTimeout(url, ms) {
    const ctrl = new AbortController();
    const id   = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(id));
  }

  // ── Download bridge server script ──────────────────────────
  function downloadBridgeScript() {
    const userId = (typeof state !== 'undefined' && state.user?.id) ? state.user.id : 'PASTE_YOUR_USER_ID';
    const sheetsUrl = 'https://script.google.com/macros/s/AKfycbwuV2DRzMDDUM0eyOPFWQk3oYTtClWyr6AXmLKHH5sxXqaNt6nFf3N-Ktn0PCla8lGP/exec';

    const code = `// ============================================================
//  MediSense ESP32 Bridge Server
//  Run with: node esp32-bridge.js
//  Requires Node.js 18+
// ============================================================
const http   = require('http');
const https  = require('https');
const crypto = require('crypto');

const PORT       = 3456;
const SHEETS_URL = '${sheetsUrl}';

let latestReading = null;

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── GET /ping — health check ──────────────────────────
  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: '1.0', message: 'MediSense bridge is live ✓' }));
    return;
  }

  // ── GET /latest — browser polls this ─────────────────
  if (req.method === 'GET' && req.url === '/latest') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, reading: latestReading }));
    return;
  }

  // ── POST /vitals — ESP32 posts here ──────────────────
  if (req.method === 'POST' && req.url === '/vitals') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const vitals = JSON.parse(body);
        const now    = new Date().toISOString();

        latestReading = {
          id:            crypto.randomUUID(),
          recorded_by:   vitals.user_id || '${userId}',
          heart_rate:    vitals.heart_rate    ?? null,
          spo2:          vitals.spo2          ?? null,
          temperature:   vitals.temperature   ?? null,
          bp_systolic:   vitals.bp_systolic   ?? null,
          bp_diastolic:  vitals.bp_diastolic  ?? null,
          resp_rate:     vitals.resp_rate     ?? null,
          blood_glucose: vitals.blood_glucose ?? null,
          recorded_at:   now,
          created_at:    now,
        };

        console.log('[' + new Date().toLocaleTimeString() + '] Received from ESP32:', JSON.stringify(latestReading, null, 2));

        // Also push to Google Sheets
        pushToSheets(latestReading, vitals.role || 'family');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error('Parse error:', e.message);
        res.writeHead(400); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end();
}).listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║   MediSense ESP32 Bridge  v1.0       ║');
  console.log('╠══════════════════════════════════════╣');
  console.log('║  Listening on port ' + PORT + '             ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');
  console.log('ESP32 should POST to:  http://<YOUR_PC_IP>:' + PORT + '/vitals');
  console.log('Browser polls from:    http://<YOUR_PC_IP>:' + PORT + '/latest');
  console.log('');
});

function pushToSheets(row, role) {
  const payload = JSON.stringify({ action: 'appendVital', row, role });
  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(payload) },
  };
  const req = https.request(SHEETS_URL, opts, r => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => console.log('[Sheets] sync:', d.slice(0, 80)));
  });
  req.on('error', e => console.warn('[Sheets] error:', e.message));
  req.write(payload);
  req.end();
}
`;
    download('esp32-bridge.js', code, 'text/javascript');
  }

  // ── Download Arduino sketch ────────────────────────────────
  function downloadArduinoSketch() {
    const userId = (typeof state !== 'undefined' && state.user?.id) ? state.user.id : 'PASTE_YOUR_USER_ID';

    const code = `// ============================================================
//  MediSense AI — ESP32 Sensor Sketch
//  Board: ESP32 Dev Module
//  Required libraries (install via Library Manager):
//    - ArduinoJson  (Benoit Blanchon)
//    - MAX30105      (SparkFun) — for HR + SpO2
//    - SparkFun_MAX3010x_Sensor_Library
// ============================================================
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ── WiFi ──────────────────────────────────────────────────────
const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// ── Bridge server (your PC's local IP) ────────────────────────
const char* BRIDGE_IP   = "192.168.1.XXX";   // <-- change this
const int   BRIDGE_PORT = 3456;
const char* BRIDGE_PATH = "/vitals";

// ── Your MediSense User ID ─────────────────────────────────────
// Open MediSense → ESP32 page → copy User ID shown at the bottom
const char* USER_ID = "${userId}";
const char* ROLE    = "family";  // "doctor" or "family"

// ── Timing ────────────────────────────────────────────────────
const int SEND_INTERVAL_MS = 30000;  // 30 seconds

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\\nMediSense ESP32 starting...");

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi");
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 30) {
    delay(500); Serial.print("."); tries++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\\nConnected! IP: " + WiFi.localIP().toString());
  } else {
    Serial.println("\\nWiFi failed — restarting");
    ESP.restart();
  }
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi lost, reconnecting...");
    WiFi.reconnect();
    delay(5000);
    return;
  }

  // ── READ SENSORS ────────────────────────────────────────────
  // Replace these with real sensor reads from your hardware:
  //   MAX30102 → heart_rate + spo2
  //   DS18B20  → temperature
  //   MPX5700  → blood pressure (needs calibration)
  //   SSD1306  → optional OLED display

  float heart_rate    = 72.0 + random(-5, 5);    // replace with MAX30102
  float spo2          = 98.0 + random(-2, 1);    // replace with MAX30102
  float temperature   = 36.6 + random(-3, 5)/10.0; // replace with DS18B20
  int   bp_systolic   = 120  + random(-10, 10);  // replace with BP sensor
  int   bp_diastolic  = 80   + random(-5, 5);
  int   resp_rate     = 16   + random(-2, 2);
  float blood_glucose = 95.0 + random(-10, 10);

  // ── BUILD JSON ───────────────────────────────────────────────
  StaticJsonDocument<512> doc;
  doc["user_id"]       = USER_ID;
  doc["role"]          = ROLE;
  doc["heart_rate"]    = heart_rate;
  doc["spo2"]          = spo2;
  doc["temperature"]   = temperature;
  doc["bp_systolic"]   = bp_systolic;
  doc["bp_diastolic"]  = bp_diastolic;
  doc["resp_rate"]     = resp_rate;
  doc["blood_glucose"] = blood_glucose;

  String body;
  serializeJson(doc, body);

  // ── POST TO BRIDGE ───────────────────────────────────────────
  String url = "http://" + String(BRIDGE_IP) + ":" + String(BRIDGE_PORT) + BRIDGE_PATH;

  HTTPClient http;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(8000);

  int code = http.POST(body);

  if (code == 200) {
    Serial.println("[OK] Vitals sent — HR:" + String(heart_rate) +
                   " SpO2:" + String(spo2) +
                   " Temp:" + String(temperature));
  } else {
    Serial.println("[FAIL] HTTP " + String(code) + " — is bridge running?");
  }

  http.end();
  delay(SEND_INTERVAL_MS);
}
`;
    download('MediSenseESP32.ino', code, 'text/plain');
  }

  // ── Generic file download helper ──────────────────────────
  function download(filename, content, mime) {
    const a   = document.createElement('a');
    a.href    = URL.createObjectURL(new Blob([content], { type: mime }));
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

})();
