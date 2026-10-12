// ---------------------------------------------------------------------------
// Pop! Pop! — app controller: state machine, game loop, rendering, results.
// ---------------------------------------------------------------------------
import { CONFIG, NOTES, TARGET_TYPES, REGULAR_KEYS, DEFAULT_CALIBRATION, Store, reducedMotion, onSystemMotionChange } from './config.js';
import { Sound } from './audio.js';
import { Hand, HAND_CONNECTIONS } from './hand.js';
import { sprites, buildSprites, drawTargetSprite, starPoints } from './sprites.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const TAU = Math.PI * 2;

// ===========================================================================
// App state
// ===========================================================================
const App = {
  state: 'landing',      // landing | tutorial | cameraSetup | playing | paused | results
  inputMode: 'hand',     // hand | mouse
  testOpen: false,
};
const SCREEN_OF = { landing: 'landing', tutorial: 'tutorial', cameraSetup: 'camera', playing: 'game', paused: 'game', results: 'results' };

// ===========================================================================
// Canvas + game state
// ===========================================================================
const canvas = $('#game-canvas');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1, S = 1, HS = 1;
const bgCanvas = document.createElement('canvas');

const G = {
  phase: 'idle',          // idle | countdown | running | over
  relaxed: false,
  clock: 0, time: 0, timeLeft: CONFIG.roundSeconds, countdown: 0,
  score: 0, combo: 0, bestCombo: 0, shots: 0, hits: 0, specials: 0,
  notes: [], targets: [], projectiles: [], particles: [], ripples: [], texts: [],
  spawnIn: 0, lastShotAt: [-9, -9], lastHitAt: 0, goldenUntil: -1, showerUntil: -1,
  ended: false, resultsShown: false, overTimer: 0, nextId: 1, lastType: null,
  forcedGolden: false, forcedRainbow: false,
  flash: 0, wave: 0, result: null,
  launcher: { x: 0, y: 0, angle: -Math.PI / 2, recoil: 0, aim: 0 },
  // One star cursor per tracked hand (cursor 0 also serves the mouse).
  cursors: [makeCursor(0), makeCursor(1)],
};
G.cursor = G.cursors[0];
function makeCursor(id) {
  return { id, x: 0, y: 0, tx: 0, ty: 0, active: false, lastActive: -1, pulse: 0, trail: [], dwell: 0, dwellTarget: null };
}
// Each hand gets its own star colour: [inner, mid, edge, glow]
const CURSOR_COLORS = [
  ['#fffdf0', '#ffe68a', '#f3bf3f', 'rgba(255, 230, 140, 0.95)'],
  ['#fff4f9', '#ffb3d4', '#ec7fb2', 'rgba(255, 170, 210, 0.95)'],
];
const clouds = [];
const bgStars = [];
const eqBands = new Float32Array(9);
const mouse = { x: 0, y: 0, inside: false };

// ===========================================================================
// Init
// ===========================================================================
function initApp() {
  Store.load();
  Hand.init($('#cam-video'));
  applyMotionPref();
  bindUI();
  syncPrefsUI();
  $$('.screen').forEach((el) => (el.inert = !el.classList.contains('active')));
  renderLanding();
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  document.addEventListener('visibilitychange', onVisibility);
  onSystemMotionChange(applyMotionPref);

  // Audio may only start after a user gesture.
  const unlock = () => Sound.ensure() && Sound.applyVolume();
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });

  Hand.on('status', onHandStatus);
  Hand.on('pinch', onPinch);

  // Build sprites once fonts are ready (♪ emblems use the display font).
  const fontsReady = document.fonts ? Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]) : Promise.resolve();
  fontsReady.then(() => {
    buildSprites();
    renderLegend();
    buildBackground();
  });
  $('#storage-note').textContent = Store.available ? 'Scores and preferences are saved in this browser only.' : 'Saving is unavailable in this browser — scores will last for this visit only.';
}

// ===========================================================================
// Navigation / state machine
// ===========================================================================
function navigateTo(next) {
  const prev = App.state;
  if (prev === next) return;
  const inGame = (s) => s === 'playing' || s === 'paused';

  // --- exit actions
  if (prev === 'results') { Melody.stop(); Confetti.stop(); }
  if (prev === 'cameraSetup') Calib.cancel();
  if (inGame(prev) && !inGame(next) && next !== 'results') cleanupGame();

  App.state = next;
  document.body.dataset.state = next;

  // --- screen switch with a soft transition
  const prevScreen = SCREEN_OF[prev], nextScreen = SCREEN_OF[next];
  if (prevScreen !== nextScreen) {
    $$('.screen').forEach((el) => {
      const on = el.dataset.screen === nextScreen;
      el.classList.toggle('active', on);
      el.inert = !on;
      if (on) el.scrollTop = 0;
    });
  }

  $('#pause-overlay').hidden = next !== 'paused';
  $('.topbar').inert = inGame(next);

  // --- enter actions
  if (next === 'landing') renderLanding();
  if (next === 'cameraSetup') renderCameraSetup();
  if (next === 'results') enterResults();
  if (next === 'paused') setTimeout(() => $('[data-action="resume"]').focus(), 30);

  placePreview();
  syncCamera();
  ensureLoop();

  if (prevScreen !== nextScreen) {
    const heading = $(`.screen[data-screen="${nextScreen}"] h1`);
    if (heading) setTimeout(() => heading.focus({ preventScroll: true }), 60);
  }
}

/** Camera only runs where it is needed: setup, gesture test and hand-mode play. */
function cameraNeeded() {
  if (App.testOpen) return true;
  if (App.inputMode !== 'hand') return false;
  return App.state === 'cameraSetup' || App.state === 'playing' || App.state === 'paused';
}
function syncCamera() {
  if (cameraNeeded()) {
    if (!Hand.running && !Hand.starting && Hand.status !== 'error') Hand.start(cameraNeeded).then(ensureLoop);
  } else if (Hand.running || Hand.starting) {
    Hand.stop();
  }
}

/** The single camera preview element moves between screens instead of duplicating video. */
function placePreview() {
  const preview = $('#preview');
  let host = $('#preview-parking');
  if (App.testOpen) host = $('#test-preview-host');
  else if (App.state === 'cameraSetup') host = $('#setup-preview-host');
  else if (App.state === 'playing' || App.state === 'paused') host = $('#game-preview-host');
  if (preview.parentElement !== host) {
    host.appendChild(preview);
    const v = Hand.video;
    if (v && v.srcObject) v.play().catch(() => {});
  }
}

// ===========================================================================
// Main loop — the only requestAnimationFrame loop in the app
// ===========================================================================
let looping = false, lastT = 0;
function needsLoop() {
  return Hand.running || App.state === 'playing' || App.state === 'paused' || App.testOpen ||
    (App.state === 'results' && (Confetti.active || Melody.playing));
}
// `looping` stays true for the whole frame, so callbacks fired mid-frame
// (e.g. hand status changes) can never start a second, competing loop.
function ensureLoop() {
  if (!looping && needsLoop()) {
    looping = true;
    lastT = performance.now();
    requestAnimationFrame(frame);
  }
}
function frame(now) {
  const dt = Math.min(0.1, Math.max(0, (now - lastT) / 1000));
  lastT = now;

  if (Hand.running) Hand.update(now);
  if (App.state === 'cameraSetup' || App.testOpen) { updateSetupFeedback(); Calib.update(now); }
  if (Hand.running) renderPreviewOverlay();

  if (App.state === 'playing') updateGame(dt, now);
  if (App.state === 'playing' || App.state === 'paused') { renderGame(); updateHUD(now); }
  if (App.state === 'results') { Confetti.update(dt); drawMelodyEq(); }

  if (needsLoop()) requestAnimationFrame(frame);
  else looping = false;
}

// ===========================================================================
// Hand tracking → UI
// ===========================================================================
const STATUS_TEXT = {
  idle: 'Camera is off',
  requesting: 'Waiting for camera permission',
  loading: 'Loading hand tracking',
  searching: 'Looking for your hand',
  detected: 'Hand detected!',
  error: 'Camera unavailable',
};
const ERROR_HELP = {
  denied: 'Camera blocked. Click the 🎥 icon in the address bar → Allow, then Try again.',
  notfound: 'No webcam found. Plug one in, or use your mouse.',
  inuse: 'Camera is busy in another app. Close it there, then Try again.',
  insecure: 'The camera needs a secure (https://) link. Use your mouse for now.',
  model: 'Hand tracking didn’t load. Check your internet, then Try again.',
  unknown: 'Camera didn’t start. Try again, or use your mouse.',
};

