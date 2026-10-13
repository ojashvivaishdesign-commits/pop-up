// ---------------------------------------------------------------------------
// Shared configuration, musical palette, target catalogue and persistence.
// ---------------------------------------------------------------------------

export const CONFIG = {
  roundSeconds: 60,
  countdownSeconds: 3,
  projectileSpeed: 1700,     // px/s at an 800px-tall canvas (scaled to screen)
  projectileRadius: 11,      // px at scale 1
  projectileMaxLife: 1.4,    // seconds before a bubble fades away
  shotCooldown: 0.28,        // seconds between shots
  comboTimeout: 3.5,         // seconds without a hit before the combo resets
  maxTargets: 12,
  maxParticles: 260,
  goldenSeconds: 6,
  showerSeconds: 6,
  // Pinch gesture (thumb-tip ↔ index-tip distance / palm length), with hysteresis
  pinchClose: 0.42,
  pinchOpen: 0.58,
  pinchConfirmFrames: 2,
  // Fire with the aim from slightly before the pinch, since pinching drags the fingertip
  aimLookbackMs: 120,
  lostHandPromptMs: 1200,
  // Hover-to-pop: seconds the star must rest on a friend before a bubble launches
  dwellSeconds: 0.32,
};

export const MEDIAPIPE = {
  bundle: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs',
  wasm: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
  model: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};

// Major-pentatonic palette: any order of these sounds pleasant together.
export const NOTES = {
  C5: { freq: 523.25, midi: 72 },
  D5: { freq: 587.33, midi: 74 },
  E5: { freq: 659.25, midi: 76 },
  G5: { freq: 783.99, midi: 79 },
  A5: { freq: 880.0, midi: 81 },
  C6: { freq: 1046.5, midi: 84 },
  E6: { freq: 1318.51, midi: 88 },
};

// One consistent colour/shape ↔ note mapping, used by the game, tutorial and replay.
export const TARGET_TYPES = {
  pink:     { label: 'Pink Pop',      note: 'C5', shape: 'circle', kind: 'regular', points: 10, colors: ['#fff2f8', '#ffb3d4', '#e874aa'], accent: '#ec7fb2' },
  blue:     { label: 'Blue Star',     note: 'D5', shape: 'star',   kind: 'regular', points: 10, colors: ['#f1f8ff', '#a9d3ff', '#5f98e0'], accent: '#6fa6ea' },
  mint:     { label: 'Mint Jelly',    note: 'E5', shape: 'jelly',  kind: 'jelly',   points: 15, colors: ['#f0fff8', '#a6edcf', '#4fbf8e'], accent: '#4fbf8e' },
  lavender: { label: 'Lavender Puff', note: 'G5', shape: 'cloud',  kind: 'regular', points: 10, colors: ['#f7f2ff', '#cdb8ff', '#9373ea'], accent: '#9c7cf0' },
  yellow:   { label: 'Butter Blossom', note: 'A5', shape: 'flower',   kind: 'regular', points: 10, colors: ['#fffbe8', '#ffe68a', '#eab53a'], accent: '#f3bf3f' },
  golden:   { label: 'Golden Star',   note: 'E6', shape: 'star',   kind: 'golden',  points: 30, colors: ['#fffdf0', '#ffd65c', '#e09a12'], accent: '#f5b324', glow: 'rgba(255,214,92,0.95)' },
  rainbow:  { label: 'Rainbow Orb',   note: 'C6', shape: 'orb',    kind: 'rainbow', points: 50, colors: ['#ffffff', '#ffd6ec', '#b9a2ff'], accent: '#b79cff', glow: 'rgba(255,255,255,0.95)' },
};
export const REGULAR_KEYS = ['pink', 'blue', 'mint', 'lavender', 'yellow'];

export const DEFAULT_CALIBRATION = { x0: 0.12, x1: 0.88, y0: 0.1, y1: 0.75 };

// ---- Persistence (gracefully degrades when localStorage is unavailable) ----
const DEFAULTS = {
  best: 0, bestCombo: 0, gamesPlayed: 0, totalHits: 0,
  volume: 0.8, muted: false, sensitivity: 1,
  reduceMotion: null,      // null = follow the OS preference
  showPreview: true,
  fireMode: 'hover',      // hover | pinch
  calibration: null,
};

export const Store = {
  KEY: 'popPop.v1',
  available: true,
  data: { ...DEFAULTS },
  load() {
    try {
      const raw = localStorage.getItem(this.KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        for (const k of Object.keys(DEFAULTS)) if (k in saved) this.data[k] = saved[k];
      }
    } catch (e) {
      this.available = false;
    }
    this.sanitize();
  },
  sanitize() {
    const d = this.data;
    const num = (v, def, min, max) => (Number.isFinite(+v) ? Math.min(max, Math.max(min, +v)) : def);
    d.best = num(d.best, 0, 0, 1e9) | 0;
    d.bestCombo = num(d.bestCombo, 0, 0, 1e6) | 0;
    d.gamesPlayed = num(d.gamesPlayed, 0, 0, 1e9) | 0;
    d.totalHits = num(d.totalHits, 0, 0, 1e9) | 0;
    d.volume = num(d.volume, 0.8, 0, 1);
    d.sensitivity = num(d.sensitivity, 1, 0.7, 1.6);
    d.muted = !!d.muted;
    d.showPreview = d.showPreview !== false;
    if (d.fireMode !== 'pinch') d.fireMode = 'hover';
    if (d.reduceMotion !== null) d.reduceMotion = !!d.reduceMotion;
    const c = d.calibration;
    if (!c || ![c.x0, c.x1, c.y0, c.y1].every(Number.isFinite) || c.x1 - c.x0 < 0.15 || c.y1 - c.y0 < 0.15) d.calibration = null;
  },
  save() {
    try {
      localStorage.setItem(this.KEY, JSON.stringify(this.data));
    } catch (e) {
      this.available = false;
    }
  },
  clearScores() {
    Object.assign(this.data, { best: 0, bestCombo: 0, gamesPlayed: 0, totalHits: 0 });
    this.save();
  },
};

const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
export function reducedMotion() {
  return Store.data.reduceMotion ?? motionQuery.matches;
}
export function onSystemMotionChange(fn) {
  motionQuery.addEventListener?.('change', fn);
}
