// ============================================================
//  MediSense AI — medisense.js
//  Application logic — requires medisense-db.js loaded first.
//  DB, Session, and hashPassword are provided by medisense-db.js
// ============================================================

// ============================================================
//  SHEETS DIRECT URL
// ============================================================
const SHEETS_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbwuV2DRzMDDUM0eyOPFWQk3oYTtClWyr6AXmLKHH5sxXqaNt6nFf3N-Ktn0PCla8lGP/exec';

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
  const session = DB.find('sessions', r => r.user_id === state.user.id);
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
  Sheets.logLogin(user.id, user.email, 'email_password');
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

  // ── Sync new user to Google Sheets (no password sent) ──
  Sheets.appendUser(newUser).then(r => {
    if (r.ok) console.log('[Sheets] User synced ✓');
  });

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
//  PATIENT SERIAL NUMBER SYSTEM
//  Family users get a simple number: 1, 2, 3...
//  This is stored in their profile and shown in the app.
//  The ESP32 PATIENT_ID must match this number.
// ============================================================
function getNextPatientNumber() {
  const profiles = DB.all('user_profiles');
  const existing = profiles
    .map(p => Number(p.patient_number))
    .filter(n => !isNaN(n) && n > 0);
  return existing.length > 0 ? Math.max(...existing) + 1 : 1;
}

function assignPatientNumber(userId) {
  const profile = DB.find('user_profiles', p => p.user_id === userId);
  if (profile?.patient_number) return profile.patient_number; // already assigned
  const num = getNextPatientNumber();
  DB.update('user_profiles', p => p.user_id === userId, { patient_number: num });
  return num;
}

function getPatientNumber(userId) {
  const profile = DB.find('user_profiles', p => p.user_id === userId);
  return profile?.patient_number || null;
}

