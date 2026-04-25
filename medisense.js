// ============================================================
//  MediSense AI — medisense.js
//  Supabase Auth + Vitals DB integration
//  ES Module (type="module" in index.html)
// ============================================================

// ── 1. SUPABASE CONFIG ──────────────────────────────────────
//  ⚠️  Replace these two values with your real Supabase project
//  ─────────────────────────────────────────────────────────
//  Where to find them:
//    Supabase Dashboard → Project Settings → API
//    • SUPABASE_URL  = "Project URL"      (e.g. https://abcd1234.supabase.co)
//    • SUPABASE_ANON = "anon public" key  (long string starting with "eyJ…")
// ─────────────────────────────────────────────────────────
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL  = 'https://eaalludhxkowngpnixvc.supabase.co';
const SUPABASE_ANON = 'sb_publishable_bwnZLItQfzPJOSAaRZrSdA_0PaUzIu_';

// ── Detect unconfigured state early ─────────────────────────
const SUPABASE_CONFIGURED = (
  SUPABASE_URL.includes('supabase.co') &&
  SUPABASE_ANON.length > 10
);

let supabase;
if (SUPABASE_CONFIGURED) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON);
} else {

  const notConfigured = () => Promise.resolve({
    data: null,
    error: { message: '⚙️ Supabase is not configured yet. Open medisense.js and replace YOUR_PROJECT_ID and YOUR_ANON_PUBLIC_KEY with your real values.' }
  });
  supabase = {
    auth: {
      getSession:       () => Promise.resolve({ data: { session: null } }),
      signInWithPassword: notConfigured,
      signUp:           notConfigured,
      signInWithOAuth:  notConfigured,
      signOut:          () => Promise.resolve({}),
      resetPasswordForEmail: notConfigured,
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: () => ({
      select: () => ({ eq: () => ({ single: notConfigured, order: () => ({ limit: () => ({ single: notConfigured }) }) }) }),
      insert: notConfigured,
      upsert: notConfigured,
      update: () => ({ eq: notConfigured }),
    }),
  };

  window.addEventListener('DOMContentLoaded', () => {
    const banner = document.createElement('div');
    banner.style.cssText = `
      position:fixed; bottom:0; left:0; right:0; z-index:99999;
      background:#0EA5E9; color:white; font-family:monospace;
      font-size:13px; padding:10px 20px; text-align:center;
      border-top:3px solid #0284C7; line-height:1.6;
    `;
    banner.innerHTML = `
      ⚙️ <strong>Supabase not connected.</strong>
      Open <code>medisense.js</code> and replace
      <code>YOUR_PROJECT_ID</code> &amp; <code>YOUR_ANON_PUBLIC_KEY</code>
      with your real values from
      <a href="https://supabase.com/dashboard" target="_blank" style="color:#fff;text-decoration:underline;">
        supabase.com/dashboard
      </a>
      → Project Settings → API
    `;
    document.body.appendChild(banner);
  });
}

// ============================================================
//  APP STATE
// ============================================================
const state = {
  user:        null,
  role:        null,   // 'doctor' | 'family'
  vitals:      [],
  alerts:      [],
  resendTimer: null,
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
  t.getBoundingClientRect(); // force reflow
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

// ── Screen navigation ─────────────────────────────────────
function showScreen(id) {
  qsa('.auth-card').forEach(c => c.classList.remove('active'));
  const target = $(id);
  if (target) target.classList.add('active');
}

// ============================================================
//  AUTH — Bootstrap on page load
// ============================================================
async function init() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user) {
    state.user = session.user;
    await loadUserRole();
  }
}

async function loadUserRole() {
  const { data } = await supabase
    .from('user_sessions')
    .select('role')
    .eq('user_id', state.user.id)
    .single();

  if (data?.role) {
    state.role = data.role;
    enterApp();
  } else {
    showScreen('screen-role');
  }
}

// ── Auth state change listener ─────────────────────────────
supabase.auth.onAuthStateChange(async (event, session) => {
  if (event === 'SIGNED_IN' && session) {
    state.user = session.user;
    await loadUserRole();
  }
  if (event === 'SIGNED_OUT') {
    state.user = null;
    state.role = null;
    showAuthWrapper();
  }
});

