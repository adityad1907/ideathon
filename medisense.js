// ============================================================
//  MediSense AI — medisense.js
//  Application logic — requires medisense-db.js loaded first.
//  DB, Session, and hashPassword are provided by medisense-db.js
// ============================================================

// ============================================================
//  APP STATE
// ============================================================
const state = {
  user:        null,
  role:        null,   // 'doctor' | 'family'
  vitals:      [],
  alerts:      [],
  resendTimer: null,
  otpSession:  null,   // { user, email, password }
};

// ============================================================
//  DOM HELPERS
// ============================================================
const $ = id => document.getElementById(id);
const qsa = sel => document.querySelectorAll(sel);

function showToast(msg, type = 'info') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  t.getBoundingClientRect();
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 4000);
}

function setLoading(btn, loading) {
  if (!btn) return;
  const span    = btn.querySelector('span');
  const spinner = btn.querySelector('.spinner');
  btn.disabled  = loading;
  if (span)    span.classList.toggle('hidden', loading);
  if (spinner) spinner.classList.toggle('hidden', !loading);
}

function showScreen(id) {
  qsa('.auth-card').forEach(c => c.classList.remove('active'));
  const target = $(id);
  if (target) target.classList.add('active');
}

// ============================================================
//  BOOT — restore session on page load
// ============================================================
async function init() {
  const saved = Session.get();
  if (saved) {
    state.user = saved;
    await loadUserRole();
  }
}

async function loadUserRole() {
  // Always look up the session for the CURRENT user only
  const sessions = DB.filter('sessions', r => r.user_id === state.user.id);
  // Sort by last_seen descending to get the most recent session
  sessions.sort((a, b) => (b.last_seen || '').localeCompare(a.last_seen || ''));
  const session = sessions[0] || null;

  if (session?.role) {
    state.role = session.role;
    enterApp();
  } else {
    showScreen('screen-role');
  }
}

// ============================================================
//  SIGN-IN (Email + Password)
// ============================================================
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email    = $('login-email').value.trim();
  const password = $('login-password').value;

  if (!email || !password) {
    showToast('Please fill in both fields', 'error'); return;
  }

  const btn = $('login-btn');
  setLoading(btn, true);

  const hash = await hashPassword(password);
  const user = DB.find('users', u => u.email === email && u.password_hash === hash);

  setLoading(btn, false);

  if (!user) {
    showToast('Incorrect email or password. Check your details and try again.', 'error'); return;
  }

  state.user = user;
  Session.set(user);
  logLoginEvent(user.id, 'email_password');
  // role not known yet at login time — it's chosen on next screen; logged after role selection
  showToast('Signed in successfully!', 'success');
  await loadUserRole();
});

// ============================================================
//  SIGN-UP
// ============================================================
$('signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name  = $('signup-name').value.trim();
  const email = $('signup-email').value.trim();
  const pw1   = $('signup-password').value;
  const pw2   = $('signup-password2').value;

  if (!name)             { showToast('Please enter your full name', 'error'); return; }
  if (!email)            { showToast('Please enter your email address', 'error'); return; }
  if (!pw1)              { showToast('Please enter a password', 'error'); return; }
  if (pw1.length < 8)    { showToast('Password must be at least 8 characters', 'error'); return; }
  if (pw1 !== pw2)       { showToast('Passwords do not match', 'error'); return; }

  const existing = DB.find('users', u => u.email === email);
  if (existing) {
    showToast('An account with this email already exists. Try signing in instead.', 'error'); return;
  }

  const btn = $('signup-btn');
  setLoading(btn, true);

  const password_hash = await hashPassword(pw1);
  const newUser = DB.insert('users', { email, password_hash, full_name: name });

  DB.insert('user_profiles', {
    user_id: newUser.id, full_name: name, created_at: new Date().toISOString(),
  });

  // ── Sync new user to Google Sheets (role sent after role selection) ──
  // We store the user object so we can push it with role after the next screen
  state._pendingSheetUser = newUser;

  setLoading(btn, false);

  state.user = newUser;
  Session.set(newUser);
  showToast('Account created! Welcome to MediSense.', 'success');
  await loadUserRole();
});

window.resetSignupForm = function() {
  const loginTab = document.querySelector('.tab[data-tab="login"]');
  if (loginTab) loginTab.click();
  location.reload();
};

