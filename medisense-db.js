// ============================================================
//  MediSense AI — medisense-db.js
//  JSON Storage Layer (localStorage-backed)
//
//  Tables:
//    ms_users          → { id, email, password_hash, full_name, created_at }
//    ms_sessions       → { id, user_id, role, last_seen }
//    ms_vital_signs    → { id, recorded_by, heart_rate, spo2, temperature,
//                          bp_systolic, bp_diastolic, resp_rate, blood_glucose,
//                          recorded_at, created_at }
//    ms_otp_codes      → { id, user_id, email, code, expires_at, used, created_at }
//    ms_login_events   → { id, user_id, auth_method, user_agent, created_at }
//    ms_user_profiles  → { id, user_id, full_name, department, hospital_id,
//                          role, updated_at }
//
//  Usage:
//    <script src="medisense-db.js"></script>
//    then access window.DB and window.Session and window.hashPassword
// ============================================================

(function (global) {
  'use strict';

  // ----------------------------------------------------------
  //  CONSTANTS
  // ----------------------------------------------------------
  const PREFIX = 'ms_';

  // ----------------------------------------------------------
  //  CORE HELPERS
  // ----------------------------------------------------------

  /** Read all rows from a table. Always returns an array. */
  function all(table) {
    try {
      return JSON.parse(localStorage.getItem(PREFIX + table)) || [];
    } catch {
      return [];
    }
  }

  /** Overwrite all rows in a table. */
  function save(table, rows) {
    localStorage.setItem(PREFIX + table, JSON.stringify(rows));
  }

  /**
   * Insert a new row.
   * Auto-generates `id` (UUID) and `created_at` (ISO string).
   * Returns the inserted row.
   */
  function insert(table, row) {
    const rows   = all(table);
    const newRow = {
      id:         crypto.randomUUID(),
      created_at: new Date().toISOString(),
      ...row,
    };
    rows.push(newRow);
    save(table, rows);
    return newRow;
  }

  /**
   * Upsert a row — matches on `matchKey` field (default: 'id').
   * If a matching row is found it is merged; otherwise a new row is appended.
   * Returns the resulting row.
   */
  function upsert(table, row, matchKey = 'id') {
    const rows   = all(table);
    const idx    = rows.findIndex(r => r[matchKey] === row[matchKey]);
    const newRow = {
      id:         crypto.randomUUID(),
      created_at: new Date().toISOString(),
      ...row,
    };
    if (idx >= 0) {
      rows[idx] = { ...rows[idx], ...newRow };
    } else {
      rows.push(newRow);
    }
    save(table, rows);
    return idx >= 0 ? rows[idx] : newRow;
  }

  /**
   * Find the first row that satisfies `predicate`.
   * Returns the row object or null.
   */
  function find(table, predicate) {
    return all(table).find(predicate) || null;
  }

  /**
   * Return all rows that satisfy `predicate`.
   * Returns an array (empty if none match).
   */
  function filter(table, predicate) {
    return all(table).filter(predicate);
  }

  /**
   * Update all rows that satisfy `predicate` by merging `patch` into them.
   * Returns the number of rows updated.
   */
  function update(table, predicate, patch) {
    const rows    = all(table);
    let   count   = 0;
    const updated = rows.map(r => {
      if (predicate(r)) { count++; return { ...r, ...patch }; }
      return r;
    });
    save(table, updated);
    return count;
  }

  /**
   * Delete all rows that satisfy `predicate`.
   * Returns the number of rows deleted.
   */
  function remove(table, predicate) {
    const rows    = all(table);
    const kept    = rows.filter(r => !predicate(r));
    save(table, kept);
    return rows.length - kept.length;
  }

  /**
   * Count rows that satisfy an optional predicate.
   * Omit predicate to count all rows.
   */
  function count(table, predicate) {
    const rows = all(table);
    return predicate ? rows.filter(predicate).length : rows.length;
  }

  /**
   * Drop an entire table (delete its localStorage key).
   */
  function drop(table) {
    localStorage.removeItem(PREFIX + table);
  }

  /**
   * List all table names currently stored (strips the prefix).
   */
  function tables() {
    const result = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith(PREFIX)) result.push(key.slice(PREFIX.length));
    }
    return result;
  }

  // ----------------------------------------------------------
  //  PASSWORD HASHING  (Web Crypto SHA-256)
  //  Returns a hex string. Async.
  // ----------------------------------------------------------
  async function hashPassword(password) {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(password));
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // ----------------------------------------------------------
  //  SESSION  (sessionStorage — survives refresh, clears on tab close)
  // ----------------------------------------------------------
  const Session = {
    /** Return the currently logged-in user object, or null. */
    get() {
      try { return JSON.parse(sessionStorage.getItem('ms_current_user')); }
      catch { return null; }
    },

    /** Persist a user object as the active session. */
    set(user) {
      sessionStorage.setItem('ms_current_user', JSON.stringify(user));
    },

    /** Destroy the active session (logout). */
    clear() {
      sessionStorage.removeItem('ms_current_user');
    },
  };

  // ----------------------------------------------------------
  //  DEBUG HELPERS  (only available in non-production)
  // ----------------------------------------------------------
  const Debug = {
    /** Print a summary of all tables and their row counts to the console. */
    summary() {
      const t = tables();
      if (!t.length) { console.log('[MediSense DB] No tables found.'); return; }
      console.group('[MediSense DB] Storage summary');
      t.forEach(name => console.log(`  ${name}: ${count(name)} row(s)`));
      console.groupEnd();
    },

    /** Dump raw JSON for a table to the console. */
    dump(table) {
      console.log(`[MediSense DB] ${table}:`, all(table));
    },

    /** Wipe ALL MediSense data from localStorage. Use with caution. */
    reset() {
      tables().forEach(drop);
      Session.clear();
      console.warn('[MediSense DB] All data wiped.');
    },
  };

  // ----------------------------------------------------------
  //  PUBLIC API
  // ----------------------------------------------------------
  const DB = {
    all,
    save,
    insert,
    upsert,
    find,
    filter,
    update,
    remove,
    count,
    drop,
    tables,
    Debug,
  };

  // Expose on window so other scripts can use them directly
  global.DB           = DB;
  global.Session      = Session;
  global.hashPassword = hashPassword;

})(window);