// ============================================================
//  SIGN-IN (Email + Password)
// ============================================================
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email    = $('login-email').value.trim();
  const password = $('login-password').value;

  if (!email || !password) {
    showToast('Please fill in both fields', 'error');
    return;
  }

  const btn = $('login-btn');
  setLoading(btn, true);

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  setLoading(btn, false);

  if (error) {
    // Provide clear, user-friendly error messages
    if (error.message.includes('Invalid login credentials')) {
      showToast('Incorrect email or password. Check your details and try again.', 'error');
    } else if (error.message.includes('Email not confirmed')) {
      showToast('Please check your email and click the confirmation link first.', 'error');
    } else {
      showToast(error.message, 'error');
    }
    return;
  }

  await logLoginEvent(data.user.id, 'email_password');
  showToast('Signed in successfully!', 'success');
});

// ============================================================
//  SIGN-UP
//
//  FIX: Supabase by default requires email confirmation.
//  Two options:
//    A) Disable email confirmation in Supabase Dashboard →
//       Authentication → Settings → "Enable email confirmations" → OFF
//       (recommended for development/internal tools)
//    B) Keep confirmation ON and guide user to check email.
//
//  This code does BOTH: it shows the right message either way.
// ============================================================
$('signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name  = $('signup-name').value.trim();
  const email = $('signup-email').value.trim();
  const pw1   = $('signup-password').value;
  const pw2   = $('signup-password2').value;

  // ── Validation ──
  if (!name)  { showToast('Please enter your full name', 'error'); return; }
  if (!email) { showToast('Please enter your email address', 'error'); return; }
  if (!pw1)   { showToast('Please enter a password', 'error'); return; }
  if (pw1.length < 8) { showToast('Password must be at least 8 characters', 'error'); return; }
  if (pw1 !== pw2)    { showToast('Passwords do not match', 'error'); return; }

  const btn = $('signup-btn');
  setLoading(btn, true);

  const { data, error } = await supabase.auth.signUp({
    email,
    password: pw1,
    options: {
      data: { full_name: name },
      // emailRedirectTo tells Supabase where to send the user after they confirm
      emailRedirectTo: window.location.href,
    },
  });

  setLoading(btn, false);

  if (error) {
    if (error.message.includes('User already registered')) {
      showToast('An account with this email already exists. Try signing in instead.', 'error');
    } else {
      showToast(error.message, 'error');
    }
    return;
  }

  // Create profile row immediately (works regardless of confirmation status)
  if (data.user) {
    await supabase.from('user_profiles').upsert({
      user_id:    data.user.id,
      full_name:  name,
      created_at: new Date().toISOString(),
    });
  }

  // Detect whether Supabase sent a confirmation email or auto-confirmed
  const isAutoConfirmed = data.user && data.session;

  if (isAutoConfirmed) {
    // Email confirmation is OFF in Supabase → user is instantly signed in
    showToast('Account created! Welcome to MediSense.', 'success');
    // onAuthStateChange will fire and take them to role selection automatically
  } else {
    // Email confirmation is ON → show clear instructions
    showSignupSuccess(email);
  }
});

// Show a friendly "check your email" state after signup
function showSignupSuccess(email) {
  // Replace the signup form content with a success message
  const form = $('signup-form');
  form.innerHTML = `
    <div style="text-align:center; padding: 8px 0;">
      <div style="font-size:2.5rem; margin-bottom:12px;">📧</div>
      <h3 style="font-size:1.1rem; font-weight:600; color:#0F172A; margin-bottom:8px;">
        Check your inbox
      </h3>
      <p style="color:#475569; font-size:.875rem; line-height:1.6; margin-bottom:16px;">
        We sent a confirmation link to<br>
        <strong style="color:#0EA5E9;">${email}</strong>
      </p>
      <p style="color:#94A3B8; font-size:.8rem; line-height:1.6; margin-bottom:20px;">
        Click the link in the email, then come back here and sign in.
        <br>Check your spam folder if you don't see it.
      </p>
      <button onclick="resetSignupForm()" style="
        background:#F0F9FF; color:#0EA5E9; border:1.5px solid #BAE6FD;
        border-radius:8px; padding:8px 20px; font-size:.875rem;
        font-weight:500; cursor:pointer;">
        ← Back to Sign In
      </button>
    </div>
  `;
}