// ============================================================
//  GOOGLE "OAUTH" — demo mode (no real OAuth without a server)
// ============================================================
$('google-btn').addEventListener('click', () => {
  showToast('Google login requires a server. Use email/password instead.', 'info');
});

// ============================================================
//  OTP FLOW  (simulated — code shown in console)
// ============================================================
$('otp-link').addEventListener('click', (e) => {
  e.preventDefault(); showScreen('screen-otp');
});
$('back-from-otp').addEventListener('click', () => showScreen('screen-login'));

// Step 1: verify credentials, store OTP locally
$('otp-request-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email    = $('otp-email').value.trim();
  const password = $('otp-password').value;
  if (!email || !password) { showToast('Enter email and password', 'error'); return; }

  const btn = $('send-otp-btn');
  setLoading(btn, true);

  const hash = await hashPassword(password);
  const user = DB.find('users', u => u.email === email && u.password_hash === hash);

  if (!user) {
    setLoading(btn, false);
    showToast('Invalid credentials — please check email and password', 'error'); return;
  }

  state.otpSession = { user, email, password };

  // Generate OTP and persist to local JSON store
  const code      = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  DB.insert('otp_codes', { user_id: user.id, email, code, expires_at: expiresAt, used: false });

  console.log(`%c🔐 OTP Code: ${code}`, 'font-size:18px;color:#0EA5E9;font-weight:bold');
  showToast('OTP generated — check browser console (demo mode)', 'info');

  setLoading(btn, false);
  $('otp-verify-section').classList.remove('hidden');
  startResendTimer();
});

// Step 2: verify OTP digits
$('verify-otp-btn').addEventListener('click', () => {
  const digits = Array.from(qsa('.otp-digit')).map(i => i.value).join('');
  if (digits.length < 6) { showToast('Enter all 6 digits', 'error'); return; }

  const btn = $('verify-otp-btn');
  setLoading(btn, true);

  const now  = new Date().toISOString();
  const { email } = state.otpSession;

  const record = DB.filter('otp_codes', r =>
    r.email === email && r.code === digits && !r.used && r.expires_at > now
  ).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

  if (!record) {
    setLoading(btn, false);
    showToast('Invalid or expired OTP — please try again', 'error'); return;
  }

  DB.update('otp_codes', r => r.id === record.id, { used: true });

  const user = state.otpSession.user;
  state.user = user;
  Session.set(user);
  logLoginEvent(user.id, 'email_otp');

  setLoading(btn, false);
  showToast('OTP verified! Signing in…', 'success');
  loadUserRole();
});

// OTP digit auto-advance
qsa('.otp-digit').forEach((input, i, all) => {
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(-1);
    if (input.value && i < all.length - 1) all[i + 1].focus();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !input.value && i > 0) all[i - 1].focus();
  });
});

// Resend OTP timer
function startResendTimer() {
  const btn     = $('resend-otp-btn');
  const timerEl = $('resend-timer');
  btn.disabled  = true;
  let seconds   = 60;
  clearInterval(state.resendTimer);
  state.resendTimer = setInterval(() => {
    seconds--;
    timerEl.textContent = seconds;
    if (seconds <= 0) {
      clearInterval(state.resendTimer);
      btn.disabled = false;
      timerEl.textContent = '0';
    }
  }, 1000);
}

$('resend-otp-btn').addEventListener('click', () => {
  $('otp-request-form').dispatchEvent(new Event('submit'));
});

// ============================================================
//  FORGOT PASSWORD — demo mode
// ============================================================
$('forgot-link').addEventListener('click', (e) => {
  e.preventDefault(); showScreen('screen-forgot');
});
$('back-from-forgot').addEventListener('click', () => showScreen('screen-login'));

$('forgot-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const email = $('forgot-email').value.trim();
  if (!email) { showToast('Enter your email address', 'error'); return; }

  const user = DB.find('users', u => u.email === email);
  // Always show success message (don't leak whether email exists)
  const tempPass = Math.random().toString(36).slice(-8);
  if (user) {
    console.log(`%c🔑 Temporary password for ${email}: ${tempPass}`, 'font-size:15px;color:#0EA5E9;');
    showToast('Temporary password shown in console (demo mode)', 'success');
  } else {
    showToast('If that email exists, a reset link would be sent.', 'success');
  }
  setTimeout(() => showScreen('screen-login'), 2500);
});

