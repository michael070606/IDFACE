/* ===== SETTINGS: your Supabase URL and anon key (edit these two lines) ===== */
// settings.js - the only file you edit to connect to Supabase.
// Supabase Dashboard -> Project Settings -> API. Use the "anon / public" key.
// NEVER put the service_role key in browser code.
const SUPABASE_URL = 'https://kmwynslbfkumbvvltlin.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_w2IBu7rDK4MUgyKF8yqgag_8T-PUupD';

/* ===== DATABASE: the only calls the page makes to Supabase ===== */
// database.js - the only functions the browser may call (all go through the functions in sql/schema.sql).
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });

const Api = {
  async rpc(fn, args = {}) {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw new Error(error.message);
    return data;
  },

  // session token (sessionStorage: cleared when the tab closes)
  token: () => sessionStorage.getItem('iv_token'),
  setToken(t) { t ? sessionStorage.setItem('iv_token', t) : sessionStorage.removeItem('iv_token'); },

  roles:         () => Api.rpc('iv_list_roles'),
  signup:        (email, pin, role) => Api.rpc('iv_signup', { p_email: email, p_pin: pin, p_role: role, p_consent: true }),
  cancelSignup:  () => Api.rpc('iv_cancel_signup', { p_token: Api.token() }),
  pinLogin:      (email, pin) => Api.rpc('iv_pin_login', { p_email: email, p_pin: pin }),
  faceLogin:     descriptor => Api.rpc('iv_face_login', { p_descriptor: descriptor }),
  me:            () => Api.rpc('iv_me', { p_token: Api.token() }),
  reportFailure: kind => Api.rpc('iv_report_failure', { p_token: Api.token(), p_kind: kind }),
  saveId:        (type, fields, confidence, descriptor) =>
                   Api.rpc('iv_save_id', { p_token: Api.token(), p_id_type: type, p_fields: fields, p_confidence: confidence, p_descriptor: descriptor }),
  saveFace:      frames => Api.rpc('iv_save_face', { p_token: Api.token(), p_frames: frames }),
  getRecord:     () => Api.rpc('iv_get_record', { p_token: Api.token() }),
  saveInfo:      fields => Api.rpc('iv_save_info', { p_token: Api.token(), p_fields: fields }),
  listPending:   () => Api.rpc('iv_list_pending', { p_token: Api.token() }),
  decide:        (userId, action, role, reason) =>
                   Api.rpc('iv_decide', { p_token: Api.token(), p_user_id: userId, p_action: action, p_role: role || null, p_reason: reason || '' }),
  async logout() { try { await Api.rpc('iv_logout', { p_token: Api.token() }); } finally { Api.setToken(null); } }
};
window.Api = Api;

