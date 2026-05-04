
(function (global) {
  'use strict';
  const PREFIX = 'ms_';
  function all(table) {
    try {
      return JSON.parse(localStorage.getItem(PREFIX + table)) || [];
    } catch {
      return [];
    }
  }
  function save(table, rows) {
    localStorage.setItem(PREFIX + table, JSON.stringify(rows));
  }
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

  function find(table, predicate) {
    return all(table).find(predicate) || null;
  }

  function filter(table, predicate) {
    return all(table).filter(predicate);
  }
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

  function remove(table, predicate) {
    const rows    = all(table);
    const kept    = rows.filter(r => !predicate(r));
    save(table, kept);
    return rows.length - kept.length;
  }

  function count(table, predicate) {
    const rows = all(table);
    return predicate ? rows.filter(predicate).length : rows.length;
  }

  function drop(table) {
    localStorage.removeItem(PREFIX + table);
  }

  function tables() {
    const result = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith(PREFIX)) result.push(key.slice(PREFIX.length));
    }
    return result;
  }

  async function hashPassword(password) {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(password));
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  const Session = {
    get() {
      try { return JSON.parse(sessionStorage.getItem('ms_current_user')); }
      catch { return null; }
    },

    set(user) {
      sessionStorage.setItem('ms_current_user', JSON.stringify(user));
    },

    clear() {
      sessionStorage.removeItem('ms_current_user');
    },
  };

  const Debug = {
    summary() {
      const t = tables();
      if (!t.length) { console.log('[MediSense DB] No tables found.'); return; }
      console.group('[MediSense DB] Storage summary');
      t.forEach(name => console.log(`  ${name}: ${count(name)} row(s)`));
      console.groupEnd();
    },

    dump(table) {
      console.log(`[MediSense DB] ${table}:`, all(table));
    },

    reset() {
      tables().forEach(drop);
      Session.clear();
      console.warn('[MediSense DB] All data wiped.');
    },
  };

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