// Exposed globally so the inline onclick works
window.resetSignupForm = function() {
  // Switch to login tab and reset signup form
  const loginTab = document.querySelector('.tab[data-tab="login"]');
  if (loginTab) loginTab.click();

  // Rebuild the signup form (in case it was replaced)
  location.reload();
};

// ============================================================
//  GOOGLE OAUTH
// ============================================================
$('google-btn').addEventListener('click', async () => {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.href },
  });
  if (error) showToast(error.message, 'error');
});

// ============================================================
//  OTP FLOW
// ============================================================
let otpSession = null;

$('otp-link').addEventListener('click', (e) => {
  e.preventDefault();
  showScreen('screen-otp');
});
$('back-from-otp').addEventListener('click', () => showScreen('screen-login'));

// Step 1: Verify password, then store OTP in DB
$('otp-request-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email    = $('otp-email').value.trim();
  const password = $('otp-password').value;
  if (!email || !password) { showToast('Enter email and password', 'error'); return; }

  const btn = $('send-otp-btn');
  setLoading(btn, true);

  // Verify credentials first
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    setLoading(btn, false);
    showToast('Invalid credentials — please check email and password', 'error');
    return;
  }

  // Sign back out — they still need to pass OTP
  await supabase.auth.signOut();
  otpSession = { user: data.user, email, password };

  // Generate + store OTP
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  await supabase.from('otp_codes').insert({
    user_id: data.user.id, email, code, expires_at: expiresAt,
  });

  // In production: send via email (Resend / SendGrid Edge Function)
  console.log(`%c🔐 OTP Code: ${code}`, 'font-size:18px;color:#0EA5E9;font-weight:bold');
  showToast('OTP generated — check browser console (demo mode)', 'info');

  setLoading(btn, false);
  $('otp-verify-section').classList.remove('hidden');
  startResendTimer();
});

// Step 2: Verify OTP digits
$('verify-otp-btn').addEventListener('click', async () => {
  const digits = Array.from(qsa('.otp-digit')).map(i => i.value).join('');
  if (digits.length < 6) { showToast('Enter all 6 digits', 'error'); return; }

  const btn = $('verify-otp-btn');
  setLoading(btn, true);

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('otp_codes')
    .select('*')
    .eq('email', otpSession.email)
    .eq('code', digits)
    .eq('used', false)
    .gt('expires_at', now)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    setLoading(btn, false);
    showToast('Invalid or expired OTP — please try again', 'error');
    return;
  }

  // Mark OTP as used
  await supabase.from('otp_codes').update({ used: true }).eq('id', data.id);

  // Now actually sign in
  const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({
    email: otpSession.email, password: otpSession.password,
  });

  setLoading(btn, false);
  if (signInErr) { showToast(signInErr.message, 'error'); return; }

  await logLoginEvent(signInData.user.id, 'email_otp');
  showToast('OTP verified! Signing in…', 'success');
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
  const btn = $('resend-otp-btn');
  const timerEl = $('resend-timer');
  btn.disabled = true;
  let seconds = 60;
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
//  FORGOT PASSWORD
// ============================================================
$('forgot-link').addEventListener('click', (e) => {
  e.preventDefault();
  showScreen('screen-forgot');
});
$('back-from-forgot').addEventListener('click', () => showScreen('screen-login'));

$('forgot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('forgot-email').value.trim();
  if (!email) { showToast('Enter your email address', 'error'); return; }

  const btn = $('forgot-btn');
  setLoading(btn, true);

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}?reset=true`,
  });

  setLoading(btn, false);
  if (error) { showToast(error.message, 'error'); return; }
  showToast('Reset link sent — check your email (and spam folder)', 'success');
  setTimeout(() => showScreen('screen-login'), 2000);
});

// ============================================================
//  ROLE SELECTION → Supabase user_sessions
// ============================================================
qsa('[data-role]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const role = btn.dataset.role;
    state.role = role;

    await supabase.from('user_sessions').upsert({
      user_id: state.user.id, role, last_seen: new Date().toISOString(),
    });

    enterApp();
  });
});

// ============================================================
//  APP ENTRY — hide auth, show dashboard
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

  // Show doctor-only nav items
  const doctorNav = $('doctor-only-nav');
  if (doctorNav) doctorNav.style.display = state.role === 'doctor' ? 'flex' : 'none';
}

function setupUserUI() {
  const email   = state.user?.email || '';
  const meta    = state.user?.user_metadata;
  const name    = meta?.full_name || meta?.name || email.split('@')[0];
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
$('logout-btn').addEventListener('click', async () => {
  await supabase.auth.signOut();
  showToast('Signed out', 'info');
});

// ============================================================
//  VITALS — Load latest from Supabase
// ============================================================
async function loadVitals() {
  const { data, error } = await supabase
    .from('vital_signs')
    .select('*')
    .order('recorded_at', { ascending: false })
    .limit(20);

  if (error) { console.error(error); return; }

  state.vitals = data || [];
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

function renderVitalsTable(tbodyId, vitals) {
  const tbody = $(tbodyId);
  if (!tbody) return;
  if (!vitals.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-row">No readings yet</td></tr>';
    return;
  }
  tbody.innerHTML = vitals.map(v => `
    <tr>
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
//  SAVE VITALS → Supabase
// ============================================================
$('vitals-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('save-vitals-btn');

  const payload = {
    recorded_by:   state.user.id,
    heart_rate:    parseNum($('f-hr').value),
    spo2:          parseNum($('f-spo2').value),
    temperature:   parseNum($('f-temp').value),
    bp_systolic:   parseNum($('f-sys').value),
    bp_diastolic:  parseNum($('f-dia').value),
    resp_rate:     parseNum($('f-resp').value),
    blood_glucose: parseNum($('f-glucose').value),
  };

  Object.keys(payload).forEach(k => payload[k] == null && delete payload[k]);

  if (Object.keys(payload).length <= 1) {
    showToast('Enter at least one vital sign', 'error'); return;
  }

  setLoading(btn, true);
  const { error } = await supabase.from('vital_signs').insert(payload);
  setLoading(btn, false);

  if (error) { showToast(error.message, 'error'); return; }

  showToast('Vitals saved!', 'success');
  $('vitals-form').reset();
  await loadVitals();
  navigateTo('dashboard');
});