// ============================================================
//  ROLE SELECTION
// ============================================================
qsa('[data-role]').forEach(btn => {
  btn.addEventListener('click', () => {
    const role = btn.dataset.role;

    // ── Admin password gate ──────────────────────────────
    if (role === 'admin') {
      const entered = prompt('🛡️ Enter Admin Password:');
      if (entered === null) return;
      if (entered !== 'medisense') {
        showToast('Incorrect admin password', 'error');
        return;
      }
    }

    state.role = role;

    // ── Assign sequential patient number for family users ─
    if (role === 'family') {
      const num = assignPatientNumber(state.user.id);
      state.patientNumber = num;
      showToast(`Your Patient ID is: ${num} — use this in ESP32`, 'success');
    }

    DB.upsert('sessions', {
      user_id: state.user.id, role, last_seen: new Date().toISOString(),
    }, 'user_id');

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
  navigateTo('dashboard');

  // Show/hide role-specific nav items
  const doctorNav = $('doctor-only-nav');
  const adminNav  = $('admin-only-nav');
  if (doctorNav) doctorNav.style.display = state.role === 'doctor' ? 'flex' : 'none';
  if (adminNav)  adminNav.style.display  = state.role === 'admin'  ? 'flex' : 'none';

  // Admin goes straight to admin panel, others load vitals
  if (state.role === 'admin') {
    navigateTo('admin');
  } else {
    loadVitals();
    // Auto-refresh vitals from Sheets every 30 seconds
    if (window._vitalsInterval) clearInterval(window._vitalsInterval);
    window._vitalsInterval = setInterval(() => {
      loadVitals();
      console.log('[MediSense] Auto-refreshed vitals from Sheets');
    }, 30_000);
  }
}

function setupUserUI() {
  const email   = state.user?.email || '';
  const name    = state.user?.full_name || email.split('@')[0];
  const initial = name.charAt(0).toUpperCase();
  const role    = state.role || 'user';

  $('sidebar-avatar').textContent = initial;
  $('sidebar-name').textContent   = name;
  $('topbar-role').textContent    = role;
  $('dashboard-greeting').textContent = `Welcome back, ${name}`;

  // Show patient number for family users
  if (role === 'family') {
    const num = getPatientNumber(state.user.id);
    $('sidebar-role').textContent = num ? `Patient #${num}` : 'Family';
    // Show patient number in a prominent banner
    const existing = $('patient-id-banner');
    if (!existing) {
      const banner = document.createElement('div');
      banner.id = 'patient-id-banner';
      banner.style.cssText = `
        background:var(--accent);color:#fff;text-align:center;
        padding:8px;font-size:13px;font-weight:600;letter-spacing:0.5px;
      `;
      banner.innerHTML = `📟 Your Patient ID: <strong style="font-size:16px">${num}</strong> &nbsp;|&nbsp; Set this as PATIENT_ID in your ESP32`;
      document.querySelector('.main-content')?.prepend(banner);
    }
  } else {
    $('sidebar-role').textContent = role;
  }

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
  if (viewId === 'admin')   loadAdminPanel();
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
//  PATIENT-DOCTOR ASSIGNMENT SYSTEM
// ============================================================

/** Assign a patient to a doctor (removes any existing assignment first) */
function assignPatientToDoctor(doctorId, patientId) {
  DB.remove('assignments', a => a.patient_id === patientId);
  const assignment = DB.insert('assignments', {
    doctor_id:   doctorId,
    patient_id:  patientId,
    assigned_at: new Date().toISOString(),
  });
  // Sync to Sheets
  if (Sheets.isConfigured()) {
    Sheets.appendAssignment && Sheets.appendAssignment(assignment);
  }
  return assignment;
}

/** Get all patients assigned to a specific doctor */
function getPatientsForDoctor(doctorId) {
  const assignments = DB.filter('assignments', a => a.doctor_id === doctorId);
  return assignments.map(a => DB.find('users', u => u.id === a.patient_id)).filter(Boolean);
}

/** Render the admin panel */
async function loadAdminPanel() {
  const allUsers    = DB.all('users');
  const allSessions = DB.all('sessions');

  // Separate doctors and patients by their saved session role
  const doctors  = allUsers.filter(u => allSessions.find(s => s.user_id === u.id && s.role === 'doctor'));
  const patients = allUsers.filter(u => allSessions.find(s => s.user_id === u.id && s.role === 'family'));

  // Also pull from Sheets if configured
  if (Sheets.isConfigured()) {
    try {
      const res = await fetch(`${SHEETS_WEBAPP_URL}?action=getUsers`);
      const data = await res.json();
      if (data.ok && data.data?.length) {
        data.data.forEach(u => {
          if (!DB.find('users', r => r.id === u.id)) {
            DB.insert('users', { ...u, password_hash: '' });
          }
        });
      }
    } catch (e) { /* silently skip */ }
  }

  const assignments = DB.all('assignments');

  // ── Render patients table ────────────────────────────────
  const patientsTbody = $('admin-patients-tbody');
  if (patientsTbody) {
    if (!patients.length) {
      patientsTbody.innerHTML = `<tr><td colspan="4" style="padding:20px;text-align:center;color:var(--ink-soft)">No patients registered yet — patients register with Family role</td></tr>`;
    } else {
      patientsTbody.innerHTML = patients.map(p => {
        const assignment = assignments.find(a => a.patient_id === p.id);
        const doctor     = assignment ? DB.find('users', u => u.id === assignment.doctor_id) : null;
        const docLabel   = doctor
          ? `<span style="color:var(--accent)">${doctor.full_name}</span>`
          : `<span style="color:var(--ink-soft)">Unassigned</span>`;
        return `
          <tr style="border-bottom:1px solid var(--rule)">
            <td style="padding:10px 12px;color:var(--ink);font-weight:500">${p.full_name}</td>
            <td style="padding:10px 12px;color:var(--ink-soft)">${p.email}</td>
            <td style="padding:10px 12px">${docLabel}</td>
            <td style="padding:10px 12px">
              <button class="btn-sm assign-btn" data-patient-id="${p.id}" data-patient-name="${p.full_name}"
                style="font-size:12px;padding:4px 12px">
                ${assignment ? 'Reassign' : 'Assign →'}
              </button>
            </td>
          </tr>`;
      }).join('');
    }
  }

  // ── Render doctors table ─────────────────────────────────
  const doctorsTbody = $('admin-doctors-tbody');
  if (doctorsTbody) {
    if (!doctors.length) {
      doctorsTbody.innerHTML = `<tr><td colspan="3" style="padding:20px;text-align:center;color:var(--ink-soft)">No doctors registered yet — doctors register with Doctor role</td></tr>`;
    } else {
      doctorsTbody.innerHTML = doctors.map(d => {
        const count = assignments.filter(a => a.doctor_id === d.id).length;
        return `
          <tr style="border-bottom:1px solid var(--rule)">
            <td style="padding:10px 12px;color:var(--ink);font-weight:500">${d.full_name}</td>
            <td style="padding:10px 12px;color:var(--ink-soft)">${d.email}</td>
            <td style="padding:10px 12px">
              <span style="background:var(--rule);padding:2px 10px;border-radius:20px;font-size:12px;color:var(--ink)">
                ${count} patient${count !== 1 ? 's' : ''}
              </span>
            </td>
          </tr>`;
      }).join('');
    }
  }

  // ── Bind assign buttons ──────────────────────────────────
  let currentPatientId   = null;
  let currentPatientName = null;

  qsa('.assign-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentPatientId   = btn.dataset.patientId;
      currentPatientName = btn.dataset.patientName;

      $('assign-patient-label').textContent = `Patient: ${currentPatientName}`;

      // Populate doctor dropdown
      const sel = $('assign-doctor-select');
      sel.innerHTML = '<option value="">— Select a doctor —</option>' +
        doctors.map(d => `<option value="${d.id}">${d.full_name}</option>`).join('');

      // Pre-select current doctor if assigned
      const existing = assignments.find(a => a.patient_id === currentPatientId);
      if (existing) sel.value = existing.doctor_id;

      $('assign-modal').style.display = 'flex';
    });
  });

  $('assign-confirm-btn').onclick = () => {
    const doctorId = $('assign-doctor-select').value;
    if (!doctorId) { showToast('Please select a doctor', 'error'); return; }
    assignPatientToDoctor(doctorId, currentPatientId);
    $('assign-modal').style.display = 'none';
    showToast(`${currentPatientName} assigned successfully ✓`, 'success');
    loadAdminPanel(); // re-render
  };

  $('assign-cancel-btn').onclick = () => {
    $('assign-modal').style.display = 'none';
  };

  // Refresh button
  const refreshBtn = $('admin-refresh-btn');
  if (refreshBtn) refreshBtn.onclick = loadAdminPanel;
}

// ============================================================
//  SIGN-OUT
// ============================================================
$('logout-btn').addEventListener('click', () => {
  if (window._vitalsInterval) clearInterval(window._vitalsInterval);
  Session.clear();
  state.user = null;
  state.role = null;
  showToast('Signed out', 'info');
  showAuthWrapper();
});

// ============================================================
//  VITALS — Fetch directly from Google Sheets (no localStorage sync)
// ============================================================
async function loadVitals() {
  if (state.role === 'admin') return;

  const role       = state.role || 'family';
  const userId     = state.user.id;                          // UUID from localStorage
  const patientNum = String(getPatientNumber(userId) || ''); // "1", "2" … or ""
  const userName   = (state.user.full_name || state.user.email || '').toLowerCase();

  // Build a set of all identifiers this patient might appear as in Sheets
  const myIds = new Set([
    userId,
    patientNum,
    userName,
    state.user.email || '',
  ].filter(Boolean).map(s => String(s).toLowerCase()));

  console.log('[Vitals] Matching against IDs:', [...myIds]);

  try {
    // ── Fetch ALL vitals (role=doctor returns everything; family returns all rows
    //    so we can do client-side fuzzy match by UUID, name, or patient number) ──
    const url  = `${SHEETS_WEBAPP_URL}?action=getVitals&role=doctor&userId=`;
    const res  = await fetch(url);
    const data = await res.json();

    if (data.ok && data.data?.length) {
      let vitals = data.data.sort((a, b) =>
        String(b.recorded_at).localeCompare(String(a.recorded_at)));

      if (role === 'doctor') {
        // Doctor: show only vitals for their assigned patients
        const myPatients   = getPatientsForDoctor(userId);
        const patientIdSet = new Set();
        myPatients.forEach(p => {
          patientIdSet.add(String(p.id).toLowerCase());
          patientIdSet.add(String(getPatientNumber(p.id) || '').toLowerCase());
          patientIdSet.add((p.full_name || '').toLowerCase());
          patientIdSet.add((p.email || '').toLowerCase());
        });
        if (patientIdSet.size > 0) {
          vitals = vitals.filter(v =>
            patientIdSet.has(String(v.recorded_by || '').toLowerCase()) ||
            patientIdSet.has(String(v.patient_name || '').toLowerCase())
          );
        }
      } else {
        // Family/patient: match by UUID, patient number, name, or email
        vitals = vitals.filter(v =>
          myIds.has(String(v.recorded_by   || '').toLowerCase()) ||
          myIds.has(String(v.patient_name  || '').toLowerCase())
        );
      }

      state.vitals = vitals.slice(0, 20);
      console.log(`[Vitals] Loaded ${state.vitals.length} reading(s) from Sheets`);
    } else {
      // Fallback: localStorage
      state.vitals = DB.filter('vital_signs', v => v.recorded_by === userId)
        .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))
        .slice(0, 20);
      console.warn('[Vitals] Sheets returned no data, using localStorage fallback');
    }
  } catch (err) {
    console.warn('[Vitals] Sheets fetch failed:', err.message);
    state.vitals = DB.filter('vital_signs', v => v.recorded_by === userId)
      .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))
      .slice(0, 20);
  }

  renderDashboardStats();
  renderVitalsTable('vitals-tbody', state.vitals.slice(0, 5));
  checkAlerts();

  const lastEl = $('last-updated');
  if (lastEl && state.vitals.length > 0) {
    lastEl.textContent = 'Updated ' + timeAgo(state.vitals[0].recorded_at);
  }
  if ($('readings-count')) {
    $('readings-count').textContent = state.vitals.length;
  }
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

  // ── Sync to Google Sheets ──
  Sheets.appendVital(savedVital).then(r => {
    if (r.ok) console.log('[Sheets] Vital synced ✓');
    else      console.warn('[Sheets] Vital sync failed:', r.error);
  });

  setLoading(btn, false);

  showToast('Vitals saved!', 'success');
  $('vitals-form').reset();
  loadVitals();
  navigateTo('dashboard');
});

