// ---------------------------------------------------------------------------
// Pre-rendered canvas sprites. Glossy targets, clouds, sparkles and bubbles are
// drawn once into offscreen canvases so the game loop only blits images.
// ---------------------------------------------------------------------------
import { TARGET_TYPES } from './config.js';

export const SPRITE_R = 60;       // target radius inside a sprite (CSS px)
const PAD = 28;                   // room for glow
const SCALE = 2;                  // sprites are rendered at 2× for crispness
const INK = '#36214f';

export const sprites = { targets: {}, sparkles: [], cloud: null, bubble: null };
export const SPARKLE_COLORS = ['#ffffff', '#ffe68a', '#ffb3d4', '#a9d3ff', '#a6edcf', '#cdb8ff'];

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * SCALE);
  c.height = Math.ceil(h * SCALE);
  const g = c.getContext('2d');
  g.scale(SCALE, SCALE);
  return [c, g];
}

/** Rounded polygon through `pts` using arcTo at each corner. */
function roundedPoly(g, pts, radius) {
  const n = pts.length;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const start = mid(pts[n - 1], pts[0]);
  g.moveTo(start[0], start[1]);
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    g.arcTo(p[0], p[1], q[0], q[1], radius);
  }
  g.closePath();
}

export function starPoints(R, inner = 0.52, points = 5) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? R * inner : R;
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return pts;
}

/** Shape path for each target silhouette, centred on 0,0 with radius R. */
export function bodyPath(g, shape, R) {
  g.beginPath();
  switch (shape) {
    case 'star':
      roundedPoly(g, starPoints(R * 1.08, 0.55), R * 0.16);
      break;
    case 'jelly':
      g.moveTo(-R, R * 0.25);
      g.bezierCurveTo(-R, -R * 1.15, R, -R * 1.15, R, R * 0.25);
      g.quadraticCurveTo(R, R * 0.9, R * 0.6, R * 0.82);
      g.quadraticCurveTo(R * 0.35, R * 0.78, R * 0.18, R * 0.92);
      g.quadraticCurveTo(-R * 0.05, R * 1.04, -R * 0.3, R * 0.86);
      g.quadraticCurveTo(-R * 0.55, R * 0.72, -R * 0.75, R * 0.88);
      g.quadraticCurveTo(-R, R * 0.98, -R, R * 0.25);
      g.closePath();
      break;
    case 'cloud': {
      const circles = [[-R * 0.5, R * 0.12, R * 0.46], [0, -R * 0.22, R * 0.62], [R * 0.5, R * 0.1, R * 0.48], [-R * 0.18, R * 0.36, R * 0.44], [R * 0.24, R * 0.36, R * 0.44]];
      for (const [x, y, r] of circles) { g.moveTo(x + r, y); g.arc(x, y, r, 0, Math.PI * 2); }
      break;
    }
    case 'flower': {
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / 5;
        const x = Math.cos(a) * R * 0.52, y = Math.sin(a) * R * 0.52;
        g.moveTo(x + R * 0.5, y); g.arc(x, y, R * 0.5, 0, Math.PI * 2);
      }
      g.moveTo(R * 0.62, 0); g.arc(0, 0, R * 0.62, 0, Math.PI * 2);
      break;
    }
    default:
      g.arc(0, 0, R, 0, Math.PI * 2);
  }
}