function onHandStatus(status, code) {
  const text = status === 'error' && code === 'model' ? 'Hand tracking couldn’t load' : STATUS_TEXT[status];
  for (const id of ['#cam-status', '#test-status']) {
    const pill = $(id);
    pill.dataset.status = status;
    $('.txt', pill).textContent = text;
  }
  for (const id of ['#cam-help', '#test-help']) {
    const box = $(id);
    box.hidden = status !== 'error';
    if (status === 'error') $('.help-text', box).textContent = ERROR_HELP[code] || ERROR_HELP.unknown;
  }
  const preview = $('#preview');
  preview.classList.toggle('live', Hand.running);
  preview.classList.toggle('found', status === 'detected');
  preview.style.aspectRatio = String(Hand.aspect);

  const camOk = Hand.running || ['loading', 'searching', 'detected'].includes(status);
  setCheck('camera', camOk);
  setCheck('model', !!Hand.landmarker);
  setCheck('hand', Hand.everDetected && Hand.running);
  $('#cam-start').disabled = !(Hand.everDetected && Hand.running);
  $('#calib-start').disabled = !(status === 'detected') || Calib.active;
  $('#setup-hint').textContent = status === 'detected'
    ? (Store.data.fireMode === 'hover' ? (Hand.presentCount > 1 ? 'Both hands found! You’re ready.' : 'Got it! Add your other hand for a second star.') : 'Got it! Try a pinch — the meter turns green.')
    : status === 'searching' ? 'Hold one or both hands up, palms facing the camera.'
    : 'Allow the camera, then hold one or both hands up in good light.';
  // In-game: camera failed during play → offer mouse controls.
  $('[data-action="switch-mouse"]').hidden = status !== 'error';
  ensureLoop();
}

function setCheck(name, done) {
  const li = $(`#cam-checklist [data-check="${name}"]`);
  if (li) li.classList.toggle('done', !!done);
}

function onPinch(now, slotId = 0) {
  if (Store.data.fireMode !== 'pinch') return;
  G.cursors[slotId].pulse = 1;
  if (App.state === 'cameraSetup' || App.testOpen) {
    setCheck('pinch', true);
    const li = $('#test-pinch');
    li.textContent = '★ Pinch works! ✨';
    li.classList.add('ok');
    li.classList.remove('flash'); void li.offsetWidth; li.classList.add('flash');
    if (Sound.ready()) Sound.playTarget(REGULAR_KEYS[(Math.random() * 5) | 0]);
    return;
  }
  if (App.state === 'playing' && G.phase === 'running' && App.inputMode === 'hand') {
    const a = Hand.aimAt(now - CONFIG.aimLookbackMs, slotId);
    const p = mapToCanvas(a.x, a.y);
    fireProjectile(p.x, p.y, null, slotId);
  }
}

function updateSetupFeedback() {
  const amt = Hand.present ? Hand.pinchAmount() : 0;
  const closed = Hand.present && Hand.pinchState === 'closed';
  for (const id of ['#setup-pinch-bar', '#test-pinch-bar']) {
    const bar = $(id);
    bar.style.width = `${Math.round(amt * 100)}%`;
    bar.classList.toggle('closed', closed);
  }
  const readout = !Hand.running ? ''
    : !Hand.landmarker ? 'Hand tracking is still loading…'
    : !Hand.present ? 'Show your palm to the camera.'
    : Store.data.fireMode === 'hover' ? (Hand.presentCount > 1 ? 'Both hands tracked ✓✓' : 'Tracking your fingertip ✓ — add your other hand too!')
    : `Thumb–index gap: ${Hand.pinchRatio.toFixed(2)} · a pinch counts below ${CONFIG.pinchClose.toFixed(2)}${closed ? ' ✓ pinched!' : ''}`;
  for (const id of ['#setup-readout', '#test-readout']) {
    const el = $(id);
    if (el.textContent !== readout) el.textContent = readout;
  }
  const aim = $('#test-aim');
  const ok = Hand.present;
  if (aim.classList.contains('ok') !== ok) {
    aim.classList.toggle('ok', ok);
    aim.textContent = ok ? '★ Fingertip found — move it around!' : '☆ Looking for your fingertip…';
  }
  if (ok) {
    const two = Hand.presentCount > 1;
    const txt = two ? '★★ Both hands found — two stars!' : '★ Fingertip found — try both hands!';
    if (aim.textContent !== txt) aim.textContent = txt;
  }
}

/** Landmarks + fingertip star on the small mirrored preview. */
let overlayCtx = null;
function renderPreviewOverlay() {
  const c = $('#preview-overlay');
  const host = c.parentElement.parentElement;
  if (host.id === 'preview-parking' || !c.offsetWidth) return;
  const w = c.offsetWidth, h = c.offsetHeight, dpr = Math.min(2, devicePixelRatio || 1);
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  overlayCtx = overlayCtx || c.getContext('2d');
  const g = overlayCtx;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  for (const slot of Hand.slots) if (slot.present) drawHandOverlay(g, slot, w, h);
}

function drawHandOverlay(g, slot, w, h) {
  const lms = slot.landmarks;
  const P = (i) => [(1 - lms[i].x) * w, lms[i].y * h];
  const small = w < 260;
  g.lineWidth = small ? 1.5 : 2.5;
  g.strokeStyle = 'rgba(255,255,255,0.75)';
  g.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) { const pa = P(a), pb = P(b); g.moveTo(pa[0], pa[1]); g.lineTo(pb[0], pb[1]); }
  g.stroke();
  g.fillStyle = 'rgba(156,124,240,0.9)';
  for (let i = 0; i < 21; i++) { const p = P(i); g.beginPath(); g.arc(p[0], p[1], small ? 1.8 : 3, 0, TAU); g.fill(); }
  // fingertip marker
  const [tx, ty] = P(8);
  const closed = slot.pinchState === 'closed';
  const col = CURSOR_COLORS[slot.id];
  g.save();
  g.translate(tx, ty);
  g.shadowColor = closed ? '#ffd65c' : '#fff'; g.shadowBlur = 12;
  g.fillStyle = closed ? '#ffd65c' : col[1];
  g.strokeStyle = '#fff'; g.lineWidth = 2;
  g.beginPath();
  starPoints(small ? 8 : 13, 0.5).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath(); g.fill(); g.stroke();
  g.restore();
}

// ===========================================================================
// Aim mapping + calibration
// ===========================================================================
function mapNorm(nx, ny) {
  const c = Store.data.calibration || DEFAULT_CALIBRATION;
  const s = Store.data.sensitivity;
  const cx = (c.x0 + c.x1) / 2, cy = (c.y0 + c.y1) / 2;
  const hw = (c.x1 - c.x0) / 2 / s, hh = (c.y1 - c.y0) / 2 / s;
  return { x: clamp((nx - cx) / hw * 0.5 + 0.5, 0, 1), y: clamp((ny - cy) / hh * 0.5 + 0.5, 0, 1) };
}
function mapToCanvas(nx, ny) {
  const m = mapNorm(nx, ny);
  return { x: clamp(m.x * W, 8, W - 8), y: clamp(m.y * H, 8, H - 8) };
}

const Calib = {
  active: false, until: 0, samples: [],
  start() {
    if (!Hand.present) return;
    this.active = true;
    this.samples = [];
    this.until = performance.now() + 4000;
    $('#calib-start').disabled = true;
    ensureLoop();
  },
  cancel() {
    if (!this.active) return;
    this.active = false;
    $('#calib-text').textContent = 'Calibration cancelled.';
  },
  update(now) {
    if (!this.active) return;
    for (const slot of Hand.slots) if (slot.present) this.samples.push({ ...slot.tip });
    const left = Math.ceil((this.until - now) / 1000);
    if (left > 0) {
      $('#calib-text').textContent = `Move your fingertip to all the edges… ${left}`;
      return;
    }
    this.active = false;
    $('#calib-start').disabled = Hand.status !== 'detected';
    if (this.samples.length < 20) {
      $('#calib-text').textContent = 'Lost your hand — try again.';
      return;
    }
    const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(p * arr.length)))];
    const xs = this.samples.map((s) => s.x).sort((a, b) => a - b);
    const ys = this.samples.map((s) => s.y).sort((a, b) => a - b);
    let x0 = pct(xs, 0.04) + 0.02, x1 = pct(xs, 0.96) - 0.02, y0 = pct(ys, 0.04) + 0.02, y1 = pct(ys, 0.96) - 0.02;
    const widen = (a, b) => { const c = (a + b) / 2, half = Math.max(0.15, (b - a) / 2); return [clamp(c - half, 0, 1), clamp(c + half, 0, 1)]; };
    [x0, x1] = widen(x0, x1);
    [y0, y1] = widen(y0, y1);
    Store.data.calibration = { x0, x1, y0, y1 };
    Store.save();
    $('#calib-text').textContent = 'Calibrated ✓';
  },
};

// ===========================================================================
// Game lifecycle
// ===========================================================================
function resetGame(relaxed) {
  Object.assign(G, {
    phase: 'countdown', relaxed,
    clock: 0, time: 0, timeLeft: CONFIG.roundSeconds, countdown: CONFIG.countdownSeconds,
    score: 0, combo: 0, bestCombo: 0, shots: 0, hits: 0, specials: 0,
    notes: [], targets: [], projectiles: [], particles: [], ripples: [], texts: [],
    spawnIn: 0.2, lastShotAt: [-9, -9], lastHitAt: 0, goldenUntil: -1, showerUntil: -1,
    ended: false, resultsShown: false, overTimer: 0, nextId: 1, lastType: null,
    forcedGolden: false, forcedRainbow: false, flash: 0, result: null,
  });
  G.cursors.forEach((c, i) => {
    Object.assign(c, { x: W * (i ? 0.62 : 0.38), y: H * 0.55, active: false, lastActive: -1, pulse: 0, dwell: 0, dwellTarget: null });
    c.tx = c.x; c.ty = c.y;
    c.trail.length = 0;
  });
  HUD.reset();
  $('#toasts').textContent = '';
}