// ============================================================
//  ROLE SELECTION
// ============================================================
qsa('[data-role]').forEach(btn => {
  btn.addEventListener('click', () => {
    const role = btn.dataset.role;
    state.role = role;

    // Remove any existing session for this user first, then insert fresh
    DB.remove('sessions', r => r.user_id === state.user.id);
    DB.insert('sessions', {
      user_id: state.user.id, role, last_seen: new Date().toISOString(),
    });

    // Now that we know the role, push user to correct Sheets tab
    if (state._pendingSheetUser) {
      Sheets.appendUser(state._pendingSheetUser, role).then(r => {
        if (r.ok) console.log(`[Sheets] User synced to ${role === 'doctor' ? 'Doctors' : 'Patient'} sheet ✓`);
      });
      state._pendingSheetUser = null;
    }

    // Log login event with role now known
    Sheets.logLogin(state.user.id, state.user.email, 'role_selected', role);

    enterApp();
  });
});

// ============================================================
//  APP ENTRY
// ============================================================
function showAuthWrapper() {
  $('auth-wrapper').classList.remove('hidden');
  $('app').classList.add('hidden');
  showScreen('screen-login');
}

function enterApp() {
  $('auth-wrapper').classList.add('hidden');
  $('app').classList.remove('hidden');
  setupUserUI();
  loadVitals();
  navigateTo('dashboard');

  // Notify ESP32 module that user is logged in
  document.dispatchEvent(new CustomEvent('medisense:loggedin', { detail: state.user }));

  const doctorNav = $('doctor-only-nav');
  if (doctorNav) doctorNav.style.display = state.role === 'doctor' ? 'flex' : 'none';

  // Update dashboard subtitle based on role
  const viewSub = document.querySelector('#view-dashboard .view-sub');
  if (viewSub) {
    viewSub.textContent = state.role === 'doctor'
      ? 'Showing all patients\' latest vitals'
      : 'Your personal vitals summary';
  }

  // ── Pull latest data from Google Sheets and merge locally ──
  if (Sheets.isConfigured()) {
    showToast('Syncing with Google Sheets…', 'info');
    Sheets.fullSync(state.user.id, state.role).then(() => {
      loadVitals();
      showToast('Synced with Google Sheets ✓', 'success');
    }).catch(() => {
      showToast('Sheets sync failed — using local data', 'info');
    });
  }
}

function setupUserUI() {
  const email   = state.user?.email || '';
  const name    = state.user?.full_name || email.split('@')[0];
  const initial = name.charAt(0).toUpperCase();
  const role    = state.role || 'user';

  $('sidebar-avatar').textContent = initial;
  $('sidebar-name').textContent   = name;
  $('sidebar-role').textContent   = role;
  $('topbar-role').textContent    = role;
  $('dashboard-greeting').textContent = `Welcome back, ${name}`;

  if ($('p-name'))  $('p-name').value  = name;
  if ($('p-email')) $('p-email').value = email;
  $('profile-avatar-lg').textContent   = initial;
}

// ============================================================
//  NAVIGATION
// ============================================================
function navigateTo(viewId) {
  qsa('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.view === viewId));
  qsa('.view').forEach(v  => v.classList.toggle('active', v.id === `view-${viewId}`));
  if (viewId === 'history') loadHistory();
}

qsa('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    navigateTo(item.dataset.view);
    $('sidebar').classList.remove('open');
  });
});

$('menu-toggle').addEventListener('click', () => {
  $('sidebar').classList.toggle('open');
});

// ============================================================
//  AUTH TABS (Login / Sign-up)
// ============================================================
qsa('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    qsa('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const which = tab.dataset.tab;
    $('login-form').classList.toggle('hidden',  which !== 'login');
    $('signup-form').classList.toggle('hidden', which !== 'signup');
  });
});

// Password toggle
qsa('.eye-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = $(btn.dataset.target);
    input.type = input.type === 'password' ? 'text' : 'password';
  });
});

// ============================================================
//  SIGN-OUT
// ============================================================
$('logout-btn').addEventListener('click', () => {
  Session.clear();
  state.user = null;
  state.role = null;
  showToast('Signed out', 'info');
  showAuthWrapper();
});