function drawFace(g, R, kind) {
  const s = R / 60;
  const y = kind === 'star' || kind === 'golden' ? R * 0.1 : kind === 'jelly' ? R * 0.05 : R * 0.06;
  const ex = R * 0.24;
  g.fillStyle = INK;
  if (kind === 'rainbow') {
    // happy closed eyes ^ ^
    g.strokeStyle = INK; g.lineWidth = 3.2 * s; g.lineCap = 'round';
    for (const sx of [-1, 1]) { g.beginPath(); g.arc(sx * ex, y + 2 * s, 6 * s, Math.PI * 1.15, Math.PI * 1.85); g.stroke(); }
  } else {
    for (const sx of [-1, 1]) {
      g.beginPath(); g.ellipse(sx * ex, y, 5 * s, 6.8 * s, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff';
      g.beginPath(); g.arc(sx * ex - 1.6 * s, y - 2.5 * s, 2 * s, 0, Math.PI * 2); g.fill();
      g.fillStyle = INK;
    }
  }
  // mouth
  g.strokeStyle = INK; g.lineWidth = 3.2 * s; g.lineCap = 'round';
  g.beginPath();
  if (kind === 'jelly') { g.ellipse(0, y + 11 * s, 4 * s, 4.6 * s, 0, 0, Math.PI * 2); g.fill(); }
  else if (kind === 'golden' || kind === 'rainbow') {
    g.moveTo(-8 * s, y + 8 * s); g.quadraticCurveTo(0, y + 20 * s, 8 * s, y + 8 * s); g.closePath();
    g.fillStyle = '#c2456f'; g.fill(); g.stroke();
  } else { g.arc(0, y + 5 * s, 7 * s, Math.PI * 0.18, Math.PI * 0.82); g.stroke(); }
  // blush
  g.fillStyle = 'rgba(255, 120, 170, 0.45)';
  for (const sx of [-1, 1]) { g.beginPath(); g.ellipse(sx * R * 0.42, y + 9 * s, 7 * s, 4 * s, 0, 0, Math.PI * 2); g.fill(); }
}

function sparkleShape(g, x, y, s) {
  g.beginPath();
  g.moveTo(x, y - s);
  g.quadraticCurveTo(x, y, x + s, y);
  g.quadraticCurveTo(x, y, x, y + s);
  g.quadraticCurveTo(x, y, x - s, y);
  g.quadraticCurveTo(x, y, x, y - s);
  g.fill();
}

function makeTargetSprite(key) {
  const T = TARGET_TYPES[key];
  const R = SPRITE_R;
  const size = (R + PAD) * 2;
  const [c, g] = makeCanvas(size, size);
  g.translate(size / 2, size / 2);

  // glow for specials
  if (T.glow) {
    g.save();
    g.shadowColor = T.glow; g.shadowBlur = 26;
    bodyPath(g, T.shape, R); g.fillStyle = T.colors[1]; g.fill();
    g.restore();
  }
  // soft drop shadow
  g.save();
  g.shadowColor = 'rgba(80, 50, 140, 0.28)'; g.shadowBlur = 14; g.shadowOffsetY = 7;
  bodyPath(g, T.shape, R); g.fillStyle = T.colors[1]; g.fill();
  g.restore();

  // white rim (stroked first so overlapping cloud puffs stay seamless)
  bodyPath(g, T.shape, R);
  g.lineJoin = 'round'; g.lineWidth = 6; g.strokeStyle = 'rgba(255,255,255,0.95)'; g.stroke();

  // body fill
  let fill;
  if (key === 'rainbow') {
    if (g.createConicGradient) {
      fill = g.createConicGradient(0, 0, 0);
      ['#ffb3d4', '#ffe68a', '#a6edcf', '#a9d3ff', '#cdb8ff', '#ffb3d4'].forEach((col, i, a) => fill.addColorStop(i / (a.length - 1), col));
    } else {
      fill = g.createLinearGradient(-R, -R, R, R);
      ['#ffb3d4', '#ffe68a', '#a6edcf', '#a9d3ff', '#cdb8ff'].forEach((col, i, a) => fill.addColorStop(i / (a.length - 1), col));
    }
  } else {
    fill = g.createRadialGradient(-R * 0.35, -R * 0.45, R * 0.08, 0, 0, R * 1.2);
    fill.addColorStop(0, T.colors[0]);
    fill.addColorStop(0.55, T.colors[1]);
    fill.addColorStop(1, T.colors[2]);
  }
  bodyPath(g, T.shape, R); g.fillStyle = fill; g.fill();
  if (key === 'rainbow') {
    const soft = g.createRadialGradient(-R * 0.2, -R * 0.25, 0, 0, 0, R);
    soft.addColorStop(0, 'rgba(255,255,255,0.85)'); soft.addColorStop(0.6, 'rgba(255,255,255,0.25)'); soft.addColorStop(1, 'rgba(255,255,255,0)');
    bodyPath(g, T.shape, R); g.fillStyle = soft; g.fill();
  }
  // inner shade at the bottom for a jelly-like volume
  g.save();
  bodyPath(g, T.shape, R); g.clip();
  const shade = g.createLinearGradient(0, R * 0.2, 0, R * 1.1);
  shade.addColorStop(0, 'rgba(60,30,110,0)'); shade.addColorStop(1, 'rgba(60,30,110,0.14)');
  g.fillStyle = shade; g.fillRect(-R * 1.3, -R * 1.3, R * 2.6, R * 2.6);
  g.restore();

  // glossy highlight
  g.save();
  g.fillStyle = 'rgba(255,255,255,0.72)';
  g.beginPath(); g.ellipse(-R * 0.34, -R * 0.44, R * 0.28, R * 0.14, -0.55, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.beginPath(); g.arc(-R * 0.06, -R * 0.58, R * 0.06, 0, Math.PI * 2); g.fill();
  g.restore();

  drawFace(g, R, T.kind === 'regular' ? T.shape : T.kind);

  // little note emblem for regular friends
  if (T.kind === 'regular' || T.kind === 'jelly') {
    g.font = `700 ${R * 0.42}px Fredoka, Nunito, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.strokeStyle = T.accent; g.lineWidth = 3;
    g.strokeText('♪', R * 0.62, -R * 0.66);
    g.fillText('♪', R * 0.62, -R * 0.66);
  }
  if (T.kind === 'golden' || T.kind === 'rainbow') {
    g.fillStyle = '#fff';
    sparkleShape(g, R * 0.85, -R * 0.8, R * 0.18);
    sparkleShape(g, -R * 0.95, R * 0.35, R * 0.12);
    sparkleShape(g, R * 0.7, R * 0.85, R * 0.1);
  }
  return c;
}

function makeCloudSprite() {
  const w = 280, h = 150;
  const [c, g] = makeCanvas(w, h);
  g.translate(w / 2, h / 2 + 10);
  const puffs = [[-70, 10, 44], [-20, -18, 58], [40, -6, 50], [80, 18, 36], [-100, 26, 28]];
  g.save();
  g.shadowColor = 'rgba(120, 90, 200, 0.12)'; g.shadowBlur = 18; g.shadowOffsetY = 8;
  g.fillStyle = '#fff';
  g.beginPath();
  for (const [x, y, r] of puffs) { g.moveTo(x + r, y); g.arc(x, y, r, 0, Math.PI * 2); }
  g.roundRect ? g.roundRect(-118, 10, 236, 44, 22) : g.rect(-118, 10, 236, 44);
  g.fill();
  g.restore();
  const shade = g.createLinearGradient(0, -60, 0, 56);
  shade.addColorStop(0, 'rgba(255,255,255,0)'); shade.addColorStop(1, 'rgba(205,184,255,0.35)');
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = shade; g.fillRect(-140, -80, 280, 150);
  return c;
}

function makeSparkleSprite(color) {
  const s = 32;
  const [c, g] = makeCanvas(s, s);
  g.translate(s / 2, s / 2);
  g.shadowColor = color; g.shadowBlur = 8;
  g.fillStyle = color;
  sparkleShape(g, 0, 0, 11);
  g.shadowBlur = 0; g.fillStyle = 'rgba(255,255,255,0.9)';
  sparkleShape(g, 0, 0, 4);
  return c;
}

function makeBubbleSprite() {
  const s = 64;
  const [c, g] = makeCanvas(s, s);
  g.translate(s / 2, s / 2);
  const r = 16;
  g.shadowColor = 'rgba(255, 220, 255, 0.95)'; g.shadowBlur = 14;
  const grad = g.createRadialGradient(-r * 0.35, -r * 0.4, 1, 0, 0, r);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,240,250,0.55)');
  grad.addColorStop(0.85, 'rgba(205,184,255,0.7)');
  grad.addColorStop(1, 'rgba(255,255,255,0.95)');
  g.fillStyle = grad;
  g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
  g.shadowBlur = 0;
  g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = 2;
  g.stroke();
  g.fillStyle = '#fff';
  g.beginPath(); g.ellipse(-r * 0.38, -r * 0.42, r * 0.28, r * 0.16, -0.6, 0, Math.PI * 2); g.fill();
  return c;
}

export function buildSprites() {
  for (const key of Object.keys(TARGET_TYPES)) sprites.targets[key] = makeTargetSprite(key);
  sprites.sparkles = SPARKLE_COLORS.map(makeSparkleSprite);
  sprites.cloud = makeCloudSprite();
  sprites.bubble = makeBubbleSprite();
}

/** Draw a target sprite (radius r) at the current origin of `ctx`. */
export function drawTargetSprite(ctx, key, r) {
  const img = sprites.targets[key];
  const size = (img.width / SCALE) * (r / SPRITE_R);
  ctx.drawImage(img, -size / 2, -size / 2, size, size);
}
export const SPRITE_SCALE = SCALE;