/** Start a fresh 60-second round (from setup, pause → restart, or results). */
function startGame(relaxed = false) {
  Sound.ensure();
  Melody.stop();
  resetGame(relaxed);
  document.body.dataset.input = App.inputMode;
  $('#mouse-pill').hidden = App.inputMode !== 'mouse';
  $('#toggle-input').textContent = App.inputMode === 'hand' ? 'Switch to mouse' : 'Switch to hand';
  const wasPaused = App.state === 'paused';
  navigateTo('playing');
  if (wasPaused) { $('#pause-overlay').hidden = true; }
  showCountdown(CONFIG.countdownSeconds);
}

function cleanupGame() {
  G.phase = 'idle';
  G.targets.length = G.projectiles.length = G.particles.length = G.ripples.length = G.texts.length = 0;
  $('#countdown').textContent = '';
  $('#toasts').textContent = '';
  $('#find-hand').hidden = true;
}

function pauseGame() {
  if (App.state !== 'playing' || G.phase === 'over') return;
  navigateTo('paused');
}
function resumeGame() {
  if (App.state !== 'paused') return;
  navigateTo('playing');
}

/** Called exactly once per round when the timer reaches zero. */
function endGame() {
  if (G.ended) return;
  G.ended = true;
  G.phase = 'over';
  G.timeLeft = 0;
  G.overTimer = 1.3;
  for (const p of G.projectiles) p.dead = true;
  G.projectiles.length = 0;
  for (const t of G.targets) if (!t.hit) { t.hit = true; t.fading = true; }
  showToast('Time’s up!', 'gold');
  if (Sound.ready()) Sound.blip(true);
  G.result = finalizeSession();
}

/** Compute statistics from gameplay data and persist records. */
function finalizeSession() {
  const prevBest = Store.data.best;
  const hadPrevious = Store.data.gamesPlayed > 0;
  const isNewBest = G.score > prevBest;
  if (isNewBest) Store.data.best = G.score;
  Store.data.bestCombo = Math.max(Store.data.bestCombo, G.bestCombo);
  Store.data.gamesPlayed += 1;
  Store.data.totalHits += G.hits;
  Store.save();
  return {
    score: G.score, prevBest, hadPrevious, isNewBest: isNewBest && G.score > 0,
    hits: G.hits, shots: G.shots, accuracy: G.shots ? Math.round((G.hits / G.shots) * 100) : null,
    bestCombo: G.bestCombo, notes: G.notes.slice(), specials: G.specials, relaxed: G.relaxed,
    uniqueNotes: new Set(G.notes.map((n) => n.note)).size,
  };
}

// ===========================================================================
// Game simulation
// ===========================================================================
function updateGame(dt, now) {
  G.clock += dt;
  updateCursor(dt);

  if (G.phase === 'countdown') {
    const before = Math.ceil(G.countdown);
    G.countdown -= dt;
    const after = Math.ceil(G.countdown);
    if (after !== before) showCountdown(after);
    if (G.countdown <= 0) { G.phase = 'running'; spawnTarget(); }
  } else if (G.phase === 'running') {
    G.time += dt;
    G.timeLeft = Math.max(0, CONFIG.roundSeconds - G.time);
    updateSpawning(dt);
    updateTargets(dt);
    updateDwell(dt);
    updateProjectiles(dt);
    if (G.combo > 0 && G.time - G.lastHitAt > CONFIG.comboTimeout) G.combo = 0;
    if (G.timeLeft <= 0) endGame();
  } else if (G.phase === 'over') {
    updateTargets(dt);
    G.overTimer -= dt;
    if (G.overTimer <= 0 && !G.resultsShown) {
      G.resultsShown = true;
      navigateTo('results');
      return;
    }
  }
  updateEffects(dt);
}

function updateCursor(dt) {
  if (App.inputMode === 'hand') {
    const k = 1 - Math.exp(-dt * 24);
    G.cursors.forEach((c, i) => {
      const slot = Hand.slots[i];
      if (slot.present) {
        const m = mapToCanvas(slot.tip.x, slot.tip.y);
        if (!c.active && G.clock - c.lastActive > 1) { c.x = m.x; c.y = m.y; c.trail.length = 0; } // fresh hand: start where it is
        c.tx = m.x; c.ty = m.y; c.active = true; c.lastActive = G.clock;
      } else c.active = false; // hold position — never jump while a hand is lost
      c.x += (c.tx - c.x) * k;
      c.y += (c.ty - c.y) * k;
    });
  } else {
    const c = G.cursors[0];
    c.active = mouse.inside;
    if (c.active) c.lastActive = G.clock;
    c.x = c.tx = mouse.x; c.y = c.ty = mouse.y;
    G.cursors[1].active = false;
  }
  for (const c of G.cursors) {
    c.trail.push({ x: c.x, y: c.y });
    if (c.trail.length > 10) c.trail.shift();
    c.pulse = Math.max(0, c.pulse - dt * 3);
  }

  // The launcher turns toward whichever star fired last (or any active one).
  const L = G.launcher;
  const aimC = G.cursors[L.aim].active ? G.cursors[L.aim] : G.cursors.find((c) => c.active) || G.cursors[L.aim];
  const want = clamp(Math.atan2(aimC.y - L.y, aimC.x - L.x), -Math.PI + 0.22, -0.22);
  L.angle += (want - L.angle) * (1 - Math.exp(-dt * 18));
  L.recoil = Math.max(0, L.recoil - dt * 5);
}

/**
 * Hover-to-pop: when a star rests on a friend for CONFIG.dwellSeconds, a
 * bubble launches automatically, aimed slightly ahead of the falling friend.
 * Each hand's star has its own timer, so both hands can pop at once.
 */
function updateDwell(dt) {
  const enabled = App.inputMode === 'hand' && Store.data.fireMode === 'hover';
  for (const c of G.cursors) {
    if (!enabled || !c.active) { c.dwell = 0; c.dwellTarget = null; continue; }
    let best = null, bestD = Infinity;
    const reachY = G.launcher.y - 90 * S; // friends sunk to launcher level can't be reached
    for (const t of G.targets) {
      if (t.hit || t.locked || t.y > reachY) continue;
      const d = Math.hypot(t.x - c.x, t.y - c.y);
      // generous radius so small tracking jitter doesn't reset the timer
      if (d < t.r * 1.3 + 14 * S && d < bestD) { best = t; bestD = d; }
    }
    if (best !== c.dwellTarget) { c.dwellTarget = best; c.dwell = 0; }
    if (!best) continue;
    c.dwell += dt;
    // If this hand is still cooling down, keep the ring full and fire next frame.
    if (c.dwell >= CONFIG.dwellSeconds && fireAtTarget(best, c.id)) {
      best.locked = true; // one bubble per friend
      c.dwell = 0;
      c.dwellTarget = null;
    }
  }
}

function fireAtTarget(t, source = 0) {
  const L = G.launcher;
  const travel = Math.hypot(t.x - L.x, t.y - L.y) / (CONFIG.projectileSpeed * HS);
  return fireProjectile(t.x, t.y + t.vy * travel, t.id, source);
}

function difficulty() { return clamp(G.time / CONFIG.roundSeconds, 0, 1); }

function updateSpawning(dt) {
  G.spawnIn -= dt;
  if (G.spawnIn > 0) return;
  const p = difficulty();
  let interval = 1.05 - 0.5 * p;
  if (G.relaxed) interval *= 1.45;
  if (G.time < G.showerUntil) interval *= 0.45;
  G.spawnIn = interval * rand(0.8, 1.2);
  if (G.targets.filter((t) => !t.hit).length < CONFIG.maxTargets) spawnTarget();
}

function pickType() {
  const hasRainbow = G.targets.some((t) => t.type === 'rainbow' && !t.hit);
  if (!G.forcedRainbow && G.time > 30 && !hasRainbow) { G.forcedRainbow = true; return 'rainbow'; }
  if (!G.forcedGolden && G.time > 12) { G.forcedGolden = true; return 'golden'; }
  if (G.time > 8 && !hasRainbow && Math.random() < 0.03) { G.forcedRainbow = true; return 'rainbow'; }
  if (Math.random() < 0.075) { G.forcedGolden = true; return 'golden'; }
  let k;
  do { k = REGULAR_KEYS[(Math.random() * REGULAR_KEYS.length) | 0]; } while (k === G.lastType && Math.random() < 0.7);
  G.lastType = k;
  return k;
}

/** Spawn one falling friend at a horizontal position that avoids its neighbours. */
function spawnTarget() {
  const type = pickType();
  const T = TARGET_TYPES[type];
  const r = (T.kind === 'rainbow' ? 42 : T.kind === 'golden' ? 38 : rand(34, 44)) * S;
  const margin = r + 18;
  let bestX = W / 2, bestGap = -1;
  for (let i = 0; i < 10; i++) {
    const x = rand(margin, Math.max(margin + 1, W - margin));
    let gap = Infinity;
    for (const t of G.targets) if (!t.hit && t.y < H * 0.4) gap = Math.min(gap, Math.abs(t.baseX - x) - t.r - r);
    if (gap > bestGap) { bestGap = gap; bestX = x; }
    if (gap > r * 2) break;
  }
  const p = difficulty();
  let speed = (60 + 55 * p) * rand(0.85, 1.18) * HS;
  if (G.relaxed) speed *= 0.62;
  if (T.kind === 'golden') speed *= 1.15;
  if (T.kind === 'rainbow') speed *= 0.9;
  G.targets.push({
    id: G.nextId++, type, T, r, x: bestX, baseX: bestX, y: -r - 6, vy: speed,
    sway: rand(6, 22) * S, swayF: rand(0.6, 1.3), phase: rand(0, TAU), rot: 0,
    age: 0, hit: false, fading: false, pop: 0,
  });
}