/* ===== RULES: ID text parsing, pose check, age, blur check ===== */
// rules.js - pure functions (no DOM, no network). Safe to unit test in Node.
(function (root) {
  'use strict';

  const CONFIG = {
    // Face models are downloaded once from this CDN (needs internet on first load)
    MODEL_URL: 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/model/',
    MIN_OCR_CONF: 0.40,        // Tesseract average confidence (0-1)
    MIN_SHARPNESS: 40,         // blur check on the ID photo
    TURN_LEFT_MIN: 0.56,       // nose position across the face: > this = turned to own left
    TURN_RIGHT_MAX: 0.44,      //                                  < this = turned to own right
    CLOSER_FACTOR: 1.12,       // face must be at least 12% wider than the straight capture
    FARTHER_FACTOR: 0.90,      // face must be at least 10% narrower than the straight capture
    SAME_PERSON_DIST: 0.8,     // client-side sanity check between two frames
    REQUIRED: ['full_name', 'dob', 'id_number'],
    ID_TYPES: {
      philid: 'Philippine National ID (PhilSys)',
      drivers: "Driver's License",
      passport: 'Passport',
      umid: 'UMID'
    },
    POSES: [
      { key: 'straight', text: 'Look straight at the camera' },
      { key: 'left',     text: 'Look to your left' },
      { key: 'right',    text: 'Look to your right' },
      { key: 'closer',   text: 'Move closer to the camera' },
      { key: 'farther',  text: 'Move slightly farther away' }
    ]
  };

  /* ---------------------------------------------------------- dates */
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  function iso(y, m, d) {
    y = +y; m = +m; d = +d;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  function findDates(text) {
    const out = [];
    for (const m of text.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) out.push(iso(m[1], m[2], m[3]));
    for (const m of text.matchAll(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/g)) {
      const a = +m[1], b = +m[2];
      out.push(a <= 12 ? iso(m[3], a, b) : iso(m[3], b, a));         // MM-DD-YYYY unless the first part is > 12
    }
    for (const m of text.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/g)) {
      const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
      if (mon) out.push(iso(m[3], mon, m[2]));
    }
    for (const m of text.matchAll(/\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\b/g)) {
      const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
      if (mon) out.push(iso(m[3], mon, m[1]));
    }
    return out.filter(Boolean);
  }

  /* ---------------------------------------------------------- ID text parsing */
  const ID_PATTERNS = {
    philid:   /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/,
    drivers:  /\b[A-Z]\d{2}[- ]?\d{2}[- ]?\d{6}\b/,
    umid:     /\b\d{4}[- ]?\d{7}[- ]?\d\b/,
    passport: /\b[A-Z]\d{7}[A-Z]\b/
  };
  const looksLikeIdNumber = line => Object.values(ID_PATTERNS).some(pattern => pattern.test(line.toUpperCase()));
  const FIELD_LABELS = [
    'date of birth', 'date of expiry', 'valid until', 'residential address', 'given names', 'given name',
    'first name', 'last name', 'middle name', 'gitnang apelyido', 'mga pangalan', 'full name',
    'postal code', 'surname', 'nationality', 'signature', 'address', 'tirahan', 'kapanganakan',
    'apelyido', 'pangalan', 'id number', 'id no', 'crn', 'birth', 'expiry', 'expiration',
    'license', 'sex', 'name', 'date', 'blood', 'agency'
  ];
  const looksLikeLabel = s => FIELD_LABELS.some(w => new RegExp('\\b' + w.replace(/\s+/g, '\\s+') + '\\b', 'i').test(s));
  const trimJunk = s => s.replace(/^[\s:/-]+|[\s:/-]+$/g, '');
  const titleCase = s => s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  const cleanName = s => titleCase(s.replace(/[^A-Za-z.' -]/g, ' ').replace(/\s+/g, ' ').trim());

  function trimFollowingFields(value) {
    const stop = /\b(?:date of birth|date of expiry|valid until|postal code|id number|id no|crn|birth|address|tirahan|kapanganakan|nationality|signature|expiry|expiration|license|sex)\b/i;
    const match = stop.exec(value);
    return trimJunk(match ? value.slice(0, match.index) : value);
  }

  function trimAtFieldLabel(value, currentLabels) {
    const current = new Set(currentLabels);
    const alternatives = FIELD_LABELS.filter(label => !current.has(label))
      .sort((a, b) => b.length - a.length)
      .map(label => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
    const match = new RegExp('\\b(?:' + alternatives.join('|') + ')\\b', 'i').exec(value);
    return trimFollowingFields(match ? value.slice(0, match.index) : value);
  }

  function valueAfter(lines, labels, take = 1) {
    const ordered = labels.slice().sort((a, b) => b.length - a.length);
    for (let i = 0; i < lines.length; i++) {
      for (const lab of ordered) {
        const label = new RegExp('\\b' + lab.replace(/\s+/g, '\\s+') + '\\b', 'i').exec(lines[i]);
        if (!label) continue;
        if (lab === 'name' && /\b(?:first|last|middle|given)\s$/i.test(lines[i].slice(0, label.index))) continue;
        const rest = trimAtFieldLabel(lines[i].slice(label.index + label[0].length), labels);
        if (rest.length >= 2 && !looksLikeLabel(rest)) return rest;

        const next = [];
        for (const line of lines.slice(i + 1)) {
          if (looksLikeLabel(line) || looksLikeIdNumber(line) || findDates(line).length) break;
          if (line.length >= 2) next.push(line);
          if (next.length >= take) break;
        }
        if (next.length) return next.join(' ');
      }
    }
    return '';
  }

  function nameFromCommaLine(raw, header) {
    const parts = raw.split(',').map(part => part.trim()).filter(Boolean);
    if (parts.length < 2) return cleanName(raw);
    if (header && /last name/.test(header) && /first name/.test(header)) {
      return cleanName(parts.slice(1).join(' ') + ' ' + parts[0]);
    }
    return cleanName(parts.slice(1).join(' ') + ' ' + parts[0]);
  }

  function parseName(lines) {
    for (let i = 0; i < lines.length; i++) {
      const low = lines[i].toLowerCase();
      if (low.includes('last name') && low.includes('first name')) {
        if (lines[i].includes(':')) {
          const lastInline = valueAfter([lines[i]], ['last name']);
          const givenInline = valueAfter([lines[i]], ['first name', 'given names', 'given name']);
          const middleInline = valueAfter([lines[i]], ['middle name']);
          if (lastInline && givenInline) return cleanName(givenInline + ' ' + middleInline + ' ' + lastInline);
        }
        if (i + 1 < lines.length) {
          const raw = trimFollowingFields(lines[i + 1]);
          if (raw && raw.includes(',')) return nameFromCommaLine(raw, low);
          if (raw && !looksLikeLabel(raw)) return cleanName(raw);
        }
      }
    }
    const last = valueAfter(lines, ['last name', 'surname', 'apelyido']);
    const given = valueAfter(lines, ['given names', 'given name', 'mga pangalan', 'first name']);
    const middle = valueAfter(lines, ['middle name', 'gitnang apelyido']);
    if (last && given) return cleanName(given + ' ' + middle + ' ' + last);
    const full = valueAfter(lines, ['full name', 'pangalan', 'name'], 2);
    if (full) return cleanName(full.replace(/,/g, ' '));
    return '';
  }

  function parseAddress(lines) {
    const labels = ['address', 'tirahan'];
    for (let i = 0; i < lines.length; i++) {
      for (const lab of labels) {
        const label = new RegExp('\\b' + lab + '\\b', 'i').exec(lines[i]);
        if (!label) continue;
        const parts = [];
        const inline = trimFollowingFields(lines[i].slice(label.index + label[0].length));
        if (inline.length >= 2 && !looksLikeLabel(inline)) parts.push(inline);
        for (const line of lines.slice(i + 1)) {
          if (looksLikeLabel(line) || looksLikeIdNumber(line) || parts.length >= 3) break;
          const part = trimFollowingFields(line);
          if (part.length >= 2) parts.push(part);
          if (part.length < line.length) break;
        }
        return parts.join(' ').replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ').trim();
      }
    }
    return '';
  }

  function dateNear(lines, keys, span = 2) {
    for (let i = 0; i < lines.length; i++) {
      if (keys.some(k => lines[i].toLowerCase().includes(k))) {
        const found = findDates(lines.slice(i, i + 1 + span).join(' '));
        if (found.length) return found[0];
      }
    }
    return '';
  }

  function parseIdText(rawText, idType) {
    const lines = String(rawText || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const joined = lines.join(' ').toUpperCase();
    const pattern = ID_PATTERNS[idType];
    const m = pattern ? joined.match(pattern) : null;
    let dob = dateNear(lines, ['birth', 'kapanganakan']);
    if (!dob) { const all = findDates(lines.join(' ')).sort(); dob = all[0] || ''; }
    return {
      lines,
      fields: {
        full_name: parseName(lines),
        dob,
        address: parseAddress(lines),
        id_number: m ? m[0].replace(/ /g, '-') : '',
        expiry: dateNear(lines, ['expir', 'valid until', 'date of expiry'])
      }
    };
  }

  // Readability check: required fields present and OCR confident enough
  function checkOcr(parsed, confidence) {
    const missing = CONFIG.REQUIRED.filter(k => !parsed.fields[k]).map(k => k.replace('_', ' '));
    if (missing.length || confidence < CONFIG.MIN_OCR_CONF) {
      const why = missing.length ? 'Could not read: ' + missing.join(', ') + '.' : 'The text is not clear enough.';
      return { ok: false, message: why + ' Upload a clearer, flat photo without glare.' };
    }
    return { ok: true };
  }

  /* ---------------------------------------------------------- face pose */
  // points = 68 landmarks [{x,y}]. Frames are NOT mirrored, so the person's left appears on the image's right.
  function poseFromLandmarks(points, boxWidth, imageWidth) {
    const xs = [points[0].x, points[16].x];
    const span = Math.max(Math.abs(xs[1] - xs[0]), 1);
    const ratioAcross = (points[30].x - Math.min(xs[0], xs[1])) / span;   // 0.5 = nose centred
    const label = ratioAcross > CONFIG.TURN_LEFT_MIN ? 'left' : ratioAcross < CONFIG.TURN_RIGHT_MAX ? 'right' : 'straight';
    return { label, ratio: boxWidth / imageWidth };
  }

  // infos: { straight, left, right, closer, farther } -> { label, ratio } or null when no face was found
  function checkPoses(infos) {
    const s = infos.straight;
    if (!s || s.label !== 'straight') return { ok: false, passed: [], failed: ['straight'] };
    const passed = [], failed = [];
    for (const p of CONFIG.POSES.map(x => x.key)) {
      const i = infos[p];
      (poseMatches(p, i, s) ? passed : failed).push(p);
    }
    return { ok: passed.length >= 4, passed, failed };
  }

  function poseMatches(pose, info, straight) {
    if (!info) return false;
    if (pose === 'straight' || pose === 'left' || pose === 'right') return info.label === pose;
    if (!straight || straight.label !== 'straight' || info.label !== 'straight') return false;
    if (pose === 'closer') return info.ratio >= straight.ratio * CONFIG.CLOSER_FACTOR;
    if (pose === 'farther') return info.ratio <= straight.ratio * CONFIG.FARTHER_FACTOR;
    return false;
  }

  /* ---------------------------------------------------------- misc */
  function calcAge(dobIso, today = new Date()) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dobIso || '');
    if (!m || !iso(m[1], m[2], m[3])) return null;
    let age = today.getFullYear() - +m[1];
    const md = today.getMonth() + 1 - +m[2];
    if (md < 0 || (md === 0 && today.getDate() < +m[3])) age--;
    return age >= 0 && age <= 110 ? age : null;
  }

  function validateInfo(f) {
    if (!String(f.full_name || '').trim() || !String(f.id_number || '').trim()) return 'Full name and ID number are required.';
    if (calcAge(f.dob) === null) return 'Enter a valid date of birth.';
    return '';
  }

  // Blur check: variance of the Laplacian on a grayscale image (low = blurry)
  function laplacianVariance(gray, w, h) {
    let sum = 0, sumSq = 0, n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const v = gray[i - w] + gray[i + w] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
        sum += v; sumSq += v * v; n++;
      }
    }
    const mean = sum / n;
    return sumSq / n - mean * mean;
  }

  const api = { CONFIG, findDates, parseIdText, checkOcr, poseFromLandmarks, poseMatches, checkPoses, calcAge, validateInfo, laplacianVariance };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BusinessLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);

/* ===== MAIN: screens, camera, OCR, face matching ===== */
// main.js - screens and wiring. Pure rules live in rules.js, database calls in database.js.
(() => {
  'use strict';
  const BL = window.BusinessLogic, Api = window.Api, CFG = BL.CONFIG;
  const $ = id => document.getElementById(id);
  const SCREENS = ['home', 'login', 'signup', 'id', 'face', 'info', 'result', 'dashboard', 'approvals'];
  const STEP_OF = { id: 1, face: 2, info: 3, result: 5 };       // 5 = every step shown as done
  let me = null, roles = [], modelsReady = false;

  /* ------------------------------------------------------------ helpers */
  function show(name) {
    SCREENS.forEach(s => { $('screen-' + s).hidden = s !== name; });
    const step = STEP_OF[name];
    $('stepper').hidden = !step;
    if (step) [...$('stepper').children].forEach((li, i) => { li.className = i + 1 < step ? 'done' : i + 1 === step ? 'now' : ''; });
    $('btn-logout').hidden = !Api.token();
    $('btn-logout').textContent = me && me.status === 'unverified' ? 'Cancel registration' : 'Log out';
    $('who').hidden = !me; if (me) $('who').textContent = me.email;
    window.scrollTo(0, 0);
  }
  function say(id, text, kind = 'bad') { const el = $(id); el.textContent = text || ''; el.className = 'alert ' + kind; el.hidden = !text; }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const roleLabel = key => (roles.find(r => r.key === key) || {}).label || key || '';
  function lockText(isoTime) {
    if (!isoTime || new Date(isoTime) <= new Date()) return '';
    return 'Too many failed attempts. Try again after ' + new Date(isoTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '.';
  }
  function fillRoles(select) {
    select.querySelectorAll('option:not([value=""])').forEach(o => o.remove());
    roles.forEach(r => select.add(new Option(r.label, r.key)));
  }
  async function refreshMe() {
    const r = await Api.me();
    if (!r.ok) { Api.setToken(null); me = null; return false; }
    me = r; return true;
  }

  /* ------------------------------------------------------------ camera + face models */
  async function startCam(video) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
      throw new Error('Camera access is unavailable. Use a supported browser over HTTPS or use your PIN.');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false
    });
    video.srcObject = stream;
    try {
      await video.play();
      if (!video.videoWidth || !video.videoHeight) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('The camera did not produce a video frame. Check camera permissions and try again.')), 5000);
          video.addEventListener('loadeddata', () => { clearTimeout(timeout); resolve(); }, { once: true });
        });
      }
    } catch (error) {
      stopCam(video);
      throw error;
    }
  }
  function stopCam(video) { if (video.srcObject) video.srcObject.getTracks().forEach(t => t.stop()); video.srcObject = null; }
  function snap(video) {                                     // raw, un-mirrored frame
    const c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    return c;
  }
  async function countdown(el, n) { for (let i = n; i > 0; i--) { el.textContent = i; await sleep(1000); } el.textContent = ''; }

  async function ensureModels(onStatus) {
    if (modelsReady) return;

    await window.faceApiReady;

    onStatus('Loading face models (first time only)...');
    await Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri(CFG.MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(CFG.MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(CFG.MODEL_URL)
    ]);
    modelsReady = true;
  }

  const detectorOptions = () => new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 });
  // One live frame -> pose + 128-number face template, or null when no face is found
  async function describe(canvas) {
    const faces = await faceapi.detectAllFaces(canvas, detectorOptions()).withFaceLandmarks().withFaceDescriptors();
    if (!faces.length) return null;
    faces.sort((a, b) => b.detection.box.area - a.detection.box.area);
    const r = faces[0], second = faces[1];
    if (r.detection.score < 0.5 || r.detection.box.width < canvas.width * 0.1) return null;
    if (second && second.detection.box.area > r.detection.box.area * 0.55) return null;
    return { ...BL.poseFromLandmarks(r.landmarks.positions, r.detection.box.width, canvas.width),
             descriptor: Array.from(r.descriptor, x => +x.toFixed(5)) };
  }

  async function capturePose(video, pose, straight, sayEl, countdownEl) {
    const deadline = Date.now() + 8000;
    let steadyFrames = 0, captured = null;
    sayEl.textContent = pose.text + ' — hold still while the camera checks.';
    while (Date.now() < deadline) {
      const canvas = snap(video), info = await describe(canvas);
      if (BL.poseMatches(pose.key, info, straight)) {
        steadyFrames++;
        captured = { pose: pose.key, info };
        if (steadyFrames >= 2) {
          countdownEl.textContent = '';
          return captured;
        }
        sayEl.textContent = 'Pose detected — hold still...';
      } else {
        steadyFrames = 0;
        if (!info) sayEl.textContent = 'Center one face in the guide and use even lighting.';
        else sayEl.textContent = pose.text + ' — hold the pose until it is detected.';
      }
      countdownEl.textContent = String(Math.max(1, Math.ceil((deadline - Date.now()) / 1000)));
      await sleep(120);
    }
    countdownEl.textContent = '';
    return null;
  }

  /* ------------------------------------------------------------ routing */
  async function route() {
    if (!Api.token()) { me = null; return show('home'); }
    if (!(await refreshMe())) return show('home');
    if (me.status === 'active') return showDashboard();
    if (me.status === 'unverified') return goStep(me.verify_step);
    return showResult();
  }
  function goStep(step) {
    if (step <= 0) enterId(); else if (step === 1) enterFace(); else if (step === 2) enterInfo(); else showResult();
  }

  /* ------------------------------------------------------------ sign up */
  $('signup-form').onsubmit = async e => {
    e.preventDefault(); say('msg-signup', '');
    try {
      const r = await Api.signup($('su-email').value, $('su-pin').value, $('su-role').value);
      if (!r.ok) return say('msg-signup', r.message);
      Api.setToken(r.token); $('signup-form').reset(); await route();
      if (r.resumed && me && me.status === 'unverified') {
        const messageId = me.verify_step === 0 ? 'msg-id' : me.verify_step === 1 ? 'msg-face' : 'msg-info';
        say(messageId, 'Your unfinished registration has been restored. Continue where you left off.', 'good');
      }
    } catch (err) { say('msg-signup', err.message); }
  };

  /* ------------------------------------------------------------ step 1: ID upload + OCR */
  function enterId() {
    show('id');
    const lock = lockText(me.locked_until);
    say('msg-id', lock, 'warn'); $('btn-scan').disabled = !!lock;
  }
  $('id-file').onchange = () => {
    const f = $('id-file').files[0], img = $('id-preview');
    if (f) { img.src = URL.createObjectURL(f); img.hidden = false; } else img.hidden = true;
  };

  function fileToCanvas(file, maxW) {
    return new Promise((resolve, reject) => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        const s = Math.min(1, maxW / img.width), c = document.createElement('canvas');
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url); resolve(c);
      };
      img.onerror = () => reject(new Error('The file could not be read as an image.'));
      img.src = url;
    });
  }
  function grayPixels(canvas, width) {                      // downscaled grayscale for the blur check
    const h = Math.round(canvas.height * width / canvas.width), c = document.createElement('canvas');
    c.width = width; c.height = h;
    const ctx = c.getContext('2d'); ctx.drawImage(canvas, 0, 0, width, h);
    const px = ctx.getImageData(0, 0, width, h).data, g = new Float32Array(width * h);
    for (let i = 0; i < g.length; i++) g[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    return { data: g, w: width, h };
  }
  function forOcr(canvas, threshold = false) {               // grayscale + contrast boost helps Tesseract
    const scale = canvas.width < 1200 ? 1.5 : 1;
    const c = document.createElement('canvas');
    c.width = Math.round(canvas.width * scale); c.height = Math.round(canvas.height * scale);
    const ctx = c.getContext('2d'); ctx.drawImage(canvas, 0, 0, c.width, c.height);
    const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
    const histogram = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const boosted = Math.max(0, Math.min(255, (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] - 128) * 1.4 + 128));
      const g = Math.round(boosted);
      d[i] = d[i + 1] = d[i + 2] = g;
      histogram[g]++;
    }
    if (threshold) {
      const total = d.length / 4;
      let sum = 0;
      for (let i = 0; i < histogram.length; i++) sum += i * histogram[i];
      let backgroundWeight = 0, backgroundSum = 0, bestVariance = -1, cutoff = 155;
      for (let i = 0; i < histogram.length; i++) {
        backgroundWeight += histogram[i];
        if (!backgroundWeight) continue;
        const foregroundWeight = total - backgroundWeight;
        if (!foregroundWeight) break;
        backgroundSum += i * histogram[i];
        const meanBackground = backgroundSum / backgroundWeight;
        const meanForeground = (sum - backgroundSum) / foregroundWeight;
        const variance = backgroundWeight * foregroundWeight * (meanBackground - meanForeground) ** 2;
        if (variance > bestVariance) { bestVariance = variance; cutoff = i; }
      }
      for (let i = 0; i < d.length; i += 4) {
        const value = d[i] > cutoff ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = value;
      }
    }
    ctx.putImageData(img, 0, 0); return c;
  }

  function requiredFieldCount(parsed) {
    return BL.CONFIG.REQUIRED.filter(key => parsed.fields[key]).length;
  }
  function idReadScore(result) {
    const fields = result.parsed.fields;
    const nameWords = (fields.full_name.match(/\s+/g) || []).length + (fields.full_name ? 1 : 0);
    return requiredFieldCount(result.parsed) * 100 + (nameWords >= 2 ? 2 : 0) +
      (fields.address ? 1 : 0) + result.confidence * 2;
  }
  async function readId(canvas, type) {
    const first = await Tesseract.recognize(forOcr(canvas), 'eng');
    let best = { parsed: BL.parseIdText(first.data.text, type), confidence: first.data.confidence / 100 };
    const second = await Tesseract.recognize(forOcr(canvas, true), 'eng');
    const candidate = { parsed: BL.parseIdText(second.data.text, type), confidence: second.data.confidence / 100 };
    return idReadScore(candidate) > idReadScore(best) ? candidate : best;
  }

  // Counts a failed attempt on the server (3 failures = 15-minute lock) and shows the message
  async function failStep(kind, msgId, btnId, text) {
    let extra = '';
    try {
      const r = await Api.reportFailure(kind);
      if (r.locked) { extra = ' Too many failed attempts. Try again in 15 minutes.'; $(btnId).disabled = true; me.locked_until = new Date(Date.now() + 15 * 60000).toISOString(); }
      else if (r.attempts_left != null) extra = ' Attempts left: ' + r.attempts_left + '.';
    } catch (e) { /* keep the original message */ }
    say(msgId, text + extra);
  }

  $('btn-scan').onclick = async () => {
    const file = $('id-file').files[0], type = $('id-type').value, btn = $('btn-scan'), status = $('id-status');
    const setStatus = t => { status.textContent = t; status.hidden = !t; };
    say('msg-id', '');
    if (!type) return say('msg-id', 'Choose the type of ID you are uploading.');
    if (!file || !/^image\/(jpeg|png)$/.test(file.type) || file.size > 5 * 1024 * 1024) return say('msg-id', 'Upload a JPG or PNG image up to 5 MB.');
    btn.disabled = true;
    try {
      await ensureModels(setStatus);
      const canvas = await fileToCanvas(file, 1600);

      setStatus('Checking the photo...');
      const g = grayPixels(canvas, 800);
      if (BL.laplacianVariance(g.data, g.w, g.h) < CFG.MIN_SHARPNESS)
        return await failStep('id', 'msg-id', 'btn-scan', 'The photo is too blurry. Retake it in good light and hold the camera steady.');

      setStatus('Finding the face photo on the ID...');
      const faces = await faceapi.detectAllFaces(canvas, detectorOptions()).withFaceLandmarks().withFaceDescriptors();
      if (!faces.length)
        return await failStep('id', 'msg-id', 'btn-scan', 'No face photo was found on the ID. Make sure the whole front of the ID is visible.');
      const idFace = faces.reduce((a, b) => (b.detection.box.area > a.detection.box.area ? b : a));

      setStatus('Reading the text on the ID (this can take a few seconds)...');
      const result = await readId(canvas, type);
      const parsed = result.parsed, conf = result.confidence;
      const check = BL.checkOcr(parsed, conf);
      if (!check.ok) return await failStep('id', 'msg-id', 'btn-scan', check.message);

      setStatus('Saving...');
      const r = await Api.saveId(type, parsed.fields, +conf.toFixed(3), Array.from(idFace.descriptor, x => +x.toFixed(5)));
      if (!r.ok) return await failStep('id', 'msg-id', 'btn-scan', r.message);
      await refreshMe(); goStep(me.verify_step);
    } catch (err) {
      say('msg-id', err.message);
    } finally {
      setStatus(''); if (!lockText(me && me.locked_until)) btn.disabled = false;
    }
  };

  /* ------------------------------------------------------------ step 2: face registration + match */
  function enterFace() {
    show('face');
    const lock = lockText(me.locked_until);
    say('msg-face', lock, 'warn'); $('btn-face-start').disabled = !!lock;
    $('btn-face-start').hidden = false; $('btn-face-next').hidden = true;
  }
  $('btn-face-next').onclick = async () => { await refreshMe(); goStep(me.verify_step); };

  $('btn-face-start').onclick = async () => {
    const btn = $('btn-face-start'), video = $('face-video'), sayEl = $('face-say');
    btn.disabled = true; say('msg-face', '');
    try {
      await ensureModels(t => { sayEl.textContent = t; });
      try { await startCam(video); }
      catch (e) { say('msg-face', 'Camera access is blocked. Allow the camera and try again.'); return; }

      const shots = [];
      for (const p of CFG.POSES) {
        const captured = await capturePose(video, p, shots.length ? shots[0].info : null, sayEl, $('face-cd'));
        if (!captured) {
          sayEl.textContent = 'Could not confirm that pose; continuing to the next instruction.';
        }
        shots.push(captured || { pose: p.key, info: null });
      }
      stopCam(video); sayEl.textContent = 'Checking your captures...';

      const infos = {};
      for (const s of shots) infos[s.pose] = s.info;
      const chk = BL.checkPoses(infos);                       // did the person follow each instruction?
      if (!chk.ok) {
        sayEl.textContent = 'Capture not accepted.';
        return await failStep('face', 'msg-face', 'btn-face-start',
          'These captures did not follow the instruction: ' + chk.failed.join(', ') + '. Face the camera in good light and repeat.');
      }

      const r = await Api.saveFace(chk.passed.map(p => ({ pose: p, descriptor: infos[p].descriptor })));   // server decides the match
      if (!r.ok) { sayEl.textContent = 'Face not matched.'; return await failStep('face', 'msg-face', 'btn-face-start', r.message); }
      sayEl.textContent = 'Face matches the ID.';
      say('msg-face', 'Face registered and matched with the ID photo.', 'good');
      btn.hidden = true; $('btn-face-next').hidden = false;
    } catch (err) {
      say('msg-face', err.message);
    } finally {
      stopCam(video);
      if (!btn.hidden) { btn.textContent = 'Repeat capture'; btn.disabled = !!lockText(me && me.locked_until); }
    }
  };

  /* ------------------------------------------------------------ step 3: personal information */
  async function enterInfo() {
    show('info'); say('msg-info', '');
    try {
      const r = await Api.getRecord();
      if (!r.ok) { await refreshMe(); return goStep(Math.min(me.verify_step, 1)); }   // cannot skip ahead
      $('in-name').value = r.full_name || ''; $('in-dob').value = r.dob || ''; $('in-address').value = r.address || '';
      $('in-number').value = r.id_number || ''; $('in-expiry').value = r.expiry || '';
      updateAge();
    } catch (err) { say('msg-info', err.message); }
  }
  function updateAge() { const a = BL.calcAge($('in-dob').value); $('in-age').value = a === null ? '' : a; }
  $('in-dob').oninput = updateAge;

  $('info-form').onsubmit = async e => {
    e.preventDefault();
    const fields = { full_name: $('in-name').value, dob: $('in-dob').value, address: $('in-address').value,
                     id_number: $('in-number').value, expiry: $('in-expiry').value };
    const problem = BL.validateInfo(fields);
    if (problem) return say('msg-info', problem);
    try {
      const r = await Api.saveInfo(fields);
      if (!r.ok) return say('msg-info', r.message);
      await refreshMe(); showResult();
    } catch (err) { say('msg-info', err.message); }
  };

  /* ------------------------------------------------------------ step 4: result */
  function showResult() {
    show('result');
    const t = {
      pending:  ['Verification successful', 'Your ID was scanned and your face matched the ID photo. Your account now waits for admin approval.', 'good'],
      rejected: ['Registration rejected', 'An admin rejected this registration. Contact the restaurant admin.', 'bad'],
      active:   ['Account active', 'Your account is approved. You can log in with your face.', 'good']
    }[me.status] || ['Verification', '', 'warn'];
    $('result-title').textContent = t[0]; say('result-msg', t[1], t[2]);
    const rows = [['Name', me.full_name], ['ID type', CFG.ID_TYPES[me.id_type] || me.id_type], ['ID number', me.id_number],
                  ['Face match distance', me.face_distance != null ? me.face_distance.toFixed(2) + ' (lower is closer)' : ''],
                  ['Role requested', roleLabel(me.requested_role)], ['Status', me.status]];
    const dl = $('result-details'); dl.replaceChildren();
    rows.forEach(([k, v]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v || '-'; dl.append(dt, dd); });
  }

  /* ------------------------------------------------------------ face login + PIN login */
  $('btn-login-start').onclick = async () => {
    const btn = $('btn-login-start'), video = $('login-video'), sayEl = $('login-say');
    btn.disabled = true; say('msg-login', '');
    try {
      await ensureModels(t => { sayEl.textContent = t; });
      try { await startCam(video); }
      catch (e) { say('msg-login', 'Camera access is blocked. Allow the camera or use your PIN.'); $('pin-form').hidden = false; return; }

      const challenge = Math.random() < 0.5 ? 'left' : 'right';       // random head turn = basic liveness check
      sayEl.textContent = 'Look straight at the camera'; await countdown($('login-cd'), 3);
      const c1 = snap(video);
      sayEl.textContent = challenge === 'left' ? 'Now turn your head to your left' : 'Now turn your head to your right';
      await countdown($('login-cd'), 3);
      const c2 = snap(video);
      stopCam(video); sayEl.textContent = 'Checking...';

      const f1 = await describe(c1), f2 = await describe(c2);
      if (!f1 || f1.label !== 'straight') return say('msg-login', 'No clear face found. Look straight at the camera in good light.');
      if (!f2 || f2.label !== challenge) return say('msg-login', 'The head-turn check failed. Turn your head when prompted.');
      if (faceapi.euclideanDistance(f1.descriptor, f2.descriptor) > CFG.SAME_PERSON_DIST) return say('msg-login', 'The two captures do not look like the same person.');

      const r = await Api.faceLogin(f1.descriptor);
      if (!r.ok) { if (r.show_pin) $('pin-form').hidden = false; return say('msg-login', r.message); }
      Api.setToken(r.token); await route();
    } catch (err) {
      say('msg-login', err.message);
    } finally {
      stopCam(video); sayEl.textContent = 'Press Start scan when you are ready.'; btn.textContent = 'Try again'; btn.disabled = false;
    }
  };
  $('show-pin').onclick = () => { $('pin-form').hidden = false; $('pin-form').scrollIntoView(); };
  $('pin-form').onsubmit = async e => {
    e.preventDefault(); say('msg-pin', '');
    try {
      const r = await Api.pinLogin($('pin-email').value, $('pin-code').value);
      if (!r.ok) return say('msg-pin', r.message);
      Api.setToken(r.token); $('pin-form').reset(); await route();
    } catch (err) { say('msg-pin', err.message); }
  };

  /* ------------------------------------------------------------ dashboard + admin approvals */
  function showDashboard() {
    show('dashboard');
    $('dash-name').textContent = me.full_name || me.email;
    $('dash-role').textContent = roleLabel(me.role);
    $('btn-approvals').hidden = me.role !== 'admin';
    // Add your role-based modules here (kitchen -> recipes, inventory -> stock, receptionist -> reservations)
  }
  $('btn-approvals').onclick = loadApprovals;
  $('approvals-back').onclick = showDashboard;

  async function loadApprovals() {
    show('approvals'); say('msg-approvals', '');
    const list = $('approval-list'); list.replaceChildren();
    try {
      const r = await Api.listPending();
      if (!r.ok) return say('msg-approvals', r.message);
      if (!r.items.length) return say('msg-approvals', 'No accounts are waiting for approval.', 'warn');
      r.items.forEach(p => list.append(approvalCard(p)));
    } catch (err) { say('msg-approvals', err.message); }
  }
  function approvalCard(p) {
    const box = document.createElement('section'); box.className = 'req';
    const dl = document.createElement('dl');
    [['Name', p.full_name], ['Email', p.email], ['Date of birth', p.dob + ' (age ' + BL.calcAge(p.dob) + ')'], ['Address', p.address || 'Not on ID'],
     ['ID', (CFG.ID_TYPES[p.id_type] || p.id_type) + ' - ' + p.id_number], ['Face match distance', Number(p.face_distance).toFixed(2)],
     ['OCR confidence', Number(p.ocr_confidence).toFixed(2)], ['Role requested', roleLabel(p.requested_role)]]
      .forEach(([k, v]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; dl.append(dt, dd); });

    const approveRow = document.createElement('div'); approveRow.className = 'row';
    const sel = document.createElement('select'); roles.forEach(r => sel.add(new Option(r.label, r.key))); sel.value = p.requested_role;
    const lblSel = document.createElement('div'), l1 = document.createElement('label'); l1.textContent = 'Assign role'; lblSel.append(l1, sel);
    const ok = document.createElement('button'); ok.className = 'btn'; ok.type = 'button'; ok.textContent = 'Approve';
    approveRow.append(lblSel, ok);

    const rejectRow = document.createElement('div'); rejectRow.className = 'row';
    const reason = document.createElement('input'); reason.maxLength = 250;
    const lblRea = document.createElement('div'), l2 = document.createElement('label'); l2.textContent = 'Reason for rejecting'; lblRea.append(l2, reason);
    const no = document.createElement('button'); no.className = 'btn alt'; no.type = 'button'; no.textContent = 'Reject';
    rejectRow.append(lblRea, no);

    const decide = async (action) => {
      ok.disabled = no.disabled = true;
      try {
        const r = await Api.decide(p.id, action, sel.value, reason.value);
        if (!r.ok) { say('msg-approvals', r.message); ok.disabled = no.disabled = false; return; }
        box.remove(); say('msg-approvals', action === 'approve' ? 'Account approved.' : 'Account rejected.', 'good');
      } catch (err) { say('msg-approvals', err.message); ok.disabled = no.disabled = false; }
    };
    ok.onclick = () => decide('approve'); no.onclick = () => decide('reject');
    box.append(dl, approveRow, rejectRow); return box;
  }

  /* ------------------------------------------------------------ navigation + start */
  $('go-login').onclick = () => show('login');
  $('go-signup').onclick = () => show('signup');
  document.querySelectorAll('[data-go]').forEach(b => { b.onclick = () => { stopCam($('login-video')); me = Api.token() ? me : null; show(b.dataset.go); }; });
  $('result-back').onclick = async () => { await Api.logout(); me = null; show('home'); };
  $('btn-logout').onclick = async () => {
    if (me && me.status === 'unverified') {
      if (!window.confirm('Cancel this unfinished registration? Its saved ID and face data will be deleted, and you can use this email to sign up again.')) return;
      const btn = $('btn-logout');
      btn.disabled = true;
      try {
        const r = await Api.cancelSignup();
        if (!r.ok) return window.alert(r.message);
        Api.setToken(null); me = null; show('home');
      } catch (err) {
        window.alert('Could not cancel registration: ' + err.message);
      } finally {
        btn.disabled = false;
      }
      return;
    }
    await Api.logout(); me = null; show('home');
  };

  (async function init() {
    Object.entries(CFG.ID_TYPES).forEach(([k, v]) => $('id-type').add(new Option(v, k)));
    $('id-supported').textContent = Object.values(CFG.ID_TYPES).join(', ');
    try { roles = await Api.roles(); fillRoles($('su-role')); } catch (e) { say('msg-signup', 'Could not reach Supabase. Check src/js/settings.js.'); }
    try { await route(); } catch (e) { show('home'); }
  })();
})();