// ============================================================
//  VITALS — Load from local JSON store
//  Doctors see ALL patients' vitals; family sees only their own.
// ============================================================
function loadVitals() {
  let all;
  if (state.role === 'doctor') {
    // Doctors see every recorded vital, newest first
    all = DB.all('vital_signs')
      .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))
      .slice(0, 50);
  } else {
    // Family / patient sees only their own readings
    all = DB.filter('vital_signs', v => v.recorded_by === state.user.id)
      .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))
      .slice(0, 20);
  }

  state.vitals = all;
  renderDashboardStats();
  renderVitalsTable('vitals-tbody', state.vitals.slice(0, 5));
  checkAlerts();

  const lastEl = $('last-updated');
  if (lastEl && state.vitals.length > 0) {
    lastEl.textContent = 'Updated ' + timeAgo(state.vitals[0].recorded_at);
  }
  $('readings-count').textContent = state.vitals.length;
}

function renderDashboardStats() {
  const v = state.vitals[0];
  if (!v) return;

  setStatVal('stat-hr',      v.heart_rate,    'bpm',   'stat-hr-status',      checkHR);
  setStatVal('stat-spo2',    v.spo2,          '%',     'stat-spo2-status',    checkSpO2);
  setStatVal('stat-temp',    v.temperature,   '°C',    'stat-temp-status',    checkTemp);
  setStatVal('stat-resp',    v.resp_rate,     '/min',  'stat-resp-status',    checkResp);
  setStatVal('stat-glucose', v.blood_glucose, 'mg/dL', 'stat-glucose-status', checkGlucose);

  const bpEl = $('stat-bp');
  if (bpEl && v.bp_systolic != null) {
    bpEl.innerHTML = `${v.bp_systolic}/${v.bp_diastolic} <span>mmHg</span>`;
    applyStatus('stat-bp-status', checkBP(v.bp_systolic, v.bp_diastolic));
  }
}

function setStatVal(elId, val, unit, statusId, checkFn) {
  const el = $(elId);
  if (!el || val == null) return;
  el.innerHTML = `${parseFloat(val).toFixed(val % 1 === 0 ? 0 : 1)} <span>${unit}</span>`;
  applyStatus(statusId, checkFn(val));
}

function applyStatus(elId, { label, cls }) {
  const el = $(elId);
  if (!el) return;
  el.textContent = label;
  el.className = `stat-status ${cls}`;
}

function getPatientName(userId) {
  if (userId === state.user.id) return 'You';
  const user = DB.find('users', u => u.id === userId);
  if (user) return user.full_name || user.email.split('@')[0];
  const profile = DB.find('user_profiles', p => p.user_id === userId);
  if (profile) return profile.full_name || '—';
  return 'Unknown';
}

function renderVitalsTable(tbodyId, vitals) {
  const tbody = $(tbodyId);
  if (!tbody) return;
  const isDoctor = state.role === 'doctor';

  // Update column headers dynamically
  const thead = tbody.closest('table')?.querySelector('thead tr');
  if (thead && isDoctor && !thead.querySelector('.patient-col')) {
    const th = document.createElement('th');
    th.className = 'patient-col';
    th.textContent = 'Patient';
    thead.insertBefore(th, thead.firstChild);
  } else if (thead && !isDoctor) {
    const existing = thead.querySelector('.patient-col');
    if (existing) existing.remove();
  }

  if (!vitals.length) {
    const cols = isDoctor ? 8 : 7;
    tbody.innerHTML = `<tr><td colspan="${cols}" class="empty-row">No readings yet</td></tr>`;
    return;
  }
  tbody.innerHTML = vitals.map(v => `
    <tr>
      ${isDoctor ? `<td class="patient-name-cell">${getPatientName(v.recorded_by)}</td>` : ''}
      <td>${formatTime(v.recorded_at)}</td>
      <td>${v.heart_rate ?? '—'}</td>
      <td>${v.spo2 ?? '—'}</td>
      <td>${v.temperature ?? '—'}</td>
      <td>${v.bp_systolic != null ? `${v.bp_systolic}/${v.bp_diastolic}` : '—'}</td>
      <td>${v.resp_rate ?? '—'}</td>
      <td>${v.blood_glucose ?? '—'}</td>
    </tr>
  `).join('');
}