function updateTargets(dt) {
  const arr = G.targets;
  for (let i = arr.length - 1; i >= 0; i--) {
    const t = arr[i];
    t.age += dt;
    if (t.hit) {
      t.pop += dt;
      if (t.pop > (t.fading ? 0.5 : 0.28)) arr.splice(i, 1);
      continue;
    }
    t.y += t.vy * dt;
    t.phase += dt * t.swayF * 2;
    t.x = clamp(t.baseX + Math.sin(t.phase) * t.sway, t.r, W - t.r);
    t.rot = Math.sin(t.phase * 0.8) * 0.12;
    if (t.y - t.r > H + 10) arr.splice(i, 1); // missed targets simply drift away
  }
}

/** Launch a glowing bubble from the launcher toward the aim point. */
function fireProjectile(ax, ay, targetId = null, source = 0) {
  if (G.phase !== 'running') return false;
  if (G.time - G.lastShotAt[source] < CONFIG.shotCooldown) return false; // cooldown per hand
  G.lastShotAt[source] = G.time;
  G.launcher.aim = source;
  const L = G.launcher;
  const len = 64 * S;
  const ox = L.x + Math.cos(L.angle) * len, oy = L.y + Math.sin(L.angle) * len;
  let dx = ax - ox, dy = ay - oy;
  let d = Math.hypot(dx, dy) || 1;
  dx /= d; dy /= d;
  if (dy > -0.12) { dy = -0.12; d = Math.hypot(dx, dy); dx /= d; dy /= d; }
  const speed = CONFIG.projectileSpeed * HS;
  G.projectiles.push({ x: ox, y: oy, px: ox, py: oy, vx: dx * speed, vy: dy * speed, r: CONFIG.projectileRadius * S, life: 0, dead: false, trail: [], targetId });
  G.shots++;
  L.recoil = 1;
  G.cursors[source].pulse = 1;
  if (Sound.ready()) Sound.pew();
  return true;
}

/** Swept circle test: earliest target the bubble touched this frame. */
function checkCollisions(p) {
  let hit = null, hitT = Infinity;
  const sx = p.x - p.px, sy = p.y - p.py;
  const segLen2 = sx * sx + sy * sy || 1e-6;
  for (const t of G.targets) {
    if (t.hit) continue;
    const u = clamp(((t.x - p.px) * sx + (t.y - p.py) * sy) / segLen2, 0, 1);
    const cx = p.px + sx * u, cy = p.py + sy * u;
    const rr = t.r * 0.92 + p.r;
    if ((t.x - cx) ** 2 + (t.y - cy) ** 2 <= rr * rr && u < hitT) { hit = t; hitT = u; }
  }
  return hit;
}

function updateProjectiles(dt) {
  const arr = G.projectiles;
  for (let i = arr.length - 1; i >= 0; i--) {
    const p = arr[i];
    p.px = p.x; p.py = p.y;
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.life += dt;
    p.trail.push({ x: p.x, y: p.y });
    if (p.trail.length > 6) p.trail.shift();
    const target = checkCollisions(p);
    if (target) { onHit(target, p); arr.splice(i, 1); continue; }
    if (p.life > CONFIG.projectileMaxLife || p.x < -60 || p.x > W + 60 || p.y < -60) {
      onMiss(p);
      arr.splice(i, 1);
    }
  }
}

const MILESTONES = { 5: 'Sweet 5-hit streak!', 10: 'You’re making music!', 15: 'Melody magic!', 20: 'Symphony mode!', 30: 'Legendary little tune!' };

function comboMultiplier(c) { return c >= 15 ? 2 : c >= 10 ? 1.75 : c >= 5 ? 1.5 : 1; }

function onHit(t, p) {
  if (t.hit) return; // a target can only ever score once
  t.hit = true;
  t.pop = 0;
  const T = t.T;
  G.hits++;
  G.combo++;
  G.bestCombo = Math.max(G.bestCombo, G.combo);
  G.lastHitAt = G.time;
  const mult = comboMultiplier(G.combo) * (G.time < G.goldenUntil ? 2 : 1);
  const pts = Math.round(T.points * mult);
  G.score += pts;
  if (T.kind === 'golden') { G.goldenUntil = G.time + CONFIG.goldenSeconds; G.specials++; showToast('Golden star! Points ×2', 'gold'); }
  if (T.kind === 'rainbow') { G.showerUntil = G.time + CONFIG.showerSeconds; G.specials++; showToast('Rainbow! Note shower!', 'rainbow'); }

  recordMelodyEvent(t);
  if (Sound.ready()) {
    Sound.playTarget(t.type);
    if (G.combo >= 3) Sound.comboAccent(t.type, G.combo);
  }
  burst(t, pts);
  if (MILESTONES[G.combo]) showToast(MILESTONES[G.combo]);
  HUD.bumpScore = true;
}

function onMiss(p) {
  // let a hover-locked friend be targeted again if its bubble missed
  if (p.targetId !== null) { const t = G.targets.find((x) => x.id === p.targetId); if (t) t.locked = false; }
  if (G.combo >= 3) showToast('Combo reset — keep going!');
  G.combo = 0;
  if (Sound.ready()) Sound.miss();
  for (let i = 0; i < 4; i++) addParticle({ kind: 'dot', x: p.x, y: p.y, vx: rand(-40, 40), vy: rand(-40, 20), life: 0.5, size: rand(2, 4) * S, color: 'rgba(255,255,255,0.8)' });
}

function recordMelodyEvent(t) {
  const n = NOTES[t.T.note];
  G.notes.push({ note: t.T.note, freq: n.freq, midi: n.midi, time: +G.time.toFixed(3), type: t.type, kind: t.T.kind, combo: G.combo });
}

// ===========================================================================
// Effects (particles, ripples, floating score)
// ===========================================================================
function addParticle(p) {
  if (G.particles.length >= CONFIG.maxParticles) G.particles.shift();
  p.age = 0;
  G.particles.push(p);
}

function burst(t, pts) {
  const rm = reducedMotion();
  const special = t.T.kind === 'golden' || t.T.kind === 'rainbow';
  const count = (special ? 26 : 14) * (rm ? 0.4 : 1);
  for (let i = 0; i < count; i++) {
    const a = rand(0, TAU), sp = rand(80, special ? 340 : 240) * S;
    addParticle({ kind: 'star', x: t.x, y: t.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40 * S, life: rand(0.5, 0.95), size: rand(8, special ? 18 : 14) * S, rot: rand(0, TAU), vr: rand(-6, 6), sprite: special ? (t.T.kind === 'golden' ? 1 : (i % 6)) : [0, 1, 2, 3, 4, 5][(i + t.id) % 6], drag: 2.4 });
  }
  const glyphs = ['♪', '♫', '♪'];
  for (let i = 0; i < (rm ? 1 : 3); i++) {
    addParticle({ kind: 'note', x: t.x + rand(-12, 12) * S, y: t.y, vx: rand(-40, 40) * S, vy: rand(-110, -70) * S, life: 1.4, size: rand(20, 28) * S, glyph: glyphs[i], color: t.T.accent, rot: rand(-0.3, 0.3), vr: rand(-1, 1), drag: 0.4 });
  }
  G.ripples.push({ x: t.x, y: t.y, r: t.r * 0.8, max: t.r * (special ? 4.2 : 2.8), life: 0, dur: special ? 0.9 : 0.6, color: t.T.accent });
  if (special && !rm) G.ripples.push({ x: t.x, y: t.y, r: t.r * 0.5, max: t.r * 3, life: -0.12, dur: 0.8, color: '#ffffff' });
  G.texts.push({ x: t.x, y: t.y - t.r * 0.4, text: `+${pts}`, life: 0, color: t.T.accent, big: special });
  for (const c of clouds) c.bounce = 1;
  G.flash = Math.min(1, G.flash + (special ? 0.8 : 0.35));
}

function updateEffects(dt) {
  for (let i = G.particles.length - 1; i >= 0; i--) {
    const p = G.particles[i];
    p.age += dt;
    if (p.age >= p.life) { G.particles.splice(i, 1); continue; }
    const drag = Math.exp(-(p.drag || 0) * dt);
    p.vx *= drag; p.vy *= drag;
    if (p.kind === 'star') p.vy += 160 * S * dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.rot !== undefined) p.rot += (p.vr || 0) * dt;
  }
  for (let i = G.ripples.length - 1; i >= 0; i--) {
    const r = G.ripples[i];
    r.life += dt;
    if (r.life >= r.dur) G.ripples.splice(i, 1);
  }
  for (let i = G.texts.length - 1; i >= 0; i--) {
    const t = G.texts[i];
    t.life += dt;
    t.y -= 46 * S * dt;
    if (t.life > 0.9) G.texts.splice(i, 1);
  }
  const drift = reducedMotion() ? 0 : 1;
  for (const c of clouds) {
    c.x += c.speed * dt * drift;
    if (c.x - c.w / 2 > W) c.x = -c.w / 2;
    c.bounce = Math.max(0, c.bounce - dt * 2.2);
  }
  G.flash = Math.max(0, G.flash - dt * 1.6);
}

