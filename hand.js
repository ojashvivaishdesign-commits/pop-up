// ---------------------------------------------------------------------------
// Webcam + MediaPipe Hand Landmarker.
// Owns the camera stream, runs detection on new video frames, smooths the
// index fingertip and recognises the pinch gesture (thumb tip ↔ index tip).
// ---------------------------------------------------------------------------
import { CONFIG, MEDIAPIPE } from './config.js';

/** One Euro filter — low lag when moving fast, low jitter when still. */
class OneEuro {
  constructor(minCutoff = 1.4, beta = 6, dCutoff = 1.0) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.reset();
  }
  reset() { this.x = null; this.dx = 0; this.t = null; }
  alpha(dt, cutoff) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(x, t) {
    if (this.x === null) { this.x = x; this.t = t; return x; }
    const dt = Math.max(1e-3, t - this.t);
    this.t = t;
    const dx = (x - this.x) / dt;
    this.dx += this.alpha(dt, this.dCutoff) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += this.alpha(dt, cutoff) * (x - this.x);
    return this.x;
  }
}

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

/** Per-hand tracking state (the game follows up to two hands). */
class HandSlot {
  constructor(id) {
    this.id = id;
    this.fx = new OneEuro();
    this.fy = new OneEuro();
    this.lastSeen = -1e9;
    this.reset();
  }
  reset() {
    this.present = false;
    this.landmarks = null;
    this.tip = { x: 0.5, y: 0.5 };
    this.history = [];
    this.pinchRatio = 1;
    this.pinchState = 'unknown';
    this.closeFrames = 0;
    this.fx.reset();
    this.fy.reset();
  }
}

