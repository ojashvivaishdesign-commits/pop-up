// ---------------------------------------------------------------------------
// Synthesised sound engine (Web Audio API). No audio files required.
// Graph: voices → bus → compressor → analyser → master gain → speakers
// The analyser sits before the master gain so visuals still react when muted.
// ---------------------------------------------------------------------------
import { NOTES, TARGET_TYPES, Store } from './config.js';

const MAX_VOICES = 36;

export const Sound = {
  ctx: null,
  bus: null,
  master: null,
  analyser: null,
  freqData: null,
  noiseBuffer: null,
  voices: 0,

  /** Create or resume the AudioContext. Must be called from a user gesture first. */
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      const ctx = (this.ctx = new AC());
      this.bus = ctx.createGain();
      this.bus.gain.value = 0.9;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.2;
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.82;
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
      this.master = ctx.createGain();
      this.master.gain.value = this.targetGain();
      this.bus.connect(comp).connect(this.analyser).connect(this.master).connect(ctx.destination);

      const len = Math.floor(ctx.sampleRate * 0.4);
      this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  },

  ready() {
    return !!this.ctx && this.ctx.state === 'running';
  },

  targetGain() {
    return Store.data.muted ? 0 : Store.data.volume * 0.9;
  },

  /** Apply the current volume / mute preference smoothly. */
  applyVolume() {
    if (!this.master) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(this.targetGain(), t, 0.02);
  },

  canPlay(cost = 1) {
    return this.ready() && this.voices + cost <= MAX_VOICES;
  },

  /** A single enveloped oscillator voice. */
  tone({ freq, type = 'sine', start, dur, gain = 0.2, attack = 0.005, dest, glideTo, glideTime = 0.08 }) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, start);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, start + glideTime);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(gain, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g).connect(dest || this.bus);
    o.start(start);
    o.stop(start + dur + 0.05);
    this.voices++;
    o.onended = () => {
      this.voices--;
      g.disconnect();
    };
  },

  // --- instruments --------------------------------------------------------
  bell(freq, t, vol = 1) {
    this.tone({ freq, type: 'sine', start: t, dur: 1.1, gain: 0.22 * vol, attack: 0.004 });
    this.tone({ freq: freq * 2, type: 'sine', start: t, dur: 0.5, gain: 0.06 * vol, attack: 0.003 });
    this.tone({ freq: freq * 3, type: 'triangle', start: t, dur: 0.22, gain: 0.018 * vol, attack: 0.002 });
  },
  pluck(freq, t, vol = 1) {
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    lp.connect(this.bus);
    // "boing": start sharp and slide down into the note
    this.tone({ freq: freq * 1.5, glideTo: freq, glideTime: 0.07, type: 'triangle', start: t, dur: 0.5, gain: 0.3 * vol, dest: lp });
    this.tone({ freq: freq / 2, glideTo: freq / 2 * 0.98, type: 'sine', start: t, dur: 0.32, gain: 0.08 * vol });
    setTimeout(() => lp.disconnect(), 900);
  },
  chime(freq, t, vol = 1) {
    const partials = [[1, 0.17, 1.6], [2, 0.07, 1.1], [3.01, 0.045, 0.8], [4.17, 0.03, 0.5]];
    for (const [m, g, d] of partials) this.tone({ freq: freq * m, start: t, dur: d, gain: g * vol, attack: 0.002 });
    this.tone({ freq: freq * 2, start: t + 0.09, dur: 0.9, gain: 0.06 * vol, attack: 0.003 });
  },
  flourish(t, vol = 1) {
    const seq = ['C5', 'E5', 'G5', 'A5', 'C6', 'E6'];
    seq.forEach((n, i) => this.bell(NOTES[n].freq, t + i * 0.065, 0.7 * vol));
    this.chime(NOTES.C6.freq, t + seq.length * 0.065, 0.8 * vol);
  },

  // --- game sounds --------------------------------------------------------
  /** Play the musical identity of a target type. */
  playTarget(typeKey, { replay = false } = {}) {
    if (!this.canPlay(4)) return;
    const T = TARGET_TYPES[typeKey];
    const freq = NOTES[T.note].freq;
    const t = this.ctx.currentTime + 0.005;
    if (T.kind === 'jelly') this.pluck(freq, t);
    else if (T.kind === 'golden') this.chime(freq, t);
    else if (T.kind === 'rainbow') replay ? (this.bell(freq, t), this.chime(freq * 1.5, t + 0.08, 0.6)) : this.flourish(t);
    else this.bell(freq, t);
  },
  /** Soft harmonic accent (a fifth above) for combo streaks. */
  comboAccent(typeKey, combo) {
    if (!this.canPlay(1)) return;
    const freq = NOTES[TARGET_TYPES[typeKey].note].freq * (combo >= 10 ? 2 : 1.5);
    this.tone({ freq, start: this.ctx.currentTime + 0.07, dur: 0.55, gain: 0.05, attack: 0.01 });
  },
  pew() {
    if (!this.canPlay(1)) return;
    this.tone({ freq: 1150, glideTo: 460, glideTime: 0.12, type: 'triangle', start: this.ctx.currentTime, dur: 0.16, gain: 0.07, attack: 0.004 });
  },
  /** Very quiet airy puff when a bubble floats away. */
  miss() {
    if (!this.canPlay(1)) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.03, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    src.connect(bp).connect(g).connect(this.bus);
    src.start(t);
    src.stop(t + 0.3);
    this.voices++;
    src.onended = () => { this.voices--; g.disconnect(); };
  },
  blip(high = false) {
    if (!this.canPlay(2)) return;
    const t = this.ctx.currentTime;
    this.tone({ freq: high ? 1046.5 : 659.25, start: t, dur: high ? 0.5 : 0.22, gain: 0.12, attack: 0.004 });
    if (high) this.tone({ freq: 1318.5, start: t + 0.06, dur: 0.45, gain: 0.07 });
  },
  celebrate() {
    if (!this.canPlay(10)) return;
    const t = this.ctx.currentTime + 0.05;
    this.flourish(t, 0.9);
    ['C5', 'E5', 'G5'].forEach((n) => this.tone({ freq: NOTES[n].freq / 2, start: t + 0.45, dur: 1.4, gain: 0.07, attack: 0.03 }));
  },

  /** 0..1 loudness estimate for sound-reactive visuals. */
  level() {
    if (!this.analyser) return 0;
    this.analyser.getByteFrequencyData(this.freqData);
    let sum = 0;
    for (let i = 2; i < 40; i++) sum += this.freqData[i];
    return Math.min(1, sum / (38 * 255) * 2.2);
  },
  /** Fill `out` with `n` frequency bands, 0..1 (call after level() or alone). */
  bands(out, n) {
    if (!this.analyser) { out.fill(0); return out; }
    this.analyser.getByteFrequencyData(this.freqData);
    const start = 3, span = 54;
    for (let i = 0; i < n; i++) {
      const a = start + Math.floor((i / n) * span), b = start + Math.floor(((i + 1) / n) * span);
      let s = 0;
      for (let j = a; j < Math.max(b, a + 1); j++) s += this.freqData[j];
      out[i] = Math.min(1, (s / Math.max(1, b - a) / 255) * 1.6);
    }
    return out;
  },
};