// ── Alerts ────────────────────────────────────────────────
function checkAlerts() {
  state.alerts = [];
  const v = state.vitals[0];
  if (!v) return;

  const checks = [
    { label: 'Heart Rate',   val: v.heart_rate,    fn: checkHR },
    { label: 'SpO₂',        val: v.spo2,           fn: checkSpO2 },
    { label: 'Temperature', val: v.temperature,    fn: checkTemp },
    { label: 'Resp. Rate',  val: v.resp_rate,      fn: checkResp },
    { label: 'Glucose',     val: v.blood_glucose,  fn: checkGlucose },
  ];

  checks.forEach(({ label, val, fn }) => {
    if (val == null) return;
    const { cls } = fn(val);
    if (cls === 'crit' || cls === 'warn') {
      state.alerts.push({ label, val, cls, time: v.recorded_at });
    }
  });

  if (v.bp_systolic != null) {
    const { cls } = checkBP(v.bp_systolic, v.bp_diastolic);
    if (cls !== 'ok') state.alerts.push({ label: 'Blood Pressure', val: `${v.bp_systolic}/${v.bp_diastolic}`, cls, time: v.recorded_at });
  }

  const badge = $('alert-badge');
  badge.textContent = state.alerts.length || '';

  const list = $('alerts-list');
  if (!list) return;
  if (!state.alerts.length) {
    list.innerHTML = '<p class="empty-state">No alerts — all vitals within normal range ✓</p>';
    return;
  }
  list.innerHTML = state.alerts.map(a => `
    <div class="alert-item ${a.cls === 'warn' ? 'warn' : ''}">
      <div class="alert-label">⚠ ${a.label}: ${a.val}</div>
      <div class="alert-time">${formatTime(a.time)}</div>
    </div>
  `).join('');
}

// ── Range checks ─────────────────────────────────────────
const checkHR      = v => v < 50 || v > 120  ? { label: 'CRITICAL', cls: 'crit' } : v < 60 || v > 100 ? { label: 'WARNING', cls: 'warn' } : { label: 'Normal', cls: 'ok' };
const checkSpO2    = v => v < 90             ? { label: 'CRITICAL', cls: 'crit' } : v < 95             ? { label: 'LOW', cls: 'warn' }     : { label: 'Normal', cls: 'ok' };
const checkTemp    = v => v > 39.5 || v < 35 ? { label: 'CRITICAL', cls: 'crit' } : v > 37.5           ? { label: 'FEVER', cls: 'warn' }   : { label: 'Normal', cls: 'ok' };
const checkResp    = v => v < 8  || v > 30   ? { label: 'CRITICAL', cls: 'crit' } : v < 12 || v > 20   ? { label: 'WARNING', cls: 'warn' } : { label: 'Normal', cls: 'ok' };
const checkGlucose = v => v < 50 || v > 400  ? { label: 'CRITICAL', cls: 'crit' } : v < 70 || v > 180  ? { label: 'WARNING', cls: 'warn' } : { label: 'Normal', cls: 'ok' };
const checkBP      = (s, d) => s > 180 || d > 120 ? { label: 'CRISIS', cls: 'crit' } : s > 140 || d > 90 ? { label: 'HIGH', cls: 'warn' } : { label: 'Normal', cls: 'ok' };

// ============================================================
//  SAVE VITALS → local JSON store
// ============================================================
$('vitals-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = $('save-vitals-btn');

  const payload = {
    recorded_by:   state.user.id,
    recorded_at:   new Date().toISOString(),
    heart_rate:    parseNum($('f-hr').value),
    spo2:          parseNum($('f-spo2').value),
    temperature:   parseNum($('f-temp').value),
    bp_systolic:   parseNum($('f-sys').value),
    bp_diastolic:  parseNum($('f-dia').value),
    resp_rate:     parseNum($('f-resp').value),
    blood_glucose: parseNum($('f-glucose').value),
  };

  // Remove null fields (except required ones)
  const vitalsOnly = { ...payload };
  delete vitalsOnly.recorded_by;
  delete vitalsOnly.recorded_at;
  Object.keys(vitalsOnly).forEach(k => vitalsOnly[k] == null && delete vitalsOnly[k]);

  if (Object.keys(vitalsOnly).length === 0) {
    showToast('Enter at least one vital sign', 'error'); return;
  }

  setLoading(btn, true);
  const savedVital = DB.insert('vital_signs', payload);

  // ── Sync to Google Sheets (route to VitalSigns or Vitals based on role) ──
  Sheets.appendVital(savedVital, state.role).then(r => {
    if (r.ok) console.log(`[Sheets] Vital synced to ${state.role === 'doctor' ? 'VitalSigns' : 'Vitals'} ✓`);
    else      console.warn('[Sheets] Vital sync failed:', r.error);
  });

  setLoading(btn, false);

  showToast('Vitals saved!', 'success');
  $('vitals-form').reset();
  loadVitals();
  navigateTo('dashboard');
});