export const Hand = {
  video: null,
  stream: null,
  landmarker: null,
  modelPromise: null,
  token: 0,
  starting: false,

  /** idle | requesting | loading | searching | detected | error */
  status: 'idle',
  errorCode: null,       // denied | notfound | inuse | insecure | model | unknown
  aspect: 4 / 3,

  everDetected: false,
  // Slot 0 = the hand on the left of the (mirrored) screen, slot 1 = the right.
  slots: [new HandSlot(0), new HandSlot(1)],
  lastVideoTime: -1,
  lastTs: 0,
  failStreak: 0,
  rebuilding: false,

  // --- convenience views over the "primary" hand (first one visible) -------
  get primary() { return this.slots.find((s) => s.present) || this.slots[0]; },
  get present() { return this.slots.some((s) => s.present); },
  get presentCount() { return this.slots.filter((s) => s.present).length; },
  get lastSeen() { return Math.max(this.slots[0].lastSeen, this.slots[1].lastSeen); },
  get tip() { return this.primary.tip; },
  get landmarks() { return this.primary.landmarks; },
  get pinchRatio() { return this.primary.pinchRatio; },
  get pinchState() { return this.primary.pinchState; },

  listeners: { status: new Set(), pinch: new Set() },
  on(evt, fn) { this.listeners[evt].add(fn); },
  emit(evt, ...args) { this.listeners[evt].forEach((fn) => fn(...args)); },

  setStatus(s, code = null) {
    if (this.status === s && this.errorCode === code) return;
    this.status = s;
    this.errorCode = code;
    this.emit('status', s, code);
  },

  init(videoEl) { this.video = videoEl; },
  get running() { return !!this.stream; },

  /** Lazily load MediaPipe + model once; reused for every later session. */
  loadModel() {
    if (this.landmarker) return Promise.resolve(this.landmarker);
    if (!this.modelPromise) {
      this.modelPromise = (async () => {
        const vision = await import(/* @vite-ignore */ MEDIAPIPE.bundle);
        const fileset = await vision.FilesetResolver.forVisionTasks(MEDIAPIPE.wasm);
        const opts = (delegate) => ({
          baseOptions: { modelAssetPath: MEDIAPIPE.model, delegate },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
        try {
          this.landmarker = await vision.HandLandmarker.createFromOptions(fileset, opts('GPU'));
        } catch (gpuErr) {
          console.warn('GPU delegate unavailable, falling back to CPU.', gpuErr);
          this.landmarker = await vision.HandLandmarker.createFromOptions(fileset, opts('CPU'));
        }
        this.emit('status', this.status, this.errorCode);
        return this.landmarker;
      })().catch((err) => {
        this.modelPromise = null; // allow a retry
        throw err;
      });
    }
    return this.modelPromise;
  },

  /**
   * Start the webcam (only called once the player opened camera setup / test /
   * gameplay). `stillNeeded` lets us drop a stream that resolved too late.
   */
  async start(stillNeeded = () => true) {
    if (this.stream || this.starting) return;
    const token = ++this.token;
    this.starting = true;
    this.setStatus('requesting');

    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.starting = false;
      this.setStatus('error', 'insecure');
      return;
    }
    // Begin fetching the model in parallel with the permission prompt.
    const modelP = this.loadModel();
    modelP.catch(() => {});

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      });
    } catch (err) {
      if (token !== this.token) return;
      this.starting = false;
      const name = err && err.name;
      const code = name === 'NotAllowedError' || name === 'SecurityError' ? 'denied'
        : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'notfound'
        : name === 'NotReadableError' || name === 'AbortError' ? 'inuse' : 'unknown';
      this.setStatus('error', code);
      return;
    }
    if (token !== this.token || !stillNeeded()) {
      stream.getTracks().forEach((t) => t.stop());
      if (token === this.token) { this.starting = false; this.setStatus('idle'); }
      return;
    }
    this.stream = stream;
    const v = this.video;
    v.srcObject = stream;
    await new Promise((res) => (v.readyState >= 1 ? res() : v.addEventListener('loadedmetadata', res, { once: true })));
    v.play().catch(() => {});
    if (v.videoWidth && v.videoHeight) this.aspect = v.videoWidth / v.videoHeight;
    this.emit('status', this.status, null); // lets the UI pick up the aspect / live video

    if (!this.landmarker) this.setStatus('loading');
    try {
      await modelP;
    } catch (err) {
      console.error('Hand tracking model failed to load', err);
      if (token !== this.token) return;
      this.starting = false;
      this.stop(true);
      this.setStatus('error', 'model');
      return;
    }
    if (token !== this.token) return;
    this.starting = false;
    this.resetTracking();
    this.setStatus('searching');
  },

  /** If MediaPipe's graph gets stuck in an error state, recreate it. */
  rebuild() {
    if (this.rebuilding) return;
    this.rebuilding = true;
    console.warn('Hand tracking got stuck — restarting it.');
    const old = this.landmarker;
    this.landmarker = null;
    this.modelPromise = null;
    try { old && old.close(); } catch (e) { /* ignore */ }
    this.loadModel()
      .then(() => { this.failStreak = 0; this.lastTs = 0; this.resetTracking(); })
      .catch((err) => { console.error(err); this.setStatus('error', 'model'); })
      .finally(() => { this.rebuilding = false; });
  },

  /** Stop all camera tracks. Keeps the loaded model for reuse. */
  stop(keepStatus = false) {
    this.token++;
    this.starting = false;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) { this.video.pause(); this.video.srcObject = null; }
    this.resetTracking();
    if (!keepStatus) this.setStatus('idle');
  },

  resetTracking() {
    for (const s of this.slots) { s.reset(); s.lastSeen = -1e9; }
    this.lastVideoTime = -1;
  },

  /** Run detection on the newest video frame (called from the single app loop). */
  update(now) {
    const v = this.video;
    if (!this.stream || !this.landmarker || v.readyState < 2) return;
    if (v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;

    // MediaPipe needs strictly increasing timestamps; a repeat poisons its graph.
    const ts = Math.max(Math.floor(now), this.lastTs + 1);
    this.lastTs = ts;
    let result;
    try {
      result = this.landmarker.detectForVideo(v, ts);
      this.failStreak = 0;
    } catch (err) {
      if (++this.failStreak === 1) console.warn('Hand tracking frame failed', err);
      if (this.failStreak >= 8) this.rebuild();
      return;
    }
    const found = (result && result.landmarks) || [];
    const assigned = this.assignSlots(found, now);
    for (const slot of this.slots) {
      const lms = assigned.get(slot);
      if (lms) this.updateSlot(slot, lms, now);
      else {
        slot.present = false;
        slot.landmarks = null;
        if (now - slot.lastSeen > 250) slot.reset();
      }
    }
    if (found.length) {
      this.everDetected = true;
      if (this.status !== 'detected') this.setStatus('detected');
    } else if (this.status === 'detected' && now - this.lastSeen > 400) {
      this.setStatus('searching');
    }
  },

  /**
   * Match detected hands to slots so each cursor keeps following the same
   * hand: by distance to where each slot was last seen, otherwise by side of
   * the screen (left hand → slot 0, right hand → slot 1).
   */
  assignSlots(found, now) {
    const map = new Map();
    const tips = found.map((l) => ({ x: 1 - l[8].x, y: l[8].y }));
    const recent = (s) => now - s.lastSeen < 300;
    const cost = (slot, t) => recent(slot)
      ? Math.hypot(slot.tip.x - t.x, slot.tip.y - t.y)
      : 0.6 + (slot.id === 0 ? t.x : 1 - t.x) * 0.4;
    const [a, b] = this.slots;
    if (found.length >= 2) {
      const straight = cost(a, tips[0]) + cost(b, tips[1]);
      const swapped = cost(a, tips[1]) + cost(b, tips[0]);
      if (straight <= swapped) { map.set(a, found[0]); map.set(b, found[1]); }
      else { map.set(a, found[1]); map.set(b, found[0]); }
    } else if (found.length === 1) {
      map.set(cost(a, tips[0]) <= cost(b, tips[0]) ? a : b, found[0]);
    }
    return map;
  },

  updateSlot(slot, lms, now) {
    slot.present = true;
    slot.lastSeen = now;
    slot.landmarks = lms;
    const mx = 1 - lms[8].x, my = lms[8].y; // mirror so it matches the preview
    const t = now / 1000;
    slot.tip = { x: slot.fx.filter(mx, t), y: slot.fy.filter(my, t) };
    slot.history.push({ t: now, x: slot.tip.x, y: slot.tip.y });
    while (slot.history.length && now - slot.history[0].t > 500) slot.history.shift();
    this.detectPinch(slot, lms, now);
  },

  /**
   * Pinch = transition from "open" into "closed". Hysteresis + a couple of
   * confirming frames stop tracking noise from firing repeated shots, and a
   * held pinch never fires twice.
   */
  detectPinch(slot, lms, now) {
    const ax = this.aspect;
    const d = (a, b) => Math.hypot((a.x - b.x) * ax, a.y - b.y);
    const palm = Math.max(1e-3, d(lms[0], lms[9]));
    // The thumb often meets the index finger's pad rather than its very tip,
    // so measure to whichever of the tip (8) or last knuckle (7) is closer.
    const ratio = Math.min(d(lms[4], lms[8]), d(lms[4], lms[7]) * 1.15) / palm;
    slot.pinchRatio = ratio;

    if (slot.pinchState === 'unknown') {
      // Re-acquired hand: adopt the current pose without firing.
      slot.pinchState = ratio < CONFIG.pinchClose ? 'closed' : 'open';
      slot.closeFrames = 0;
    } else if (slot.pinchState === 'open') {
      if (ratio < CONFIG.pinchClose) {
        if (++slot.closeFrames >= CONFIG.pinchConfirmFrames) {
          slot.pinchState = 'closed';
          slot.closeFrames = 0;
          this.emit('pinch', now, slot.id);
        }
      } else slot.closeFrames = 0;
    } else if (ratio > CONFIG.pinchOpen) {
      slot.pinchState = 'open';
    }
  },

  /** 0 (open) … 1 (pinched) for UI meters (primary hand). */
  pinchAmount() {
    return Math.max(0, Math.min(1, (1 - this.pinchRatio) / (1 - CONFIG.pinchClose)));
  },

  /** A slot's smoothed tip from roughly `t` ms ago (falls back to oldest/newest). */
  aimAt(t, slotId = this.primary.id) {
    const slot = this.slots[slotId];
    const h = slot.history;
    if (!h.length) return slot.tip;
    for (let i = h.length - 1; i >= 0; i--) if (h[i].t <= t) return h[i];
    return h[0];
  },
};
