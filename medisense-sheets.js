// ============================================================
//  MediSense AI — medisense-sheets.js  (v2 — FIXED)
//  Google Sheets sync layer
//
//  SHEETS STRUCTURE (must exist in your Google Sheet):
//    Sheet "Doctors"      → doctor accounts (no passwords)
//    Sheet "Patient"      → family/patient accounts (no passwords)
//    Sheet "Users"        → ALL users combined (no passwords)
//    Sheet "VitalSigns"   → vitals recorded by doctors
//    Sheet "Vitals"       → vitals recorded by patients/family
//    Sheet "LoginEvents"  → every login event
//
//  HOW TO REDEPLOY (REQUIRED after replacing Apps Script code):
//    1. Open your Google Sheet
//    2. Extensions → Apps Script
//    3. DELETE all existing code
//    4. PASTE the Apps Script block at the bottom of this file
//    5. Click Deploy → Manage Deployments → Edit (pencil icon)
//       • Change version to "New version"
//       • Click Deploy
//    6. Copy the same deployment URL (it doesn't change)
//    7. That's it — the URL in SHEETS_WEBAPP_URL below stays the same
// ============================================================

(function (global) {
  'use strict';

  // ──────────────────────────────────────────────────────────
  //  ⚠️  YOUR APPS SCRIPT URL — do not change this line
  // ──────────────────────────────────────────────────────────
  const SHEETS_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbyYx68M9ebmSIzRJvmGGNECKX3dvcOkq6ZD9ntAYvBL48r76nQubE2uz1FfntX-4sog/exec'
  const CONFIGURED = !SHEETS_WEBAPP_URL.includes('YOUR_APPS_SCRIPT');

  // ──────────────────────────────────────────────────────────
  //  INTERNAL: POST to Apps Script
  // ──────────────────────────────────────────────────────────
  async function post(action, payload) {
    if (!CONFIGURED) {
      console.warn('[Sheets] Not configured — skipping sync.');
      return { ok: false, error: 'not_configured' };
    }
    try {
      const res = await fetch(SHEETS_WEBAPP_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'text/plain' },
        body:    JSON.stringify({ action, ...payload }),
      });
      const text = await res.text();
      try { return JSON.parse(text); }
      catch { console.error('[Sheets] Bad JSON response:', text); return { ok: false, error: 'bad_json' }; }
    } catch (err) {
      console.error('[Sheets] Network error:', err);
      return { ok: false, error: err.message };
    }
  }

  // ──────────────────────────────────────────────────────────
  //  INTERNAL: GET from Apps Script
  // ──────────────────────────────────────────────────────────
  async function get(action, params = {}) {
    if (!CONFIGURED) return { ok: false, data: [] };
    try {
      const qs  = new URLSearchParams({ action, ...params }).toString();
      const res = await fetch(`${SHEETS_WEBAPP_URL}?${qs}`);
      const text = await res.text();
      try { return JSON.parse(text); }
      catch { return { ok: false, data: [] }; }
    } catch (err) {
      console.error('[Sheets] Fetch error:', err);
      return { ok: false, data: [] };
    }
  }

  // ──────────────────────────────────────────────────────────
  //  PUBLIC API
  // ──────────────────────────────────────────────────────────
  const Sheets = {

    isConfigured() { return CONFIGURED; },

    // ── VITALS ─────────────────────────────────────────────

    /**
     * Append one vitals row.
     * Routes to "VitalSigns" sheet for doctors, "Vitals" sheet for family/patients.
     * role: 'doctor' | 'family'
     */
    async appendVital(row, role) {
      return post('appendVital', { row, role: role || 'family' });
    },

    /**
     * Pull all vitals from BOTH sheets and merge into localStorage.
     * Doctors get everything; family only get their own.
     */
    async syncVitals(userId, role) {
      const res = await get('getVitals', { userId, role: role || 'family' });
      if (!res.ok || !res.data?.length) return [];

      const existing = new Set(DB.all('vital_signs').map(r => r.id));
      let added = 0;
      res.data.forEach(row => {
        if (!existing.has(row.id)) {
          DB.insert('vital_signs', row);
          added++;
        }
      });
      if (added > 0) console.log(`[Sheets] Synced ${added} new vital(s) from Sheets`);
      return res.data;
    },

    // ── USERS ───────────────────────────────────────────────

    /**
     * Push a new user to the correct sheet based on role.
     * Also always writes to the "Users" sheet (combined log).
     * role: 'doctor' | 'family'
     */
    async appendUser(user, role) {
      return post('appendUser', {
        role: role || 'family',
        row: {
          id:         user.id,
          email:      user.email,
          full_name:  user.full_name,
          created_at: user.created_at,
        },
      });
    },

    /** Pull all users from Sheets and merge into localStorage */
    async syncUsers() {
      const res = await get('getUsers');
      if (!res.ok || !res.data?.length) return [];
      const existing = new Set(DB.all('users').map(r => r.id));
      let added = 0;
      res.data.forEach(row => {
        if (!existing.has(row.id)) {
          const localUser = DB.find('users', u => u.email === row.email);
          if (!localUser) {
            DB.insert('users', { ...row, password_hash: '' });
            added++;
          }
        }
      });
      if (added > 0) console.log(`[Sheets] Synced ${added} new user(s) from Sheets`);
      return res.data;
    },

    // ── LOGIN EVENTS ────────────────────────────────────────

    /** Log a login event to the LoginEvents sheet */
    async logLogin(userId, email, method, role) {
      return post('appendLoginEvent', {
        row: {
          id:          crypto.randomUUID(),
          user_id:     userId,
          email,
          role:        role || 'unknown',
          auth_method: method,
          logged_at:   new Date().toISOString(),
          user_agent:  navigator.userAgent.slice(0, 120),
        },
      });
    },

    // ── FULL SYNC ───────────────────────────────────────────

    /** Pull everything from Sheets and merge into local DB */
    async fullSync(userId, role) {
      if (!CONFIGURED) return;
      const [vitals] = await Promise.all([
        Sheets.syncVitals(userId, role),
        Sheets.syncUsers(),
      ]);
      return vitals;
    },
  };

  global.Sheets = Sheets;

  // Show a helpful banner if not configured
  if (!CONFIGURED) {
    window.addEventListener('DOMContentLoaded', () => {
      const b = document.createElement('div');
      b.style.cssText = `
        position:fixed;bottom:0;left:0;right:0;z-index:9999;
        background:#0F172A;color:#94A3B8;font-family:monospace;
        font-size:12px;padding:8px 20px;display:flex;gap:16px;
        align-items:center;border-top:1px solid #1E293B;
      `;
      b.innerHTML = `
        <span style="color:#38BDF8;font-weight:bold">📊 Sheets</span>
        <span>Not connected — paste your Apps Script URL in <code style="color:#7DD3FC">medisense-sheets.js</code></span>
        <button onclick="this.parentElement.remove()" style="background:none;border:none;color:#64748B;cursor:pointer;font-size:16px;margin-left:auto">✕</button>
      `;
      document.body.appendChild(b);
    });
  }

})(window);