async function loadHistory() {
  const { data, error } = await supabase
    .from('vital_signs')
    .select('*')
    .order('recorded_at', { ascending: false })
    .limit(100);

  renderVitalsTable('history-tbody', data || []);
}

$('export-btn').addEventListener('click', () => {
  if (!state.vitals.length) { showToast('No data to export', 'error'); return; }
  const headers = ['Time', 'HR', 'SpO2', 'Temp', 'Sys_BP', 'Dia_BP', 'Resp', 'Glucose'];
  const rows = state.vitals.map(v => [
    formatTime(v.recorded_at), v.heart_rate, v.spo2, v.temperature,
    v.bp_systolic, v.bp_diastolic, v.resp_rate, v.blood_glucose,
  ]);
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
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

  const btn = $('get-insight-btn');
  const body = $('insight-body');
  btn.disabled = true;
  btn.textContent = 'Generating…';
  body.innerHTML = '<p class="insight-placeholder">Analysing vitals…</p>';

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
    const res = await fetch('https://api.anthropic.com/v1/messages', {
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
  } catch (err) {
    body.innerHTML = `<p class="insight-placeholder">Could not generate insight. Check your network connection.</p>`;
  }

  btn.disabled = false;
  btn.textContent = 'Generate →';
});

// ============================================================
//  PROFILE — Save to user_profiles
// ============================================================
$('save-profile-btn').addEventListener('click', async () => {
  const btn = $('save-profile-btn');
  setLoading(btn, true);

  const { error } = await supabase.from('user_profiles').upsert({
    user_id:     state.user.id,
    full_name:   $('p-name')?.value.trim(),
    department:  $('p-dept')?.value.trim(),
    hospital_id: $('p-hospital')?.value.trim(),
    role:        state.role,
    updated_at:  new Date().toISOString(),
  });

  setLoading(btn, false);
  if (error) { showToast(error.message, 'error'); return; }
  showToast('Profile saved!', 'success');
});

// ============================================================
//  AUDIT LOG
// ============================================================
async function logLoginEvent(userId, method) {
  await supabase.from('login_events').insert({
    user_id: userId,
    auth_method: method,
    user_agent: navigator.userAgent.slice(0, 200),
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
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

// ============================================================
//  BOOT
// ============================================================
init();
