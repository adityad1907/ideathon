// ============================================================
//  MediSense AI — medisense-sheets.js
//  Google Sheets sync layer
//
//  HOW IT WORKS:
//    localStorage (DB) stays as the primary fast store.
//    Every write ALSO appends a row to Google Sheets.
//    On load, it pulls ALL rows from Sheets and merges them
//    into localStorage so data survives across devices.
//
//  SETUP (one-time, takes ~3 minutes):
//    1. Open your Google Sheet
//    2. Extensions → Apps Script
//    3. Paste the Apps Script code from the bottom of this file
//    4. Click Deploy → New deployment → Web app
//       • Execute as: Me
//       • Who has access: Anyone
//    5. Copy the deployment URL
//    6. Paste it below as SHEETS_WEBAPP_URL
//
//  SHEETS STRUCTURE (auto-created by Apps Script):
//    Sheet "VitalSigns"  → all vitals rows
//    Sheet "Users"       → registered users (no passwords)
//    Sheet "LoginEvents" → login audit log
// ============================================================

(function (global) {
  'use strict';

  // ──────────────────────────────────────────────────────────
  //  ⚠️  PASTE YOUR APPS SCRIPT WEB APP URL HERE
  // ──────────────────────────────────────────────────────────
  const SHEETS_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbwuV2DRzMDDUM0eyOPFWQk3oYTtClWyr6AXmLKHH5sxXqaNt6nFf3N-Ktn0PCla8lGP/exec';
  // Example: 'https://script.google.com/macros/s/AKfycb.../exec'

  const CONFIGURED = !SHEETS_WEBAPP_URL.includes('YOUR_APPS_SCRIPT');

  // ──────────────────────────────────────────────────────────
  //  INTERNAL: post to Apps Script web app
  // ──────────────────────────────────────────────────────────
  async function post(action, payload) {
    if (!CONFIGURED) {
      console.warn('[Sheets] Not configured — skipping sync. Paste your Apps Script URL in medisense-sheets.js');
      return { ok: false, error: 'not_configured' };
    }
    try {
      const res = await fetch(SHEETS_WEBAPP_URL, {
        method:  'POST',
        // Apps Script requires text/plain for no-cors workaround
        headers: { 'Content-Type': 'text/plain' },
        body:    JSON.stringify({ action, ...payload }),
      });
      const text = await res.text();
      return JSON.parse(text);
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
      return JSON.parse(text);
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

    // ── VITALS ────────────────────────────────────────────

    /** Append one vitals row to the VitalSigns sheet */
    async appendVital(row) {
      return post('appendVital', { row });
    },

    /** Pull all vitals for a user and merge into localStorage */
    async syncVitals(userId) {
      const res = await get('getVitals', { userId });
      if (!res.ok || !res.data?.length) return [];

      // Merge into local DB — skip rows already present (by id)
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

    // ── USERS ─────────────────────────────────────────────

    /** Push a new user record (no password hash) to the Users sheet */
    async appendUser(user) {
      return post('appendUser', {
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
        // We only store email + name from Sheets (no password_hash)
        if (!existing.has(row.id)) {
          // Only add if we truly don't have them locally
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

    // ── LOGIN EVENTS ──────────────────────────────────────

    /** Log a login event to the LoginEvents sheet */
    async logLogin(userId, email, method) {
      return post('appendLoginEvent', {
        row: {
          id:          crypto.randomUUID(),
          user_id:     userId,
          email,
          auth_method: method,
          logged_at:   new Date().toISOString(),
          user_agent:  navigator.userAgent.slice(0, 120),
        },
      });
    },

    // ── FULL SYNC ─────────────────────────────────────────

    /** Pull everything from Sheets and merge into local DB */
    async fullSync(userId) {
      if (!CONFIGURED) return;
      const [vitals] = await Promise.all([
        Sheets.syncVitals(userId),
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
        <a href="#" onclick="document.getElementById('sheets-setup-modal').style.display='flex';return false"
           style="color:#7DD3FC;text-decoration:none;margin-left:auto">Setup guide →</a>
        <button onclick="this.parentElement.remove()" style="background:none;border:none;color:#64748B;cursor:pointer;font-size:16px">✕</button>
      `;
      document.body.appendChild(b);

      // Setup modal
      const m = document.createElement('div');
      m.id = 'sheets-setup-modal';
      m.style.cssText = `
        display:none;position:fixed;inset:0;z-index:99999;
        background:rgba(0,0,0,.7);align-items:center;justify-content:center;
      `;
      m.innerHTML = `
        <div style="background:#0F172A;border:1px solid #1E293B;border-radius:12px;
             padding:28px;max-width:540px;width:90%;color:#CBD5E1;font-family:monospace;font-size:13px;line-height:1.8">
          <div style="font-size:16px;font-weight:bold;color:#F8FAFC;margin-bottom:16px">📊 Connect Google Sheets — 3 steps</div>
          <ol style="margin:0 0 20px;padding-left:20px;color:#94A3B8">
            <li>Open your Google Sheet → <b style="color:#7DD3FC">Extensions → Apps Script</b></li>
            <li>Delete any existing code, paste the Apps Script from <code>medisense-sheets.js</code> bottom</li>
            <li><b style="color:#7DD3FC">Deploy → New deployment → Web app</b><br>
                Execute as: <b>Me</b> · Who has access: <b>Anyone</b><br>
                Copy the URL → paste in <code>SHEETS_WEBAPP_URL</code></li>
          </ol>
          <div style="font-size:11px;color:#475569">Data stored: vitals, user names/emails (no passwords), login events</div>
          <button onclick="this.closest('#sheets-setup-modal').style.display='none'"
                  style="margin-top:16px;background:#1E293B;border:1px solid #334155;
                  border-radius:8px;padding:8px 20px;color:#CBD5E1;cursor:pointer;font-family:monospace">Close</button>
        </div>
      `;
      document.body.appendChild(m);
      m.addEventListener('click', e => { if (e.target === m) m.style.display = 'none'; });
    });
  }

})(window);