// ===========================================================================
// Rendering
// ===========================================================================
function resizeCanvas() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = Math.max(320, window.innerWidth);
  H = Math.max(320, window.innerHeight);
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  S = clamp(Math.min(W, H) / 760, 0.62, 1.35);
  HS = clamp(H / 800, 0.7, 1.4);
  G.launcher.x = W / 2;
  G.launcher.y = H - 8 * S;
  buildBackground();
  for (const t of G.targets) t.baseX = clamp(t.baseX, t.r, W - t.r);
}

function buildBackground() {
  bgCanvas.width = canvas.width;
  bgCanvas.height = canvas.height;
  const g = bgCanvas.getContext('2d');
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#dccfff');
  grad.addColorStop(0.45, '#d3e9ff');
  grad.addColorStop(1, '#ffe2ef');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  const blob = (x, y, r, col) => {
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, col); rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg; g.fillRect(0, 0, W, H);
  };
  blob(W * 0.12, H * 0.85, Math.max(W, H) * 0.45, 'rgba(189,242,219,0.55)');
  blob(W * 0.9, H * 0.15, Math.max(W, H) * 0.4, 'rgba(255,240,179,0.5)');
  blob(W * 0.6, H * 0.6, Math.max(W, H) * 0.35, 'rgba(255,255,255,0.35)');

  // ambient decorations (positions depend on size)
  clouds.length = 0;
  const n = W > 900 ? 5 : 3;
  for (let i = 0; i < n; i++) {
    const w = rand(180, 280) * S;
    clouds.push({ x: (i + rand(0.1, 0.6)) * (W / n), y: rand(0.12, 0.62) * H, w, speed: rand(5, 12) * S, alpha: rand(0.55, 0.85), bounce: 0 });
  }
  bgStars.length = 0;
  for (let i = 0; i < 22; i++) bgStars.push({ x: rand(0, W), y: rand(0, H * 0.75), s: rand(4, 9) * S, ph: rand(0, TAU), sp: rand(0.6, 1.4), c: (Math.random() * 6) | 0 });
}