async function loadHistory() {
  try {
    const role       = state.role || 'family';
    const userId     = state.user?.id || '';
    const patientNum = String(getPatientNumber(userId) || '');
    const userName   = (state.user?.full_name || state.user?.email || '').toLowerCase();

    // Same fuzzy ID set as loadVitals
    const myIds = new Set([userId, patientNum, userName, state.user?.email || '']
      .filter(Boolean).map(s => String(s).toLowerCase()));

    const url  = `${SHEETS_WEBAPP_URL}?action=getVitals&role=doctor&userId=`;
    const res  = await fetch(url);
    const data = await res.json();

    if (data.ok && data.data?.length) {
      const all = data.data
        .filter(v => role === 'doctor' ||
          myIds.has(String(v.recorded_by  || '').toLowerCase()) ||
          myIds.has(String(v.patient_name || '').toLowerCase())
        )
        .sort((a, b) => String(b.recorded_at).localeCompare(String(a.recorded_at)))
        .slice(0, 100);
      renderVitalsTable('history-tbody', all);
    } else {
      // Fallback to localStorage
      const all = DB.filter('vital_signs', v => v.recorded_by === state.user.id)
        .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))
        .slice(0, 100);
      renderVitalsTable('history-tbody', all);
    }
  } catch (err) {
    console.warn('[History] Sheets fetch failed, using local data:', err.message);
    const all = DB.filter('vital_signs', v => v.recorded_by === state.user.id)
      .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))
      .slice(0, 100);
    renderVitalsTable('history-tbody', all);
  }
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