function loadHistory() {
  let all;
  if (state.role === 'doctor') {
    all = DB.all('vital_signs')
      .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))
      .slice(0, 100);
  } else {
    all = DB.filter('vital_signs', v => v.recorded_by === state.user.id)
      .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))
      .slice(0, 100);
  }
  renderVitalsTable('history-tbody', all);
}

$('export-btn').addEventListener('click', () => {
  if (!state.vitals.length) { showToast('No data to export', 'error'); return; }
  const headers = ['Time', 'HR', 'SpO2', 'Temp', 'Sys_BP', 'Dia_BP', 'Resp', 'Glucose'];
  const rows = state.vitals.map(v => [
    formatTime(v.recorded_at), v.heart_rate, v.spo2, v.temperature,
    v.bp_systolic, v.bp_diastolic, v.resp_rate, v.blood_glucose,
  ]);
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const a   = document.createElement('a');
  a.href    = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `medisense-vitals-${Date.now()}.csv`;
  a.click();
});

$('refresh-btn').addEventListener('click', () => {
  loadVitals();
  showToast('Refreshed', 'info');
});

$('clear-alerts-btn').addEventListener('click', () => {
  state.alerts = [];
  $('alert-badge').textContent = '';
  $('alerts-list').innerHTML = '<p class="empty-state">No alerts — all vitals within normal range ✓</p>';
});

// ============================================================
//  AI INSIGHT
// ============================================================
$('get-insight-btn').addEventListener('click', async () => {
  const v = state.vitals[0];
  if (!v) { showToast('No vitals data available', 'error'); return; }

  const btn  = $('get-insight-btn');
  const body = $('insight-body');
  btn.disabled   = true;
  btn.textContent = 'Generating…';
  body.innerHTML  = '<p class="insight-placeholder">Analysing vitals…</p>';

  const prompt = `You are a clinical AI assistant. Briefly analyse these patient vitals and highlight anything concerning. Be concise (3–5 sentences). Do not give diagnoses.

Vitals:
- Heart Rate: ${v.heart_rate ?? 'N/A'} bpm
- SpO₂: ${v.spo2 ?? 'N/A'}%
- Temperature: ${v.temperature ?? 'N/A'}°C
- Blood Pressure: ${v.bp_systolic ?? 'N/A'}/${v.bp_diastolic ?? 'N/A'} mmHg
- Respiratory Rate: ${v.resp_rate ?? 'N/A'}/min
- Blood Glucose: ${v.blood_glucose ?? 'N/A'} mg/dL
- Recorded: ${formatTime(v.recorded_at)}`;

  try {
    const res  = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    const text = data?.content?.[0]?.text || 'No insight generated.';
    body.innerHTML = `<p>${text.replace(/\n/g, '<br/>')}</p>`;
  } catch {
    body.innerHTML = `<p class="insight-placeholder">Could not generate insight. Check your network connection.</p>`;
  }

  btn.disabled    = false;
  btn.textContent = 'Generate →';
});

// ============================================================
//  PROFILE — Save to local JSON store
// ============================================================
$('save-profile-btn').addEventListener('click', () => {
  const btn = $('save-profile-btn');
  setLoading(btn, true);

  DB.upsert('user_profiles', {
    user_id:     state.user.id,
    full_name:   $('p-name')?.value.trim(),
    department:  $('p-dept')?.value.trim(),
    hospital_id: $('p-hospital')?.value.trim(),
    role:        state.role,
    updated_at:  new Date().toISOString(),
  }, 'user_id');

  setLoading(btn, false);
  showToast('Profile saved!', 'success');
});

// ============================================================
//  AUDIT LOG
// ============================================================
function logLoginEvent(userId, method) {
  DB.insert('login_events', {
    user_id:     userId,
    auth_method: method,
    user_agent:  navigator.userAgent.slice(0, 200),
  });
}

// ============================================================
//  UTILITIES
// ============================================================
function parseNum(val) {
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m    = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

// ============================================================
//  BOOT
// ============================================================
init();