function renderGame() {
  const g = ctx;
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  g.drawImage(bgCanvas, 0, 0, W, H);
  const level = Sound.level();
  G.wave += (level - G.wave) * 0.25;

  // combo / golden glow
  const glow = Math.min(1, G.combo / 15) * 0.45 + G.flash * 0.35 + (G.time < G.goldenUntil && G.phase === 'running' ? 0.3 : 0);
  if (glow > 0.01) {
    const rg = g.createRadialGradient(W / 2, H, 0, W / 2, H, Math.max(W, H) * 0.8);
    const gold = G.time < G.goldenUntil;
    rg.addColorStop(0, gold ? `rgba(255,214,92,${glow * 0.6})` : `rgba(255,170,210,${glow * 0.55})`);
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, W, H);
  }

  // twinkling background sparkles
  if (sprites.sparkles.length) {
    for (const s of bgStars) {
      const a = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(G.clock * s.sp + s.ph));
      g.globalAlpha = a;
      g.drawImage(sprites.sparkles[s.c], s.x - s.s, s.y - s.s, s.s * 2, s.s * 2);
    }
    g.globalAlpha = 1;
  }

  // clouds (bounce on musical hits)
  if (sprites.cloud) {
    const img = sprites.cloud, ar = img.height / img.width;
    for (const c of clouds) {
      const b = 1 + Math.sin(c.bounce * Math.PI * 3) * 0.05 * c.bounce;
      const w = c.w * b, h = c.w * ar * (2 - b);
      g.globalAlpha = c.alpha;
      g.drawImage(img, c.x - w / 2, c.y - h / 2 - c.bounce * 6, w, h);
    }
    g.globalAlpha = 1;
  }

  drawWaves(g);

  // ripples
  for (const r of G.ripples) {
    if (r.life < 0) continue;
    const k = r.life / r.dur;
    g.globalAlpha = (1 - k) * 0.8;
    g.strokeStyle = r.color;
    g.lineWidth = 4 * S * (1 - k) + 1;
    g.beginPath(); g.arc(r.x, r.y, r.r + (r.max - r.r) * easeOut(k), 0, TAU); g.stroke();
  }
  g.globalAlpha = 1;

  // targets
  if (sprites.targets.pink) {
    for (const t of G.targets) {
      g.save();
      g.translate(t.x, t.y);
      g.rotate(t.rot);
      let sx = 1, sy = 1, alpha = 1;
      const grow = Math.min(1, t.age / 0.35);
      sx = sy = easeBack(grow);
      if (t.T.kind === 'jelly' && !t.hit) { const j = Math.sin(t.age * 7) * 0.07; sx *= 1 + j; sy *= 1 - j; }
      if (t.T.kind === 'golden' && !t.hit) g.rotate(Math.sin(t.age * 2) * 0.2);
      if (t.T.kind === 'rainbow' && !t.hit) g.rotate(t.age * 0.8);
      if (t.hit) {
        const k = t.pop / (t.fading ? 0.5 : 0.28);
        const s = t.fading ? 1 - k * 0.4 : 1 + k * 0.6;
        sx *= s; sy *= s; alpha = 1 - k;
      }
      g.globalAlpha = clamp(alpha, 0, 1);
      g.scale(sx, sy);
      drawTargetSprite(g, t.type, t.r);
      g.restore();
    }
    g.globalAlpha = 1;
  }

  // projectiles
  if (sprites.bubble) {
    const img = sprites.bubble;
    for (const p of G.projectiles) {
      const fade = 1 - Math.max(0, (p.life - CONFIG.projectileMaxLife * 0.7) / (CONFIG.projectileMaxLife * 0.3));
      p.trail.forEach((q, i) => {
        const k = (i + 1) / p.trail.length;
        g.globalAlpha = 0.28 * k * fade;
        const s = p.r * 2 * (0.4 + 0.5 * k) * 2;
        g.drawImage(img, q.x - s / 2, q.y - s / 2, s, s);
      });
      g.globalAlpha = fade;
      const s = p.r * 4;
      g.drawImage(img, p.x - s / 2, p.y - s / 2, s, s);
    }
    g.globalAlpha = 1;
  }

  // particles
  for (const p of G.particles) {
    const k = p.age / p.life;
    g.globalAlpha = 1 - k * k;
    if (p.kind === 'star' && sprites.sparkles.length) {
      const s = p.size * (1 - k * 0.5);
      g.save(); g.translate(p.x, p.y); g.rotate(p.rot);
      g.drawImage(sprites.sparkles[p.sprite], -s, -s, s * 2, s * 2);
      g.restore();
    } else if (p.kind === 'note') {
      g.save(); g.translate(p.x, p.y); g.rotate(p.rot);
      g.font = `700 ${p.size}px Fredoka, Nunito, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 4; g.strokeStyle = 'rgba(255,255,255,0.9)';
      g.strokeText(p.glyph, 0, 0);
      g.fillStyle = p.color; g.fillText(p.glyph, 0, 0);
      g.restore();
    } else {
      g.fillStyle = p.color;
      g.beginPath(); g.arc(p.x, p.y, p.size, 0, TAU); g.fill();
    }
  }
  g.globalAlpha = 1;

  // floating score text
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const t of G.texts) {
    const k = t.life / 0.9;
    g.globalAlpha = 1 - k * k;
    g.font = `700 ${(t.big ? 34 : 26) * S * (1 + 0.25 * Math.sin(Math.min(1, k * 4) * Math.PI))}px Fredoka, Nunito, sans-serif`;
    g.lineWidth = 6; g.strokeStyle = '#fff'; g.lineJoin = 'round';
    g.strokeText(t.text, t.x, t.y);
    g.fillStyle = '#36214f'; g.fillText(t.text, t.x, t.y);
  }
  g.globalAlpha = 1;

  drawEqualizer(g);
  drawLauncher(g);
  drawCursors(g);
}

const easeOut = (k) => 1 - (1 - k) ** 3;
const easeBack = (k) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * (k - 1) ** 3 + c1 * (k - 1) ** 2; };

function drawWaves(g) {
  const amp0 = (5 + G.wave * 34) * S;
  const layers = [
    { base: H - 70 * S, col: 'rgba(205,184,255,0.30)', sp: 1.1, f: 0.011, off: 0 },
    { base: H - 46 * S, col: 'rgba(255,255,255,0.45)', sp: 1.6, f: 0.014, off: 2 },
  ];
  const step = Math.max(14, W / 70);
  for (const L of layers) {
    g.fillStyle = L.col;
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x <= W + step; x += step) {
      const env = 0.6 + 0.4 * Math.sin(x * 0.004 + G.clock * 0.7 + L.off);
      g.lineTo(x, L.base + Math.sin(x * L.f + G.clock * L.sp + L.off) * amp0 * env);
    }
    g.lineTo(W, H);
    g.closePath();
    g.fill();
  }
}

const EQ_COLORS = ['#ffb3d4', '#a9d3ff', '#a6edcf', '#cdb8ff', '#ffe68a'];
function drawEqualizer(g) {
  Sound.bands(eqBands, eqBands.length);
  const L = G.launcher;
  const bw = 7 * S, gap = 6 * S, maxH = 46 * S, base = H - 10 * S;
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < eqBands.length; i++) {
      const h = 5 * S + eqBands[i] * maxH;
      const x = L.x + side * (78 * S + i * (bw + gap)) - bw / 2;
      g.fillStyle = EQ_COLORS[i % EQ_COLORS.length];
      g.globalAlpha = 0.85;
      roundRect(g, x, base - h, bw, h, bw / 2);
      g.fill();
    }
  }
  g.globalAlpha = 1;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
}

function drawLauncher(g) {
  const L = G.launcher;
  g.save();
  g.translate(L.x, L.y);
  // barrel
  g.save();
  g.rotate(L.angle);
  const len = 64 * S * (1 - 0.18 * L.recoil), th = 28 * S;
  const bg = g.createLinearGradient(0, -th / 2, 0, th / 2);
  bg.addColorStop(0, '#ffd3e6'); bg.addColorStop(1, '#ec7fb2');
  g.fillStyle = bg; g.strokeStyle = '#fff'; g.lineWidth = 3;
  roundRect(g, 0, -th / 2, len, th, th / 2); g.fill(); g.stroke();
  g.fillStyle = '#fff';
  roundRect(g, len - 14 * S, -th / 2 - 4 * S, 12 * S, th + 8 * S, 6 * S); g.fill();
  g.restore();
  // dome
  const R = 52 * S;
  const dg = g.createRadialGradient(-R * 0.3, -R * 0.6, R * 0.1, 0, 0, R * 1.2);
  dg.addColorStop(0, '#f7f2ff'); dg.addColorStop(0.55, '#cdb8ff'); dg.addColorStop(1, '#9373ea');
  g.fillStyle = dg; g.strokeStyle = '#fff'; g.lineWidth = 3;
  g.beginPath(); g.arc(0, 10 * S, R, Math.PI, 0); g.closePath(); g.fill(); g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.65)';
  g.beginPath(); g.ellipse(-R * 0.38, -R * 0.42, R * 0.22, R * 0.1, -0.5, 0, TAU); g.fill();
  // face
  g.fillStyle = '#36214f';
  for (const sx of [-1, 1]) { g.beginPath(); g.ellipse(sx * 12 * S, -16 * S, 3.4 * S, 4.6 * S, 0, 0, TAU); g.fill(); }
  g.strokeStyle = '#36214f'; g.lineWidth = 2.6 * S; g.lineCap = 'round';
  g.beginPath(); g.arc(0, -12 * S, 5 * S, 0.2 * Math.PI, 0.8 * Math.PI); g.stroke();
  g.fillStyle = 'rgba(255,120,170,0.45)';
  for (const sx of [-1, 1]) { g.beginPath(); g.ellipse(sx * 22 * S, -9 * S, 5 * S, 3 * S, 0, 0, TAU); g.fill(); }
  g.restore();
}

function drawCursors(g) {
  if (G.phase === 'idle') return;
  const anyActive = G.cursors.some((c) => c.active);
  // While no hand is visible, show only the most recently used star, dimmed.
  const lastUsed = G.cursors.reduce((a, b) => (b.lastActive > a.lastActive ? b : a));
  for (const c of G.cursors) {
    if (c.active || (!anyActive && c === lastUsed && App.inputMode === 'hand')) drawCursor(g, c);
  }
}

function drawCursor(g, c) {
  const col = CURSOR_COLORS[c.id];
  const alpha = c.active ? 1 : 0.35;
  // soft trail
  c.trail.forEach((p, i) => {
    const k = (i + 1) / c.trail.length;
    g.globalAlpha = 0.25 * k * alpha;
    g.fillStyle = col[0];
    g.beginPath(); g.arc(p.x, p.y, 3 + 6 * k * S, 0, TAU); g.fill();
  });
  g.globalAlpha = alpha;
  // gesture-recognised pulse ring
  if (c.pulse > 0) {
    g.strokeStyle = `rgba(255,214,92,${c.pulse})`;
    g.lineWidth = 3;
    g.beginPath(); g.arc(c.x, c.y, (16 + 26 * (1 - c.pulse)) * S, 0, TAU); g.stroke();
  }
  // hover-to-pop progress: highlight the friend and fill a ring around the star
  if (c.dwellTarget && c.dwell > 0) {
    const k = Math.min(1, c.dwell / CONFIG.dwellSeconds), t = c.dwellTarget;
    g.strokeStyle = 'rgba(255,255,255,0.7)';
    g.lineWidth = 3;
    g.setLineDash([6 * S, 6 * S]);
    g.beginPath(); g.arc(t.x, t.y, t.r * 1.18, G.clock * 2, G.clock * 2 + TAU); g.stroke();
    g.setLineDash([]);
    g.lineCap = 'round';
    g.lineWidth = 5 * S;
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.beginPath(); g.arc(c.x, c.y, 26 * S, 0, TAU); g.stroke();
    g.strokeStyle = '#fff';
    g.shadowColor = col[3]; g.shadowBlur = 10;
    g.beginPath(); g.arc(c.x, c.y, 26 * S, -Math.PI / 2, -Math.PI / 2 + k * TAU); g.stroke();
    g.shadowBlur = 0;
  }
  g.save();
  g.translate(c.x, c.y);
  g.rotate(G.clock * 0.8);
  const s = (1 + c.pulse * 0.35) * S;
  g.shadowColor = col[3];
  g.shadowBlur = 16;
  const sg = g.createRadialGradient(-3 * s, -4 * s, 1, 0, 0, 16 * s);
  sg.addColorStop(0, col[0]); sg.addColorStop(0.6, col[1]); sg.addColorStop(1, col[2]);
  g.fillStyle = sg;
  g.strokeStyle = '#fff';
  g.lineWidth = 2.5;
  g.lineJoin = 'round';
  g.beginPath();
  starPoints(16 * s, 0.5).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath(); g.fill();
  g.shadowBlur = 0;
  g.stroke();
  g.restore();
  g.globalAlpha = 1;
}

// ===========================================================================
// HUD (DOM, updated only when values change)
// ===========================================================================
const HUD = {
  cache: {},
  bumpScore: false,
  reset() { this.cache = {}; },
  set(key, val, fn) { if (this.cache[key] !== val) { this.cache[key] = val; fn(val); } },
};
function updateHUD(now) {
  HUD.set('score', G.score, (v) => {
    const el = $('#hud-score');
    el.textContent = v;
    if (HUD.bumpScore) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); HUD.bumpScore = false; }
  });
  HUD.set('best', Math.max(Store.data.best, G.score), (v) => ($('#hud-best').textContent = v));
  const secs = Math.ceil(G.timeLeft);
  HUD.set('time', secs, (v) => {
    $('#hud-time').textContent = v;
    $('#hud-timer').classList.toggle('low', v <= 10 && G.phase === 'running');
    $('#hud-timer').setAttribute('aria-label', `${v} seconds left`);
  });
  HUD.set('ring', Math.round((G.timeLeft / CONFIG.roundSeconds) * 200) / 200, (v) => $('#hud-timer').style.setProperty('--p', v));
  HUD.set('combo', G.combo, (v) => {
    const el = $('#hud-combo');
    el.hidden = v < 2;
    $('b', el).textContent = v;
    const m = comboMultiplier(v);
    $('em', el).textContent = m > 1 ? `×${m}` : '';
  });
  HUD.set('gold', G.phase === 'running' && G.time < G.goldenUntil, (v) => ($('#hud-gold').hidden = !v));
  HUD.set('shower', G.phase === 'running' && G.time < G.showerUntil, (v) => ($('#hud-shower').hidden = !v));
  HUD.set('notes', G.notes.length, (v) => ($('#hud-notes').textContent = v));
  HUD.set('prog', Math.round((G.time / CONFIG.roundSeconds) * 400) / 4, (v) => ($('#hud-progress').style.width = `${v}%`));

  const lost = App.inputMode === 'hand' && App.state === 'playing' && G.phase !== 'over' &&
    (Hand.status === 'error' || (Hand.running && now - Hand.lastSeen > CONFIG.lostHandPromptMs && Hand.landmarker) || Hand.status === 'loading' || Hand.status === 'requesting');
  HUD.set('lost', lost ? Hand.status : '', (v) => {
    const el = $('#find-hand');
    el.hidden = !v;
    $('.fh-text', el).textContent = v === 'error' ? 'Camera unavailable.'
      : v === 'loading' || v === 'requesting' ? 'Waking up the camera…' : 'Show your hand!';
  });
}

function showCountdown(n) {
  const el = $('#countdown');
  el.textContent = '';
  const span = document.createElement('span');
  span.textContent = n > 0 ? n : 'Pop!';
  el.appendChild(span);
  if (Sound.ready()) Sound.blip(n <= 0);
}

function showToast(text, variant = '') {
  const layer = $('#toasts');
  while (layer.children.length >= 2) layer.firstChild.remove();
  const el = document.createElement('div');
  el.className = `toast ${variant}`;
  el.textContent = text;
  layer.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

// ===========================================================================
// Results + melody replay
// ===========================================================================
const ENCOURAGE = [
  [0, 'Give it another go!'],
  [1, 'A lovely start!'],
  [150, 'Nice popping!'],
  [350, 'Wonderful tune!'],
  [600, 'A real symphony!'],
  [900, 'Maestro! 👑'],
];

function enterResults() {
  const r = G.result;
  if (!r) return;
  $('#res-score').textContent = r.score;
  $('#res-hits').textContent = r.hits;
  $('#res-acc').textContent = r.accuracy === null ? '—' : `${r.accuracy}%`;
  $('#res-combo').textContent = r.bestCombo;
  $('#res-special').textContent = r.specials;
  $('#res-newbest').hidden = !r.isNewBest;
  let msg = ENCOURAGE[0][1];
  for (const [min, m] of ENCOURAGE) if (r.score >= min) msg = m;
  if (!r.isNewBest && r.hadPrevious) msg += ` · Best: ${Store.data.best}`;
  if (r.relaxed) msg += ' · Slow mode';
  $('#res-encourage').textContent = msg;

  Melody.load(r.notes);
  Confetti.start(r.isNewBest ? 160 : 90);
  if (r.isNewBest && Sound.ready()) setTimeout(() => Sound.celebrate(), 250);
}

/** Melody playback built from the recorded sequence — never random. */
const Melody = {
  seq: [], idx: 0, playing: false, timer: 0, items: [],
  load(events) {
    this.stop();
    // Keep the real order; quantise gaps to a brisk grid (~170 bpm eighths),
    // allowing a slightly longer note only where the player paused a lot.
    const UNIT = 0.17;
    this.seq = events.map((e, i) => {
      const next = events[i + 1];
      const units = next ? (next.time - e.time > 2.5 ? 2 : 1) : 2;
      return { ...e, gap: units * UNIT };
    });
    const strip = $('#melody-strip');
    strip.textContent = '';
    this.items = this.seq.map((e, i) => {
      const li = document.createElement('li');
      const T = TARGET_TYPES[e.type];
      const gem = document.createElement('span');
      gem.className = `note-gem ${T.shape}`;
      gem.style.setProperty('--c', T.colors[1]);
      if (T.kind === 'golden') gem.style.setProperty('--c', '#ffd65c');
      const lab = document.createElement('small');
      lab.textContent = e.note;
      li.append(gem, lab);
      li.title = `${i + 1}. ${T.label} — ${e.note}`;
      strip.appendChild(li);
      return li;
    });
    strip.setAttribute('aria-label', `${this.seq.length} recorded notes: ${this.seq.map((e) => e.note).join(', ')}`);
    const empty = !this.seq.length;
    $('#melody-empty').hidden = !empty;
    $('#melody-body').hidden = empty;
    this.ui();
  },
  play() {
    if (!this.seq.length) return;
    Sound.ensure();
    if (this.idx >= this.seq.length) this.idx = 0;
    this.playing = true;
    this.ui();
    ensureLoop();
    this.step();
  },
  step() {
    if (!this.playing) return;
    const i = this.idx;
    const e = this.seq[i];
    Sound.playTarget(e.type, { replay: true });
    this.highlight(i);
    this.idx++;
    if (this.idx >= this.seq.length) {
      this.timer = setTimeout(() => { this.playing = false; this.idx = 0; this.highlight(-1); this.ui(); }, 700);
      return;
    }
    this.timer = setTimeout(() => this.step(), e.gap * 1000);
  },
  pause() {
    this.playing = false;
    clearTimeout(this.timer);
    this.ui();
  },
  stop() {
    this.pause();
    this.idx = 0;
    this.highlight(-1);
  },
  replay() { this.stop(); this.play(); },
  highlight(i) {
    this.items.forEach((li, j) => {
      li.classList.toggle('playing', j === i);
      li.classList.toggle('played', i >= 0 && j < i);
    });
    const li = this.items[i];
    if (li) {
      const strip = $('#melody-strip');
      strip.scrollTo({ left: li.offsetLeft - strip.clientWidth / 2 + li.offsetWidth / 2, behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
  },
  ui() {
    const btn = $('#mel-play');
    btn.classList.toggle('is-playing', this.playing);
    btn.setAttribute('aria-label', this.playing ? 'Pause melody' : 'Play melody');
  },
};

function drawMelodyEq() {
  const c = $('#melody-eq');
  const g = c.getContext('2d');
  const bands = new Float32Array(12);
  Sound.bands(bands, 12);
  g.clearRect(0, 0, c.width, c.height);
  const bw = 6, gap = 4;
  for (let i = 0; i < 12; i++) {
    const h = 4 + bands[i] * (c.height - 6);
    g.fillStyle = EQ_COLORS[i % EQ_COLORS.length];
    roundRect(g, i * (bw + gap) + 1, c.height - h, bw, h, 3);
    g.fill();
  }
}

// ---- export: JSON + Standard MIDI File --------------------------------------
function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function stamp() { return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'); }

function exportJSON() {
  const r = G.result;
  if (!r || !r.notes.length) return;
  const data = {
    game: 'Pop! Pop! — Make a Little Melody', created: new Date().toISOString(), score: r.score,
    tempoNote: 'Gaps are quantised to 0.17s steps for playback.',
    notes: Melody.seq.map((e, i) => ({ index: i + 1, note: e.note, frequency: e.freq, midi: e.midi, time: e.time, gap: e.gap, target: e.type, combo: e.combo })),
  };
  download(`pop-pop-melody-${stamp()}.json`, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
}

function exportMIDI() {
  if (!Melody.seq.length) return;
  const TPQ = 480, SEC_PER_Q = 0.5; // 120 bpm
  const trk = [];
  const varLen = (n) => {
    const bytes = [n & 0x7f];
    while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
    trk.push(...bytes);
  };
  varLen(0); trk.push(0xff, 0x51, 0x03, 0x07, 0xa1, 0x20);        // tempo 500000 µs/quarter
  varLen(0); trk.push(0xc0, 10);                                    // GM Music Box
  let delta = 0;
  for (const e of Melody.seq) {
    const dur = Math.round(TPQ / 2);
    const step = Math.max(dur, Math.round((e.gap / SEC_PER_Q) * TPQ));
    varLen(delta); trk.push(0x90, e.midi, e.kind === 'golden' || e.kind === 'rainbow' ? 110 : 92);
    varLen(dur); trk.push(0x80, e.midi, 0);
    delta = step - dur;
  }
  varLen(0); trk.push(0xff, 0x2f, 0x00);
  const len = trk.length;
  const file = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, TPQ >> 8, TPQ & 0xff,
    0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, ...trk];
  download(`pop-pop-melody-${stamp()}.mid`, new Blob([new Uint8Array(file)], { type: 'audio/midi' }));
}

// ---- confetti (results celebration) -----------------------------------------
const Confetti = {
  pieces: [], active: false, ctx: null,
  start(n) {
    const c = $('#confetti');
    const dpr = Math.min(2, devicePixelRatio || 1);
    c.width = innerWidth * dpr; c.height = innerHeight * dpr;
    this.ctx = c.getContext('2d');
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const rm = reducedMotion();
    const count = rm ? 0 : n;
    const cols = ['#ffb3d4', '#a9d3ff', '#a6edcf', '#cdb8ff', '#ffe68a', '#ffffff'];
    this.pieces = Array.from({ length: count }, () => ({
      x: rand(0, innerWidth), y: rand(-innerHeight * 0.6, -10), vx: rand(-30, 30), vy: rand(70, 170),
      r: rand(0, TAU), vr: rand(-4, 4), w: rand(6, 11), h: rand(8, 14), c: cols[(Math.random() * cols.length) | 0],
      round: Math.random() < 0.35, sway: rand(0, TAU),
    }));
    this.active = count > 0;
    this.ctx.clearRect(0, 0, innerWidth, innerHeight);
    ensureLoop();
  },
  stop() {
    this.active = false;
    this.pieces = [];
    if (this.ctx) this.ctx.clearRect(0, 0, innerWidth, innerHeight);
  },
  update(dt) {
    if (!this.active) return;
    const g = this.ctx;
    g.clearRect(0, 0, innerWidth, innerHeight);
    let alive = 0;
    for (const p of this.pieces) {
      p.sway += dt * 3;
      p.x += (p.vx + Math.sin(p.sway) * 30) * dt;
      p.y += p.vy * dt;
      p.r += p.vr * dt;
      if (p.y < innerHeight + 20) alive++;
      g.save(); g.translate(p.x, p.y); g.rotate(p.r);
      g.fillStyle = p.c;
      if (p.round) { g.beginPath(); g.arc(0, 0, p.w / 2, 0, TAU); g.fill(); }
      else g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.sway)));
      g.restore();
    }
    if (!alive) this.stop();
  },
};

// ===========================================================================
// Landing / tutorial / setup rendering
// ===========================================================================
function renderLanding() {
  const el = $('#landing-best');
  const d = Store.data;
  if (d.gamesPlayed > 0) {
    el.innerHTML = `<span class="trophy" aria-hidden="true">🏆</span><span><small>Your best</small><b></b></span>`;
    $('b', el).textContent = d.best;
  } else {
    el.innerHTML = `<span class="trophy" aria-hidden="true">♪</span><span><b style="font-size:17px">Ready to make your first melody?</b></span>`;
  }
}

function renderLegend() {
  const ul = $('#legend');
  ul.textContent = '';
  const desc = {
    pink: '+10', blue: '+10', mint: '+15', lavender: '+10',
    yellow: '+10', golden: '+30 · ×2', rainbow: '+50 · 🌈',
  };
  for (const key of Object.keys(TARGET_TYPES)) {
    const T = TARGET_TYPES[key];
    const li = document.createElement('li');
    const c = document.createElement('canvas');
    c.width = c.height = 92;
    const g = c.getContext('2d');
    g.translate(46, 46);
    g.scale(2, 2);
    drawTargetSprite(g, key, 19);
    const txt = document.createElement('span');
    txt.textContent = desc[key];
    li.title = `${T.label} — plays ${T.note}`;
    li.append(c, txt);
    ul.appendChild(li);
  }
}

function renderCameraSetup() {
  App.inputMode = 'hand';
  document.body.dataset.input = 'hand';
  if (Hand.status === 'error') Hand.setStatus('idle');
  onHandStatus(Hand.status, Hand.errorCode);
  setCheck('pinch', false);
  $('#calib-text').textContent = Store.data.calibration ? 'Using your saved calibration.' : 'Calibrate to your comfortable reach (4 sec).';
}

// ===========================================================================
// Preferences
// ===========================================================================
function applyMotionPref() {
  const rm = reducedMotion();
  document.documentElement.classList.toggle('reduce-motion', rm);
  document.documentElement.classList.toggle('motion-ok', !rm);
}

function syncPrefsUI() {
  const d = Store.data;
  $$('[data-pref="volume"]').forEach((el) => (el.value = d.volume));
  $$('[data-pref="sensitivity"]').forEach((el) => (el.value = d.sensitivity));
  $$('[data-pref="muted"]').forEach((el) => (el.checked = d.muted));
  $$('[data-pref="reduceMotion"]').forEach((el) => (el.checked = reducedMotion()));
  $$('[data-pref="showPreview"]').forEach((el) => (el.checked = d.showPreview));
  $$('[data-pref="fireMode"]').forEach((el) => (el.checked = el.value === d.fireMode));
  document.body.dataset.fire = d.fireMode;
  $$('[data-out="volume"]').forEach((el) => (el.textContent = `${Math.round(d.volume * 100)}%`));
  $$('[data-out="sensitivity"]').forEach((el) => (el.textContent = `${(+d.sensitivity).toFixed(2)}×`));
  $$('[data-sound-toggle]').forEach((el) => {
    el.setAttribute('aria-pressed', String(!d.muted));
    el.setAttribute('aria-label', d.muted ? 'Sound off — click to unmute' : 'Sound on — click to mute');
    const lab = $('.sr-label', el);
    if (lab) lab.textContent = d.muted ? 'Unmute' : 'Mute';
  });
  $('#game-preview').classList.toggle('collapsed', !d.showPreview);
  $('#preview-toggle').textContent = d.showPreview ? 'Hide camera' : 'Show camera';
  $('#preview-toggle').setAttribute('aria-pressed', String(d.showPreview));
}

function setPref(key, value) {
  Store.data[key] = value;
  Store.sanitize();
  Store.save();
  if (key === 'volume' || key === 'muted') { Sound.ensure(); Sound.applyVolume(); }
  if (key === 'reduceMotion') applyMotionPref();
  if (key === 'fireMode') { for (const c of G.cursors) { c.dwell = 0; c.dwellTarget = null; } Hand.emit('status', Hand.status, Hand.errorCode); }
  syncPrefsUI();
}

// ===========================================================================
// Events
// ===========================================================================
function bindUI() {
  document.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) { navigateTo(nav.dataset.nav); return; }
    const snd = e.target.closest('[data-sound-toggle]');
    if (snd) { setPref('muted', !Store.data.muted); return; }
    if (e.target.closest('[data-open-settings]')) { openDialog($('#settings-dialog')); return; }
    const act = e.target.closest('[data-action]');
    if (act) handleAction(act.dataset.action, act);
  });

  $$('[data-pref]').forEach((el) => {
    const key = el.dataset.pref;
    el.addEventListener(el.type === 'radio' ? 'change' : 'input', () =>
      setPref(key, el.type === 'checkbox' ? el.checked : el.type === 'radio' ? el.value : +el.value));
  });

  $('#preview-toggle').addEventListener('click', () => setPref('showPreview', !Store.data.showPreview));
  $('#calib-start').addEventListener('click', () => Calib.start());
  $('#calib-reset').addEventListener('click', () => {
    Store.data.calibration = null;
    Store.save();
    $('#calib-text').textContent = 'Calibration reset.';
  });

  $('#mel-play').addEventListener('click', () => (Melody.playing ? Melody.pause() : Melody.play()));
  $('#mel-replay').addEventListener('click', () => Melody.replay());
  $('#mel-midi').addEventListener('click', exportMIDI);

  // Mouse / touch fallback
  const toCanvas = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener('pointermove', (e) => { const p = toCanvas(e); mouse.x = p.x; mouse.y = p.y; mouse.inside = true; });
  canvas.addEventListener('pointerleave', () => { mouse.inside = false; });
  canvas.addEventListener('pointerdown', (e) => {
    if (App.inputMode !== 'mouse' || App.state !== 'playing') return;
    const p = toCanvas(e);
    mouse.x = p.x; mouse.y = p.y; mouse.inside = true;
    G.cursor.x = p.x; G.cursor.y = p.y;
    fireProjectile(p.x, p.y);
  });

  document.addEventListener('keydown', (e) => {
    if (App.state === 'playing' && (e.key === 'Escape' || e.key === 'p' || e.key === 'P')) { e.preventDefault(); pauseGame(); }
    else if (App.state === 'paused' && (e.key === 'Escape' || e.key === 'p' || e.key === 'P')) { e.preventDefault(); resumeGame(); }
    else if (App.state === 'playing' && e.key === ' ' && !e.repeat) {
      // Space fires too: a backup for players whose pinch isn't picked up well.
      e.preventDefault();
      if (App.inputMode === 'mouse' && mouse.inside) fireProjectile(mouse.x, mouse.y);
      else if (App.inputMode === 'hand') {
        const c = G.cursors.find((x) => x.active);
        if (c) fireProjectile(c.x, c.y, null, c.id);
      }
    }
  });

  $('#test-dialog').addEventListener('close', () => closeTest());
}

function handleAction(action) {
  switch (action) {
    case 'play':
      App.inputMode = 'hand';
      navigateTo('cameraSetup');
      break;
    case 'start-game':
      App.inputMode = 'hand';
      startGame(false);
      break;
    case 'play-mouse':
      App.inputMode = 'mouse';
      if (App.testOpen) $('#test-dialog').close();
      startGame(false);
      break;
    case 'retry-camera':
      Hand.stop(true);
      Hand.setStatus('idle');
      syncCamera();
      break;
    case 'pause': pauseGame(); break;
    case 'resume': resumeGame(); break;
    case 'restart': startGame(G.relaxed); break;
    case 'again': startGame(false); break;
    case 'again-slow': startGame(true); break;
    case 'switch-mouse':
    case 'toggle-input': {
      App.inputMode = App.inputMode === 'hand' ? 'mouse' : 'hand';
      if (App.inputMode === 'hand' && Hand.status === 'error') Hand.setStatus('idle');
      document.body.dataset.input = App.inputMode;
      $('#mouse-pill').hidden = App.inputMode !== 'mouse';
      $('#toggle-input').textContent = App.inputMode === 'hand' ? 'Switch to mouse' : 'Switch to hand';
      $('#find-hand').hidden = true;
      HUD.cache.lost = undefined;
      syncCamera();
      break;
    }
    case 'open-test': openTest(); break;
    case 'close-test': $('#test-dialog').close(); break;
    case 'close-settings': $('#settings-dialog').close(); break;
    case 'clear-scores':
      if (confirm('Clear your saved best score, best combo and games played?')) {
        Store.clearScores();
        renderLanding();
      }
      break;
  }
}

function openDialog(d) {
  syncPrefsUI();
  if (!d.open) d.showModal();
}

function openTest() {
  App.testOpen = true;
  const pinchLi = $('#test-pinch');
  pinchLi.textContent = '☆ Try a pinch';
  pinchLi.classList.remove('ok');
  if (Hand.status === 'error') Hand.setStatus('idle');
  onHandStatus(Hand.status, Hand.errorCode);
  openDialog($('#test-dialog'));
  placePreview();
  syncCamera();
  ensureLoop();
}
function closeTest() {
  if (!App.testOpen) return;
  App.testOpen = false;
  placePreview();
  syncCamera();
}

function onVisibility() {
  if (document.hidden) {
    if (App.state === 'playing' && G.phase !== 'over') pauseGame();
    if (Melody.playing) Melody.pause();
  } else {
    lastT = performance.now();
    ensureLoop();
  }
}

initApp();