// ============================================================
//  ██████████████████████████████████████████████████████████
//  GOOGLE APPS SCRIPT — PASTE THIS INTO EXTENSIONS → APPS SCRIPT
//  DELETE ALL EXISTING CODE FIRST, THEN PASTE EVERYTHING BELOW
//  ██████████████████████████████████████████████████████████
// ============================================================
/*

// ── Sheet name constants ──────────────────────────────────────
const SHEET_DOCTORS      = 'Doctors';
const SHEET_PATIENTS     = 'Patient';
const SHEET_USERS        = 'Users';
const SHEET_VITALS_DOC   = 'VitalSigns';
const SHEET_VITALS_FAM   = 'Vitals';
const SHEET_LOGIN        = 'LoginEvents';

// ── Column headers per sheet ──────────────────────────────────
const HEADERS = {
  Doctors:     ['id', 'full_name', 'email', 'department', 'hospital_id', 'created_at'],
  Patient:     ['id', 'full_name', 'email', 'created_at'],
  Users:       ['id', 'full_name', 'email', 'role', 'created_at'],
  VitalSigns:  ['id', 'recorded_by', 'patient_name', 'heart_rate', 'spo2', 'temperature',
                'bp_systolic', 'bp_diastolic', 'resp_rate', 'blood_glucose', 'recorded_at', 'created_at'],
  Vitals:      ['id', 'recorded_by', 'heart_rate', 'spo2', 'temperature',
                'bp_systolic', 'bp_diastolic', 'resp_rate', 'blood_glucose', 'recorded_at', 'created_at'],
  LoginEvents: ['id', 'user_id', 'email', 'role', 'auth_method', 'logged_at', 'user_agent'],
};

// ── Utility: get or create a sheet with headers ───────────────
function getOrCreateSheet(name) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  // Write headers if row 1 is empty
  if (sheet.getLastRow() === 0) {
    const hdrs = HEADERS[name];
    if (hdrs) sheet.appendRow(hdrs);
  }
  return sheet;
}

// ── Utility: check if row with matching id already exists ─────
function rowExists(sheet, id) {
  const data = sheet.getDataRange().getValues();
  // Row 0 is headers; column 0 is 'id'
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) return true;
  }
  return false;
}

// ── Utility: read all rows as array of objects ────────────────
function sheetToObjects(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

// ── GET handler ───────────────────────────────────────────────
function doGet(e) {
  const action = e.parameter.action || '';
  const userId = e.parameter.userId || '';
  const role   = e.parameter.role   || 'family';

  let result = { ok: false, data: [] };

  try {
    if (action === 'getVitals') {
      // Doctors get ALL vitals from VitalSigns; family get only their own from Vitals
      if (role === 'doctor') {
        const sheet = getOrCreateSheet(SHEET_VITALS_DOC);
        result = { ok: true, data: sheetToObjects(sheet) };
      } else {
        const sheet = getOrCreateSheet(SHEET_VITALS_FAM);
        const all   = sheetToObjects(sheet);
        result = { ok: true, data: userId ? all.filter(r => String(r.recorded_by) === userId) : all };
      }
    }

    else if (action === 'getUsers') {
      const sheet = getOrCreateSheet(SHEET_USERS);
      result = { ok: true, data: sheetToObjects(sheet) };
    }

    else if (action === 'getDoctors') {
      const sheet = getOrCreateSheet(SHEET_DOCTORS);
      result = { ok: true, data: sheetToObjects(sheet) };
    }

    else if (action === 'getPatients') {
      const sheet = getOrCreateSheet(SHEET_PATIENTS);
      result = { ok: true, data: sheetToObjects(sheet) };
    }

    else if (action === 'ping') {
      result = { ok: true, message: 'MediSense Apps Script is live ✓' };
    }

  } catch (err) {
    result = { ok: false, error: err.message };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── POST handler ──────────────────────────────────────────────
function doPost(e) {
  let body   = {};
  let result = { ok: false };

  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: 'invalid_json' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  try {
    const { action, row, role } = body;

    // ── appendVital ──────────────────────────────────────────
    if (action === 'appendVital') {
      // Route to VitalSigns for doctors, Vitals for family/patients
      const sheetName = (role === 'doctor') ? SHEET_VITALS_DOC : SHEET_VITALS_FAM;
      const sheet     = getOrCreateSheet(sheetName);

      if (!rowExists(sheet, row.id)) {
        if (role === 'doctor') {
          // Look up patient name from Users sheet for doctor-side records
          const usersSheet  = getOrCreateSheet(SHEET_USERS);
          const users       = sheetToObjects(usersSheet);
          const patient     = users.find(u => u.id === row.recorded_by);
          const patientName = patient ? (patient.full_name || patient.email || 'Unknown') : 'Unknown';

          sheet.appendRow([
            row.id, row.recorded_by, patientName,
            row.heart_rate    || '', row.spo2          || '',
            row.temperature   || '', row.bp_systolic   || '',
            row.bp_diastolic  || '', row.resp_rate     || '',
            row.blood_glucose || '', row.recorded_at   || '',
            row.created_at    || '',
          ]);
        } else {
          sheet.appendRow([
            row.id, row.recorded_by,
            row.heart_rate    || '', row.spo2          || '',
            row.temperature   || '', row.bp_systolic   || '',
            row.bp_diastolic  || '', row.resp_rate     || '',
            row.blood_glucose || '', row.recorded_at   || '',
            row.created_at    || '',
          ]);
        }
      }
      result = { ok: true };
    }

    // ── appendUser ───────────────────────────────────────────
    else if (action === 'appendUser') {
      // Write to role-specific sheet (Doctors or Patient)
      const roleSheet = (role === 'doctor') ? SHEET_DOCTORS : SHEET_PATIENTS;
      const specific  = getOrCreateSheet(roleSheet);
      const combined  = getOrCreateSheet(SHEET_USERS);

      if (!rowExists(specific, row.id)) {
        if (role === 'doctor') {
          specific.appendRow([
            row.id, row.full_name || '', row.email || '',
            row.department || '', row.hospital_id || '', row.created_at || '',
          ]);
        } else {
          specific.appendRow([
            row.id, row.full_name || '', row.email || '', row.created_at || '',
          ]);
        }
      }

      // Always also write to the combined Users sheet
      if (!rowExists(combined, row.id)) {
        combined.appendRow([
          row.id, row.full_name || '', row.email || '',
          role || 'unknown', row.created_at || '',
        ]);
      }

      result = { ok: true };
    }

    // ── appendLoginEvent ─────────────────────────────────────
    else if (action === 'appendLoginEvent') {
      const sheet = getOrCreateSheet(SHEET_LOGIN);
      if (!rowExists(sheet, row.id)) {
        sheet.appendRow([
          row.id, row.user_id || '', row.email || '',
          row.role || '', row.auth_method || '',
          row.logged_at || '', row.user_agent || '',
        ]);
      }
      result = { ok: true };
    }

    else {
      result = { ok: false, error: 'unknown_action: ' + action };
    }

  } catch (err) {
    result = { ok: false, error: err.message };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

*/
