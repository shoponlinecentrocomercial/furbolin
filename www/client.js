'use strict';
// Cliente completo del Furbolín: estado, modos (1P/local/online), render
// pixel-retro cenital, IA, red con predicción, efectos y audio.
// Classic script (sin módulos): los tests de Playwright acceden a los
// let/const de nivel superior con page.evaluate directamente.

// ---------------------------------------------------------------- constantes

// Resolución "retro" interna. Todo el juego se dibuja en un canvas offscreen
// de 384 px de ancho y se escala ×3 al canvas visible con el suavizado
// desactivado: el pixelado viene de aquí, no de ningún asset.
// La ALTURA es dinámica (patrón del pingpong): 216 en horizontal y más alta
// en vertical, para que en un móvil en retrato la mesa llene la pantalla.
const LW = 384, SCALE = 3;
let LH = 216;
const CANVAS_W = LW * SCALE;
let CANVAS_H = LH * SCALE;

// Transformación mundo→pantalla de la vista cenital (sin cámara 3D: aquí no
// hay project() como en el pingpong, solo escala + rotación por orientación).
// En horizontal la mesa se tumba (eje largo en x de pantalla, portería del
// asiento 0 a la izquierda); en vertical queda de pie (asiento 0 abajo).
let HORIZONTAL = true;
let TS = 0.26;          // escala mundo→px del lowres
let TCX = LW / 2, TCY = LH / 2;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------------------------------------------------------------- elementos

const $ = id => document.getElementById(id);
const canvas = $('screen');
const ctx = canvas.getContext('2d');
const low = document.createElement('canvas');
const lctx = low.getContext('2d');

const DPR = Math.min(2, window.devicePixelRatio || 1);

// Recalcula la altura interna según la orientación. Cambiar los atributos del
// canvas resetea su contexto, así que el setTransform/imageSmoothing se
// re-aplican aquí — es el ÚNICO sitio donde se tocan (regla heredada del
// pingpong). También recalcula la transformación de la mesa y, a diferencia
// del pingpong, RECONSTRUYE los sprites: su escala depende de la orientación.
function layout() {
  const portrait = window.innerHeight > window.innerWidth * 1.15;
  const target = portrait
    ? Math.max(300, Math.min(720, Math.round(LW * (window.innerHeight - 160) / Math.max(300, window.innerWidth))))
    : 216;
  if (target === LH && canvas.width > 0 && low.width === LW) return;
  LH = target;
  CANVAS_H = LH * SCALE;
  low.width = LW;
  low.height = LH;
  canvas.width = CANVAS_W * DPR;
  canvas.height = CANVAS_H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.imageSmoothingEnabled = false;
  HORIZONTAL = LH === 216;
  if (HORIZONTAL) {
    TS = Math.min((LW - 56) / Physics.L, (LH - 44) / Physics.W);
    TCX = LW / 2; TCY = LH / 2 + 6;
  } else {
    TS = Math.min((LW - 28) / Physics.W, (LH - 120) / Physics.L);
    TCX = LW / 2; TCY = LH / 2 + 10;
  }
  if (state) rebuildSprites();
}

// mundo (x lateral, y profundidad; asiento 0 defiende y<0) → píxel del lowres
function worldToScreen(wx, wy) {
  if (viewFlip) { wx = -wx; wy = -wy; }
  if (HORIZONTAL) return { x: TCX + wy * TS, y: TCY + wx * TS };
  return { x: TCX + wx * TS, y: TCY - wy * TS };
}

// hacia dónde ataca un asiento EN PANTALLA (para orientar los sprites)
function screenDirOfAttack(seat) {
  let d = seat === 0 ? 1 : -1;
  if (viewFlip) d = -d;
  return HORIZONTAL ? (d > 0 ? 'right' : 'left') : (d > 0 ? 'up' : 'down');
}

// ---------------------------------------------------------------- estado

let mode = null;             // null | '1p' | 'local' | 'online'
let state = null;            // estado de Physics
let sources = [null, null];  // fuentes de control por asiento
let mySeat = 0;
let viewFlip = false;        // asiento 1 online ve la mesa girada
let names = ['—', '—'];
let cosmetics = [null, null]; // {team, ball, table} por asiento
let ws = null;
let roomCode = null;
let aiLevel = null;

let betweenT = 0;            // pausa tras un gol (offline la controla el cliente)
let pendingScorer = null;
let serveReadyAt = 0;        // online: momento en que el server acepta el saque
let lastRodSend = 0;
let lastSentOff = null;

let myTeam = 0, myBall = 0, myTable = 0;

let effects = [];
let shakeT = 0, shakeMag = 0;
let crowdT = 0;
let kickAnimT = [-9, -9];    // tiempo del último chut de cada asiento (pose)
let nowT = 0;                // reloj del juego en segundos

function addEffect(fx) { fx.t = 0; effects.push(fx); }
function triggerShake(dur, mag) { shakeT = dur; shakeMag = mag; }

// ---------------------------------------------------------------- fuente pixel 3×5

const FONT = {
  A: ['010','101','111','101','101'], B: ['110','101','110','101','110'],
  C: ['011','100','100','100','011'], D: ['110','101','101','101','110'],
  E: ['111','100','110','100','111'], F: ['111','100','110','100','100'],
  G: ['011','100','101','101','011'], H: ['101','101','111','101','101'],
  I: ['111','010','010','010','111'], J: ['001','001','001','101','010'],
  K: ['101','110','100','110','101'], L: ['100','100','100','100','111'],
  M: ['101','111','101','101','101'], N: ['110','101','101','101','101'],
  O: ['010','101','101','101','010'], P: ['110','101','110','100','100'],
  Q: ['010','101','101','010','001'], R: ['110','101','110','110','101'],
  S: ['011','100','010','001','110'], T: ['111','010','010','010','010'],
  U: ['101','101','101','101','111'], V: ['101','101','101','101','010'],
  W: ['101','101','111','111','101'], X: ['101','101','010','101','101'],
  Y: ['101','101','010','010','010'], Z: ['111','001','010','100','111'],
  0: ['111','101','101','101','111'], 1: ['010','110','010','010','111'],
  2: ['111','001','111','100','111'], 3: ['111','001','011','001','111'],
  4: ['101','101','111','001','001'], 5: ['111','100','111','001','111'],
  6: ['111','100','111','101','111'], 7: ['111','001','001','010','010'],
  8: ['111','101','111','101','111'], 9: ['111','101','111','001','111'],
  '!': ['010','010','010','000','010'], '¡': ['010','000','010','010','010'],
  '-': ['000','000','111','000','000'], '.': ['000','000','000','000','010'],
  ' ': ['000','000','000','000','000'],
};

function drawPixelText(c, text, x, y, scale, color) {
  c.fillStyle = color;
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const g = FONT[ch] || FONT[' '];
    for (let r = 0; r < 5; r++) {
      for (let col = 0; col < 3; col++) {
        if (g[r][col] === '1') c.fillRect(cx + col * scale, y + r * scale, scale, scale);
      }
    }
    cx += 4 * scale;
  }
}
function pixelTextWidth(text, scale) { return text.length * 4 * scale - scale; }

// ---------------------------------------------------------------- utilidades de dibujo

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = s => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * f)));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

// Disco pixelado por filas (sin arc(): un path metería antialiasing y
// rompería el pixel — mismo motivo que las scanlines de la mesa del pingpong)
function fillPixelCircle(g, cx, cy, r, color) {
  g.fillStyle = color;
  for (let dy = -r; dy <= r; dy++) {
    const hw = Math.floor(Math.sqrt(r * r - dy * dy));
    g.fillRect(cx - hw, cy + dy, hw * 2 + 1, 1);
  }
}

// ---------------------------------------------------------------- cosméticos → defs

function tableDef() {
  // La mesa la decide el asiento 0 (creador de la sala) — misma regla que el
  // paño del billar y la mesa del pingpong.
  const t = cosmetics[0] ? cosmetics[0].table : 0;
  return Cosmetics.TABLES[t];
}

function ballDef() {
  // La bola es un objeto único de la mesa: también la decide el asiento 0.
  const b = cosmetics[0] ? cosmetics[0].ball : 0;
  return Cosmetics.BALLS[b];
}

function teamDefOf(seat) {
  const cos = cosmetics[seat] || { team: seat };
  let idx = cos.team;
  // Si ambos eligieron el mismo equipo, el asiento 1 viste el siguiente de la
  // lista — regla SOLO de render (el estado no cambia), para distinguirse.
  if (seat === 1 && cosmetics[0] && cosmetics[0].team === idx) idx = (idx + 1) % Cosmetics.TEAMS.length;
  return Cosmetics.TEAMS[idx];
}

// ---------------------------------------------------------------- sprites procedurales

// Figura vista desde arriba: hombros (camiseta) + cabeza + pelo, con el pie
// asomando al frente en la pose de chut. Se dibuja "mirando arriba" y se rota
// en múltiplos de 90° (los fillRect siguen cayendo en píxeles exactos).
// Se reconstruyen al empezar partida Y al cambiar layout() (la escala TS
// depende de la orientación — divergencia deliberada respecto al pingpong).
function buildFigureSprites(team, facing) {
  const d = Math.max(7, Math.round(Physics.FIG_R * 2 * TS));
  const pad = Math.max(3, Math.round(d * 0.3));
  const size = d + pad * 2;
  const rot = { up: 0, right: Math.PI / 2, down: Math.PI, left: -Math.PI / 2 }[facing];
  const mk = (kick) => {
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const g = c.getContext('2d');
    g.translate(size / 2, size / 2);
    g.rotate(rot);
    const P = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
    const r = Math.floor(d / 2);
    const shW = Math.max(2, Math.round(r * 0.55)); // media altura de los hombros
    // pie que asoma al frente en el chut
    if (kick) P(-Math.max(1, Math.round(r * 0.25)), -r - pad + 1, Math.max(2, Math.round(r * 0.5)), pad, '#181820');
    // hombros / camiseta
    P(-r, -shW, d, shW * 2, team.shirt);
    P(-r + 1, -shW, d - 2, 1, shade(team.shirt, 1.3));
    P(-r + 1, shW - 1, d - 2, 1, shade(team.shirt, 0.65));
    P(-r, -shW, 1, 1, shade(team.shirt, 0.8)); P(r - 1, -shW, 1, 1, shade(team.shirt, 0.8));
    // cabeza + pelo (el pelo queda "detrás": lado contrario al ataque)
    const hr = Math.max(2, Math.round(r * 0.55));
    fillPixelCircle(g, 0, 0, hr, team.skin);
    P(-hr, Math.max(1, Math.round(hr * 0.3)), hr * 2 + 1, Math.max(1, Math.round(hr * 0.6)), '#2a1a10');
    return c;
  };
  return { idle: mk(false), kick: mk(true) };
}

// Escudo/camiseta para avatares del HUD y el picker de equipos.
function drawTeamBadge(g, team, size) {
  const u = size / 12;
  const px = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x * u, y * u, w * u, h * u); };
  px(2, 5, 8, 5, team.shirt);
  px(2, 5, 8, 1, shade(team.shirt, 1.3));
  px(1, 5, 1, 3, team.shirt); px(10, 5, 1, 3, team.shirt); // mangas
  px(3, 10, 6, 2, team.shorts);
  px(4, 1, 4, 4, team.skin);
  px(4, 1, 4, 1, '#2a1a10');
}

let figSprites = [null, null]; // {idle, kick} por asiento

function rebuildSprites() {
  figSprites = [0, 1].map(seat => buildFigureSprites(teamDefOf(seat), screenDirOfAttack(seat)));
}

// ---------------------------------------------------------------- escena estática

// El bar de fondo y la mesa (marco, campo, líneas, porterías) se pre-renderizan
// en canvases: regenerarlos con cientos de fillRect por frame hundía los
// móviles en billar y pingpong. Los parroquianos tienen una "ola" de dos
// frames → dos variantes de fondo. La clave (LH + mesa de cosmetics[0])
// invalida la caché sola al cambiar layout() o los cosméticos.
let sceneCache = null; // { LH, T, bg: [canvas, canvas], table: canvas }

function sceneCanvases() {
  const T = tableDef();
  if (sceneCache && sceneCache.LH === LH && sceneCache.T === T) return sceneCache;
  const mk = () => { const c = document.createElement('canvas'); c.width = LW; c.height = LH; return c; };
  sceneCache = { LH, T, bg: [mk(), mk()], table: mk() };
  for (let wave = 0; wave < 2; wave++) drawBarScene(sceneCache.bg[wave].getContext('2d'), T, wave);
  drawTableCanvas(sceneCache.table.getContext('2d'), T);
  return sceneCache;
}

function drawBarScene(g, T, wave) {
  // suelo de baldosas del bar
  g.fillStyle = T.floor; g.fillRect(0, 0, LW, LH);
  g.fillStyle = shade(T.floor, 0.88);
  for (let ty = 0; ty * 16 < LH; ty++) {
    for (let tx = 0; tx * 16 < LW; tx++) {
      if ((tx + ty) % 2 === 0) g.fillRect(tx * 16, ty * 16, 16, 16);
    }
  }
  if (HORIZONTAL || LH < 420) return; // en apaisado no hay sitio para ambientación

  // --- pared y barra del bar en el hueco superior del layout vertical
  const tableTop = TCY - (Physics.L / 2) * TS;
  const wallH = Math.max(44, Math.round(tableTop) - 26);
  g.fillStyle = T.wall; g.fillRect(0, 0, LW, wallH);
  g.fillStyle = shade(T.wall, 0.75); g.fillRect(0, wallH - 2, LW, 2);
  // estante con botellas
  const cols = ['#3db554', '#d43d3d', '#f0c541', '#3d7ad4', '#c9a06a', '#8a2438'];
  g.fillStyle = shade(T.wall, 0.55); g.fillRect(6, 10, LW - 12, 2);
  for (let i = 0; i < 24; i++) {
    const bx = 12 + i * 15;
    if (bx > LW - 18) break;
    g.fillStyle = cols[i % cols.length];
    g.fillRect(bx, 3, 4, 7); g.fillRect(bx + 1, 1, 2, 2);
  }
  // jamón colgado a la izquierda
  g.fillStyle = '#4a2c18'; g.fillRect(22, 12, 1, 4);
  g.fillStyle = '#8a3a30'; g.fillRect(19, 16, 7, 12); g.fillRect(20, 28, 5, 3);
  g.fillStyle = '#a85a48'; g.fillRect(20, 17, 2, 9);
  g.fillStyle = '#e8d5b5'; g.fillRect(21, 31, 3, 3);
  // cartel del bar
  const sign = 'BAR EL FURBO';
  const sw = pixelTextWidth(sign, 1);
  g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(LW - sw - 18, 14, sw + 10, 11);
  drawPixelText(g, sign, LW - sw - 13, 17, 1, '#f0c541');
  // mostrador con parroquianos acodados (cabezas con "ola" de 2 frames)
  const counterY = wallH - 12;
  g.fillStyle = '#3a2412'; g.fillRect(0, counterY + 6, LW, 6);
  g.fillStyle = '#5a3a20'; g.fillRect(0, counterY, LW, 7);
  g.fillStyle = '#7a5230'; g.fillRect(0, counterY, LW, 2);
  const shirts = ['#d43d3d', '#3d7ad4', '#3db554', '#8a8a95', '#e8a020'];
  const skins = ['#e8b88a', '#c98d5e', '#8a5a3a'];
  for (let i = 0; i < 5; i++) {
    const px = 34 + i * 76 + (i % 2) * 9;
    if (px > LW - 16) break;
    const bob = (i + wave) % 2;
    g.fillStyle = shirts[i % shirts.length];
    g.fillRect(px - 6, counterY - 12 + bob, 13, 12);
    g.fillStyle = skins[i % 3];
    g.fillRect(px - 3, counterY - 20 + bob, 8, 9);
    g.fillStyle = '#2a1a10';
    g.fillRect(px - 3, counterY - 21 + bob, 8, 3);
    // caña en la mano, sobre el mostrador
    g.fillStyle = '#f0c541'; g.fillRect(px + 9, counterY - 5 + bob, 3, 5);
    g.fillStyle = '#fff'; g.fillRect(px + 9, counterY - 6 + bob, 3, 1);
  }
  // marca pintada en el suelo bajo la mesa (relleno del hueco inferior)
  const tableBot = TCY + (Physics.L / 2) * TS;
  const txt = 'FURBOLIN';
  const ty2 = Math.round((tableBot + LH) / 2) + 6;
  if (LH - tableBot > 46) {
    const tw2 = pixelTextWidth(txt, 3);
    drawPixelText(g, txt, LW / 2 - tw2 / 2, ty2, 3, shade(T.floor, 0.72));
  }
}

function drawTableCanvas(g, T) {
  const a = worldToScreen(-Physics.HALF_W, -Physics.HALF_L);
  const b = worldToScreen(Physics.HALF_W, Physics.HALF_L);
  const fx = Math.round(Math.min(a.x, b.x)), fy = Math.round(Math.min(a.y, b.y));
  const fw = Math.round(Math.abs(a.x - b.x)), fh = Math.round(Math.abs(a.y - b.y));
  const FR = Math.max(5, Math.round(32 * TS)); // grosor del marco de madera

  // sombra de la mesa sobre el suelo del bar
  g.fillStyle = 'rgba(0,0,0,.35)';
  g.fillRect(fx - FR + 3, fy - FR + 5, fw + FR * 2, fh + FR * 2);
  // marco de madera
  g.fillStyle = T.frame;
  g.fillRect(fx - FR, fy - FR, fw + FR * 2, fh + FR * 2);
  g.fillStyle = shade(T.frame, 1.25);
  g.fillRect(fx - FR, fy - FR, fw + FR * 2, 2);
  g.fillStyle = shade(T.frame, 0.65);
  g.fillRect(fx - FR, fy + fh + FR - 2, fw + FR * 2, 2);
  // campo
  g.fillStyle = T.field;
  g.fillRect(fx, fy, fw, fh);
  // sombra interior del marco
  g.fillStyle = 'rgba(0,0,0,.18)';
  g.fillRect(fx, fy, fw, 2); g.fillRect(fx, fy + fh - 2, fw, 2);
  g.fillRect(fx, fy, 2, fh); g.fillRect(fx + fw - 2, fy, 2, fh);

  // círculo central (anillo pixelado: donut de dos discos)
  const cc = worldToScreen(0, 0);
  const cr = Math.max(6, Math.round(85 * TS));
  fillPixelCircle(g, Math.round(cc.x), Math.round(cc.y), cr, T.line);
  fillPixelCircle(g, Math.round(cc.x), Math.round(cc.y), cr - 1, T.field);
  // línea de medio campo + punto central
  g.fillStyle = T.line;
  if (HORIZONTAL) g.fillRect(Math.round(cc.x), fy, 1, fh);
  else g.fillRect(fx, Math.round(cc.y), fw, 1);
  g.fillRect(Math.round(cc.x) - 1, Math.round(cc.y) - 1, 2, 2);

  // áreas de portería (rectángulo de 3 lados frente a cada boca)
  for (const end of [-1, 1]) {
    const a1 = worldToScreen(-170, end * (Physics.HALF_L - 130));
    const a2 = worldToScreen(170, end * Physics.HALF_L);
    const ax = Math.round(Math.min(a1.x, a2.x)), ay = Math.round(Math.min(a1.y, a2.y));
    const aw = Math.round(Math.abs(a1.x - a2.x)), ah = Math.round(Math.abs(a1.y - a2.y));
    g.fillStyle = T.line;
    g.fillRect(ax, ay, aw, 1); g.fillRect(ax, ay + ah - 1, aw, 1);
    g.fillRect(ax, ay, 1, ah); g.fillRect(ax + aw - 1, ay, 1, ah);
  }

  // porterías: hueco oscuro en la banda corta con redecilla (patrón tronera)
  for (const end of [-1, 1]) {
    const g1 = worldToScreen(-Physics.GOAL_W / 2, end * Physics.HALF_L);
    const g2 = worldToScreen(Physics.GOAL_W / 2, end * Physics.HALF_L);
    const gc = worldToScreen(0, end * Physics.HALF_L);
    if (HORIZONTAL) {
      const gy = Math.round(Math.min(g1.y, g2.y)), gh = Math.round(Math.abs(g1.y - g2.y));
      const outw = gc.x > TCX ? 1 : -1;
      const gx = Math.round(gc.x) + (outw > 0 ? 0 : -FR);
      g.fillStyle = '#14100c'; g.fillRect(gx, gy, FR, gh);
      g.fillStyle = 'rgba(255,255,255,.22)';
      for (let yy = gy + 2; yy < gy + gh - 1; yy += 3) g.fillRect(gx + 1, yy, FR - 2, 1);
      g.fillStyle = T.line; g.fillRect(Math.round(gc.x) + (outw > 0 ? -1 : 0), gy, 1, gh);
    } else {
      const gx = Math.round(Math.min(g1.x, g2.x)), gw = Math.round(Math.abs(g1.x - g2.x));
      const outw = gc.y > TCY ? 1 : -1;
      const gy = Math.round(gc.y) + (outw > 0 ? 0 : -FR);
      g.fillStyle = '#14100c'; g.fillRect(gx, gy, gw, FR);
      g.fillStyle = 'rgba(255,255,255,.22)';
      for (let xx = gx + 2; xx < gx + gw - 1; xx += 3) g.fillRect(xx, gy + 1, 1, FR - 2);
      g.fillStyle = T.line; g.fillRect(gx, Math.round(gc.y) + (outw > 0 ? -1 : 0), gw, 1);
    }
  }
}

// ---------------------------------------------------------------- dibujo por frame

// Las barras se dibujan POR FRAME (no en la caché) a propósito: así quedan por
// ENCIMA de la bola, que rueda por debajo de ellas. Son ~30 fillRect, coste
// despreciable. Las empuñaduras se desplazan con el offset de su asiento.
function drawBars(g) {
  const ext = Math.max(4, Math.round(46 * TS));
  for (const rod of Physics.RODS) {
    const a = worldToScreen(-Physics.HALF_W, rod.y);
    const b = worldToScreen(Physics.HALF_W, rod.y);
    if (HORIZONTAL) {
      const x = Math.round(a.x) - 1;
      const y1 = Math.round(Math.min(a.y, b.y)) - ext, y2 = Math.round(Math.max(a.y, b.y)) + ext;
      g.fillStyle = '#7a828c'; g.fillRect(x, y1, 2, y2 - y1);
      g.fillStyle = '#d4dae0'; g.fillRect(x, y1, 1, y2 - y1);
    } else {
      const y = Math.round(a.y) - 1;
      const x1 = Math.round(Math.min(a.x, b.x)) - ext, x2 = Math.round(Math.max(a.x, b.x)) + ext;
      g.fillStyle = '#7a828c'; g.fillRect(x1, y, x2 - x1, 2);
      g.fillStyle = '#d4dae0'; g.fillRect(x1, y, x2 - x1, 1);
    }
    // empuñadura en el lado del dueño, deslizando con la barra
    if (state) {
      const off = clamp(state.rods[rod.seat].off, -rod.travel, rod.travel);
      const side = rod.seat === 0 ? -1 : 1;
      const hp = worldToScreen(side * (Physics.HALF_W + 60) + off, rod.y);
      const hw = Math.max(3, Math.round(26 * TS)), hh = Math.max(2, Math.round(14 * TS));
      g.fillStyle = '#181820';
      if (HORIZONTAL) g.fillRect(Math.round(hp.x) - hh, Math.round(hp.y) - hw, hh * 2, hw * 2);
      else g.fillRect(Math.round(hp.x) - hw, Math.round(hp.y) - hh, hw * 2, hh * 2);
    }
  }
}

function draw() {
  const scene = sceneCanvases();
  const wave = Math.floor(crowdT * 1.6) % 2;
  const g = lctx;
  // El fondo es opaco a pantalla completa: este drawImage hace también de clear.
  g.drawImage(scene.bg[wave], 0, 0);
  g.drawImage(scene.table, 0, 0);

  if (!state) { blit(); return; }

  // --- bola (debajo de barras y figuras: rueda por el suelo del campo)
  const b = state.ball;
  if (state.phase !== 'over') {
    const p = worldToScreen(b.x, b.y);
    const r = Math.max(2, Math.round(Physics.BALL_R * TS));
    const BD = ballDef();
    // estela del súper golpe: discos fantasma hacia atrás. Sin estado — solo
    // depende de la velocidad actual (el chut normal cae por debajo de 1100
    // enseguida; el súper la mantiene un buen trecho)
    const bsp = Math.hypot(b.vx, b.vy);
    if (bsp > 1100) {
      for (let i = 1; i <= 3; i++) {
        const gp = worldToScreen(b.x - b.vx * 0.014 * i, b.y - b.vy * 0.014 * i);
        g.globalAlpha = 0.35 - i * 0.09;
        fillPixelCircle(g, Math.round(gp.x), Math.round(gp.y), Math.max(1, r - i), '#ffe25a');
      }
      g.globalAlpha = 1;
    }
    g.fillStyle = 'rgba(0,0,0,.28)';
    fillPixelCircle(g, Math.round(p.x) + 1, Math.round(p.y) + 1, r, g.fillStyle);
    fillPixelCircle(g, Math.round(p.x), Math.round(p.y), r, BD.color);
    g.fillStyle = BD.dark;
    g.fillRect(Math.round(p.x) - Math.floor(r / 2), Math.round(p.y) + r - 1, r, 1);
    g.fillStyle = '#ffffff';
    g.fillRect(Math.round(p.x) - Math.floor(r / 2), Math.round(p.y) - Math.floor(r / 2) - 1, Math.max(1, Math.floor(r / 2)), 1);
  }

  // --- barras + figuras
  drawBars(g);
  for (let seat = 0; seat < 2; seat++) {
    if (!figSprites[seat]) continue;
    const spr = (nowT - kickAnimT[seat] < 0.18) ? figSprites[seat].kick : figSprites[seat].idle;
    for (const f of Physics.figures(state, seat)) {
      const p = worldToScreen(f.x, f.y);
      g.drawImage(spr, Math.round(p.x - spr.width / 2), Math.round(p.y - spr.height / 2));
    }
  }

  // --- marcador pixel + indicador de saque
  const sc = viewFlip ? [state.scores[1], state.scores[0]] : state.scores;
  const scoreTxt = `${sc[0]} - ${sc[1]}`;
  const tw = pixelTextWidth(scoreTxt, 2);
  g.fillStyle = 'rgba(10,14,20,.65)';
  g.fillRect(LW / 2 - tw / 2 - 5, 3, tw + 10, 15);
  drawPixelText(g, scoreTxt, LW / 2 - tw / 2, 6, 2, '#f8f8f0');
  if (state.phase === 'kickoff') {
    // triángulo junto al marcador, del lado del que saca (en coords de vista)
    const leftServes = state.server === (viewFlip ? 1 : 0);
    const sx = leftServes ? LW / 2 - tw / 2 - 12 : LW / 2 + tw / 2 + 6;
    g.fillStyle = '#f0c541';
    g.fillRect(sx + 2, 7, 2, 6); g.fillRect(sx, 9, 6, 2);
  }

  // --- barras de súper golpe ⚡, una por jugador, flanqueando el marcador
  // (en coords de vista, como los scores; más allá del triángulo de saque)
  const meterLeftSeat = viewFlip ? 1 : 0;
  drawSuperMeter(g, LW / 2 - tw / 2 - 18 - 33, 6, meterLeftSeat);
  drawSuperMeter(g, LW / 2 + tw / 2 + 18, 6, 1 - meterLeftSeat);

  drawEffects(g);
  blit();
}

// Indicador de súper golpe de un asiento: rayo pixel + 2 segmentos que se
// rellenan con state.power. Parpadea mientras ese asiento mantiene la
// pulsación con carga disponible (superHold lo alimenta pointerSource).
const BOLT = ['011', '010', '111', '010', '110'];
function drawSuperMeter(g, x, y, seat) {
  const power = state.power[seat];
  const blink = superHold[seat] > 0.2 && power >= 1 && Math.floor(nowT * 8) % 2 === 0;
  // fondo OPACO: en apaisado las empuñaduras de las barras superiores pasan
  // justo por detrás y con transparencia se colaban en el indicador
  g.fillStyle = '#10141a';
  g.fillRect(x - 2, y - 2, 37, 12);
  g.fillStyle = power >= 1 ? (blink ? '#ffffff' : '#f0c541') : '#5a5648';
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 3; c++) {
      if (BOLT[r][c] === '1') g.fillRect(x + c, y + 1 + r, 1, 1);
    }
  }
  for (let i = 0; i < Physics.SUPER_CHARGES; i++) {
    const sx = x + 6 + i * 14;
    g.fillStyle = '#2a3038';
    g.fillRect(sx, y + 1, 13, 5);
    const f = clamp(power - i, 0, 1);
    if (f > 0) {
      g.fillStyle = f >= 1 ? (blink ? '#ffffff' : '#f0c541') : '#9a8030';
      g.fillRect(sx, y + 1, Math.round(13 * f), 5);
    }
  }
}

// Copia el lowres al canvas visible a factor entero (el shake se aplica aquí,
// en píxeles enteros del lowres, para no romper la retícula).
function blit() {
  let ox = 0, oy = 0;
  if (shakeT > 0) {
    ox = Math.round((Math.random() * 2 - 1) * shakeMag);
    oy = Math.round((Math.random() * 2 - 1) * shakeMag);
  }
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.drawImage(low, ox * SCALE, oy * SCALE, CANVAS_W, CANVAS_H);
}

// ---------------------------------------------------------------- efectos

function drawEffects(g) {
  for (const fx of effects) {
    const k = fx.t / fx.dur;
    if (fx.type === 'flash') {
      const r = Math.round(2 + k * 8);
      g.globalAlpha = 1 - k;
      g.fillStyle = fx.color || '#fff';
      g.fillRect(fx.x - r, fx.y - 1, r * 2, 2);
      g.fillRect(fx.x - 1, fx.y - r, 2, r * 2);
      g.globalAlpha = 1;
    } else if (fx.type === 'puff') {
      if (!fx.parts) {
        fx.parts = []; // geometría aleatoria cacheada la primera vez (no parpadea)
        for (let i = 0; i < 5; i++) {
          fx.parts.push({ a: (i / 5) * Math.PI * 2 + Math.random(), v: 6 + Math.random() * 8 });
        }
      }
      g.globalAlpha = 1 - k;
      g.fillStyle = '#e8e8f0';
      for (const p of fx.parts) {
        g.fillRect(Math.round(fx.x + Math.cos(p.a) * p.v * k), Math.round(fx.y + Math.sin(p.a) * p.v * k), 1, 1);
      }
      g.globalAlpha = 1;
    } else if (fx.type === 'banner') {
      const scale = 3;
      const by = Math.round(LH * 0.38);
      const w = pixelTextWidth(fx.text, scale);
      const blink = fx.t < 0.25 && Math.floor(fx.t * 20) % 2 === 0;
      g.fillStyle = 'rgba(10,14,20,.7)';
      g.fillRect(LW / 2 - w / 2 - 8, by, w + 16, 27);
      drawPixelText(g, fx.text, LW / 2 - w / 2, by + 6, scale, blink ? '#fff' : (fx.color || '#f0c541'));
      if (fx.sub) {
        const sw = pixelTextWidth(fx.sub, 1);
        drawPixelText(g, fx.sub, LW / 2 - sw / 2, by + 29, 1, '#c9d4e0');
      }
    } else if (fx.type === 'confetti') {
      if (!fx.parts) {
        fx.parts = [];
        const cols = ['#f0c541', '#d43d3d', '#3d7ad4', '#3db554', '#e060a8'];
        for (let i = 0; i < 40; i++) {
          fx.parts.push({ x: Math.random() * LW, v: 20 + Math.random() * 40, ph: Math.random() * 6, col: cols[i % cols.length] });
        }
      }
      for (const p of fx.parts) {
        const y = (p.v * fx.t + p.ph * 20) % (LH + 10) - 5;
        g.fillStyle = p.col;
        g.fillRect(Math.round(p.x + Math.sin(fx.t * 3 + p.ph) * 4), Math.round(y), 2, 2);
      }
    }
  }
}

// ---------------------------------------------------------------- audio

// WebAudio 100% procedural, sin ficheros (patrón del billar/pingpong).
let audioCtx = null;
function initAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* sin audio */ }
  }
}

function playSound(kind, val) {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const t0 = audioCtx.currentTime;
  const out = audioCtx.destination;
  const vol = Math.min(1, (val || 300) / 700);

  if (kind === 'kick' || kind === 'serve') {
    // golpe seco de figura: ruido corto filtrado grave
    const dur = 0.07;
    const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * dur, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = audioCtx.createBufferSource(); src.buffer = buf;
    const f = audioCtx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 500 + vol * 700;
    const gn = audioCtx.createGain(); gn.gain.value = 0.35 + vol * 0.4;
    src.connect(f); f.connect(gn); gn.connect(out); src.start(t0);
  } else if (kind === 'superkick') {
    // boom grave del súper golpe: caída de seno + golpe de ruido lowpass
    const o = audioCtx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(160, t0);
    o.frequency.exponentialRampToValueAtTime(45, t0 + 0.25);
    const gn = audioCtx.createGain();
    gn.gain.setValueAtTime(0.5, t0);
    gn.gain.exponentialRampToValueAtTime(0.001, t0 + 0.28);
    o.connect(gn); gn.connect(out); o.start(t0); o.stop(t0 + 0.3);
    const dur = 0.12;
    const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * dur, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = audioCtx.createBufferSource(); src.buffer = buf;
    const f = audioCtx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 700;
    const gn2 = audioCtx.createGain(); gn2.gain.value = 0.45;
    src.connect(f); f.connect(gn2); gn2.connect(out); src.start(t0);
  } else if (kind === 'swish') {
    // patada al aire
    const o = audioCtx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(300, t0);
    o.frequency.exponentialRampToValueAtTime(150, t0 + 0.06);
    const gn = audioCtx.createGain();
    gn.gain.setValueAtTime(0.08, t0);
    gn.gain.exponentialRampToValueAtTime(0.001, t0 + 0.07);
    o.connect(gn); gn.connect(out); o.start(t0); o.stop(t0 + 0.08);
  } else if (kind === 'figure') {
    // "toc" de madera
    const o = audioCtx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(340 + vol * 160, t0);
    o.frequency.exponentialRampToValueAtTime(180, t0 + 0.05);
    const gn = audioCtx.createGain();
    gn.gain.setValueAtTime(0.2 + vol * 0.2, t0);
    gn.gain.exponentialRampToValueAtTime(0.001, t0 + 0.06);
    o.connect(gn); gn.connect(out); o.start(t0); o.stop(t0 + 0.07);
  } else if (kind === 'wall') {
    const o = audioCtx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(150, t0);
    o.frequency.exponentialRampToValueAtTime(85, t0 + 0.08);
    const gn = audioCtx.createGain();
    gn.gain.setValueAtTime(0.2 + vol * 0.15, t0);
    gn.gain.exponentialRampToValueAtTime(0.001, t0 + 0.09);
    o.connect(gn); gn.connect(out); o.start(t0); o.stop(t0 + 0.1);
  } else if (kind === 'dead') {
    // silbato de árbitro (dos pitidos)
    [0, 0.12].forEach(dl => {
      const o = audioCtx.createOscillator(); o.type = 'square';
      o.frequency.value = 2100;
      const gn = audioCtx.createGain();
      gn.gain.setValueAtTime(0.06, t0 + dl);
      gn.gain.exponentialRampToValueAtTime(0.001, t0 + dl + 0.09);
      o.connect(gn); gn.connect(out); o.start(t0 + dl); o.stop(t0 + dl + 0.1);
    });
  } else if (kind === 'goal') {
    // fanfarria + "rugido" de bar (ruido filtrado que se apaga)
    [523, 659, 784].forEach((fr, i) => {
      const o = audioCtx.createOscillator(); o.type = 'square';
      o.frequency.value = fr;
      const gn = audioCtx.createGain();
      gn.gain.setValueAtTime(0.11, t0 + i * 0.08);
      gn.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.08 + 0.22);
      o.connect(gn); gn.connect(out); o.start(t0 + i * 0.08); o.stop(t0 + i * 0.08 + 0.25);
    });
    const dur = 0.9;
    const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * dur, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 1.6);
    const src = audioCtx.createBufferSource(); src.buffer = buf;
    const f = audioCtx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
    const gn = audioCtx.createGain(); gn.gain.value = 0.18;
    src.connect(f); f.connect(gn); gn.connect(out); src.start(t0 + 0.05);
  } else if (kind === 'win') {
    [523, 659, 784, 1047].forEach((fr, i) => {
      const o = audioCtx.createOscillator(); o.type = 'triangle';
      o.frequency.value = fr;
      const gn = audioCtx.createGain();
      gn.gain.setValueAtTime(0.18, t0 + i * 0.12);
      gn.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.12 + 0.25);
      o.connect(gn); gn.connect(out); o.start(t0 + i * 0.12); o.stop(t0 + i * 0.12 + 0.3);
    });
  } else if (kind === 'lose') {
    [392, 330, 262].forEach((fr, i) => {
      const o = audioCtx.createOscillator(); o.type = 'triangle';
      o.frequency.value = fr;
      const gn = audioCtx.createGain();
      gn.gain.setValueAtTime(0.16, t0 + i * 0.15);
      gn.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.15 + 0.28);
      o.connect(gn); gn.connect(out); o.start(t0 + i * 0.15); o.stop(t0 + i * 0.15 + 0.3);
    });
  }
}

// ---------------------------------------------------------------- música chiptune

// Secuenciador WebAudio procedural (sin ficheros): melodía square con aire de
// pasodoble, bajo triangle "om-pah" y hi-hat de ruido. El botón 🔊 del HUD
// (o la tecla M) silencia SOLO la música, no los efectos.
let musicMuted = false;
let musicGain = null;
const music = { timer: null, step: 0, nextT: 0 };
const MUSIC_STEP = 60 / 112 / 2; // corcheas a 112 BPM

// notas MIDI (0 = silencio), 64 pasos = 8 compases (la menor, aire español)
const LEAD = [
  76, 0, 77, 0, 76, 0, 74, 0, 72, 0, 74, 76, 74, 72, 71, 0,
  72, 0, 74, 0, 76, 0, 77, 0, 79, 77, 76, 74, 76, 0, 0, 0,
  81, 0, 79, 0, 77, 0, 76, 0, 77, 79, 77, 76, 74, 0, 72, 0,
  71, 72, 74, 76, 77, 76, 74, 72, 76, 0, 71, 0, 69, 0, 0, 0,
];
const BASSLINE = [
  45, 0, 52, 0, 45, 0, 52, 0, 45, 0, 52, 0, 45, 0, 52, 0,
  38, 0, 45, 0, 38, 0, 45, 0, 40, 0, 47, 0, 40, 0, 47, 0,
  45, 0, 52, 0, 45, 0, 52, 0, 38, 0, 45, 0, 40, 0, 47, 0,
  45, 0, 52, 0, 40, 0, 47, 0, 45, 0, 40, 0, 45, 0, 0, 0,
];
const midi2f = n => 440 * Math.pow(2, (n - 69) / 12);

function ensureMusicGain() {
  if (!audioCtx || musicGain) return;
  musicGain = audioCtx.createGain();
  musicGain.gain.value = musicMuted ? 0 : 1;
  musicGain.connect(audioCtx.destination);
}

function musicNote(type, freq, t, dur, vol) {
  const o = audioCtx.createOscillator(); o.type = type; o.frequency.value = freq;
  const gn = audioCtx.createGain();
  gn.gain.setValueAtTime(vol, t);
  gn.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(gn); gn.connect(musicGain);
  o.start(t); o.stop(t + dur + 0.02);
}

function scheduleMusic() {
  if (!audioCtx) return;
  // planifica con ~0.35s de antelación (lookahead clásico de WebAudio)
  while (music.nextT < audioCtx.currentTime + 0.35) {
    const t = music.nextT, s = music.step;
    if (LEAD[s]) musicNote('square', midi2f(LEAD[s]), t, MUSIC_STEP * 0.9, 0.035);
    if (BASSLINE[s]) musicNote('triangle', midi2f(BASSLINE[s]), t, MUSIC_STEP * 0.95, 0.06);
    if (s % 2 === 1) { // hi-hat en contratiempos
      const buf = audioCtx.createBuffer(1, Math.floor(audioCtx.sampleRate * 0.03), audioCtx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      const src = audioCtx.createBufferSource(); src.buffer = buf;
      const f = audioCtx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 6000;
      const gn = audioCtx.createGain(); gn.gain.value = 0.045;
      src.connect(f); f.connect(gn); gn.connect(musicGain); src.start(t);
    }
    music.step = (music.step + 1) % LEAD.length;
    music.nextT += MUSIC_STEP;
  }
}

function startMusic() {
  initAudio();
  if (!audioCtx || music.timer) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  ensureMusicGain();
  music.step = 0;
  music.nextT = audioCtx.currentTime + 0.1;
  music.timer = setInterval(scheduleMusic, 150);
}

function stopMusic() {
  if (music.timer) { clearInterval(music.timer); music.timer = null; }
}

function setMusicMuted(m) {
  musicMuted = m;
  if (musicGain) musicGain.gain.value = m ? 0 : 1;
  $('musicBtn').textContent = m ? '🔇' : '🔊';
}
$('musicBtn').addEventListener('click', () => setMusicMuted(!musicMuted));

// ---------------------------------------------------------------- mandos (Gamepad API)

// Los mandos bluetooth (o USB) aparecen como gamepads normales del sistema.
// Stick o cruceta deslizan las barras (el eje depende de la orientación de la
// mesa) y A (botón 0) chuta/saca. En 2P local: mando 1 = J1, mando 2 = J2.
let gamepadSeen = false;
window.addEventListener('gamepadconnected', () => {
  gamepadSeen = true;
  initAudio();
  setStatus('🎮 Mando conectado');
});

function pollGamepad(index) {
  if (!gamepadSeen || !navigator.getGamepads) return null;
  let n = 0;
  for (const gp of navigator.getGamepads()) {
    if (!gp || !gp.connected) continue;
    if (n === index) return gp;
    n++;
  }
  return null;
}
const gpBtn = (gp, i) => !!(gp.buttons[i] && gp.buttons[i].pressed);

// ---------------------------------------------------------------- entrada

// Pointer events unificados (ratón y táctil). Cada puntero se enruta a la
// mitad de pantalla donde EMPEZÓ, para que en 2P local los dedos puedan
// cruzarse sin robarse las barras.
const pointers = new Map(); // pointerId -> {fx, fy, half, t0, sx, sy}
const keys = new Set();
// petición de acción por asiento (consumida por la fuente):
// 0 = nada · 1 = chut/saque normal · 2 = SÚPER golpe (pulsación mantenida)
let tapAction = [0, 0];
let superHold = [0, 0];         // segundos que lleva cada asiento manteniendo (para el ⚡ del HUD)
const SUPER_HOLD_MS = 600;      // pulsación quieta ≥ esto → súper al soltar

function toGame(e) {
  const r = canvas.getBoundingClientRect();
  return { fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height };
}

// 'bottom' = lado del asiento 0 en pantalla (abajo en vertical, izquierda en
// horizontal); el nombre se mantiene por simetría con el pingpong.
function pointerHalf(p) {
  return HORIZONTAL ? (p.fx < 0.5 ? 'bottom' : 'top') : (p.fy >= 0.5 ? 'bottom' : 'top');
}

canvas.addEventListener('pointerdown', e => {
  e.preventDefault();
  initAudio();
  const p = toGame(e);
  pointers.set(e.pointerId, { fx: p.fx, fy: p.fy, half: pointerHalf(p), t0: performance.now(), sx: p.fx, sy: p.fy });
  try { canvas.setPointerCapture(e.pointerId); } catch { /* punteros sintéticos */ }
});
canvas.addEventListener('pointermove', e => {
  const rec = pointers.get(e.pointerId);
  if (!rec) return;
  const p = toGame(e);
  rec.fx = p.fx; rec.fy = p.fy;
});
// El chut se decide en pointerup (divergencia del pingpong, que actuaba en
// pointerdown): hay que distinguir un toque (chut/saque) de un arrastre
// (mover barras), y eso solo se sabe al soltar. Si la pulsación quieta duró
// ≥ SUPER_HOLD_MS, es un SÚPER golpe — cargarlo cuesta quedarse sin mover
// las barras, ese es su precio táctico.
canvas.addEventListener('pointerup', e => {
  const rec = pointers.get(e.pointerId);
  if (rec) {
    const moved = Math.hypot(rec.fx - rec.sx, rec.fy - rec.sy);
    if (moved < 0.04) {
      const held = performance.now() - rec.t0;
      tapAction[mode === 'local' ? (rec.half === 'bottom' ? 0 : 1) : mySeat] = held >= SUPER_HOLD_MS ? 2 : 1;
    }
  }
  pointers.delete(e.pointerId);
});
canvas.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); });

// Las teclas de acción también deciden al SOLTAR (mismo gesto que el tap:
// pulsación corta = chut, mantenida ≥ SUPER_HOLD_MS = súper).
const keyDownT = new Map(); // code -> timestamp del keydown
window.addEventListener('keydown', e => {
  if (e.repeat) return;
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  keys.add(e.code);
  initAudio();
  if (e.code === 'Space' || e.code === 'KeyW') keyDownT.set(e.code, performance.now());
  if (e.code === 'Space') e.preventDefault();
  if (e.code === 'KeyM') setMusicMuted(!musicMuted);
});
window.addEventListener('keyup', e => {
  keys.delete(e.code);
  const t0 = keyDownT.get(e.code);
  keyDownT.delete(e.code);
  if (t0 === undefined) return;
  const act = performance.now() - t0 >= SUPER_HOLD_MS ? 2 : 1;
  if (e.code === 'Space') tapAction[mode === 'local' ? 0 : mySeat] = act;
  if (e.code === 'KeyW' && mode === 'local') tapAction[1] = act;
});

// ---------------------------------------------------------------- fuentes de control

// Interfaz común: update(dt) -> offset de barras del asiento, y
// wantsAction() -> bool (consumible; chut o saque según la fase). Así el
// bucle no distingue humano/IA/red — patrón sources del pingpong.

function pointerSource(seat, half) {
  let off = 0;
  let gpDownT = null; // timestamp de pulsación del botón A del mando
  const PAD_INDEX = half === 'top' ? 1 : 0;
  const KEYS = half === 'top' ? ['KeyA', 'KeyD'] : ['ArrowLeft', 'ArrowRight'];
  const KEYS2 = half === 'top' ? [] : ['ArrowUp', 'ArrowDown']; // útil en apaisado
  const ACTION_KEY = half === 'top' ? 'KeyW' : 'Space';
  return {
    update(dt) {
      let ptr = null;
      for (const rec of pointers.values()) {
        if (mode === 'local' ? rec.half === half : true) { ptr = rec; break; }
      }
      const now = performance.now();
      // superHold alimenta el parpadeo del ⚡ del marcador: cuánto lleva este
      // asiento manteniendo una pulsación QUIETA (dedo, tecla o botón A)
      let holdMs = 0;
      if (ptr && Math.hypot(ptr.fx - ptr.sx, ptr.fy - ptr.sy) < 0.04) holdMs = now - ptr.t0;
      if (keyDownT.has(ACTION_KEY)) holdMs = Math.max(holdMs, now - keyDownT.get(ACTION_KEY));
      if (ptr) {
        // posición absoluta: la fracción LATERAL del dedo en pantalla es el
        // offset (fx en vertical, fy en horizontal — la mesa está tumbada)
        let fLat = HORIZONTAL ? ptr.fy : ptr.fx;
        if (viewFlip) fLat = 1 - fLat;
        off = (fLat - 0.5) * 2 * Physics.MAX_TRAVEL * 1.05;
      }
      const spd = 480 * dt;
      if (keys.has(KEYS[0]) || (KEYS2[0] && keys.has(KEYS2[0]))) off -= spd;
      if (keys.has(KEYS[1]) || (KEYS2[1] && keys.has(KEYS2[1]))) off += spd;
      const gp = pollGamepad(PAD_INDEX);
      if (gp) {
        const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
        const dpad = (gpBtn(gp, 15) ? 1 : 0) - (gpBtn(gp, 14) ? 1 : 0)
          + (gpBtn(gp, 13) ? 1 : 0) - (gpBtn(gp, 12) ? 1 : 0);
        let mv = HORIZONTAL ? ay : ax;
        if (Math.abs(mv) < 0.18) mv = 0;
        mv = mv || dpad;
        if (mv) off += mv * 700 * dt * (viewFlip ? -1 : 1);
        // el botón A decide al SOLTAR, como el tap y las teclas
        const b0 = gpBtn(gp, 0);
        if (b0 && gpDownT === null) gpDownT = now;
        if (!b0 && gpDownT !== null) {
          tapAction[seat] = now - gpDownT >= SUPER_HOLD_MS ? 2 : 1;
          gpDownT = null;
        }
        if (gpDownT !== null) holdMs = Math.max(holdMs, now - gpDownT);
      }
      superHold[seat] = holdMs / 1000;
      off = clamp(off, -Physics.MAX_TRAVEL, Physics.MAX_TRAVEL);
      return off;
    },
    wantsAction() {
      const a = tapAction[seat];
      tapAction[seat] = 0;
      return a;
    },
  };
}

// ¿Alguna figura del asiento tiene la bola al alcance del chut? (lo comparte
// la IA con el render del hint; el motor hace su propia comprobación en kick)
function canKick(seat, b) {
  for (const f of Physics.figures(state, seat)) {
    if (Math.abs(b.y - f.y) < Physics.KICK_REACH_Y && Math.abs(b.x - f.x) < Physics.KICK_REACH_X) return true;
  }
  return false;
}

// IA local (modo 1P). El error se muestrea UNA vez por jugada — la
// aleatoriedad vive aquí, fuera del motor determinista.
const AI_LEVELS = {
  easy: { maxSpeed: 220, react: 0.40, errorStd: 45, kickDelay: 0.30, serveDelay: 1.3, superP: 0.2 },
  medium: { maxSpeed: 420, react: 0.24, errorStd: 20, kickDelay: 0.15, serveDelay: 1.0, superP: 0.45 },
  hard: { maxSpeed: 700, react: 0.12, errorStd: 7, kickDelay: 0.06, serveDelay: 0.8, superP: 0.7 },
};

function gauss(std) {
  let s = 0;
  for (let i = 0; i < 4; i++) s += Math.random() * 2 - 1;
  return s / 2 * std;
}

function aiSource(seat, level) {
  const P = AI_LEVELS[level];
  const myRods = Physics.RODS.map((r, i) => ({ y: r.y, figs: r.figs, travel: r.travel, idx: i, seat: r.seat }))
    .filter(r => r.seat === seat);
  let off = 0, targetOff = 0, engaged = false, reactLeft = 0, planKey = '';
  let errScale = 1, shootSide = seat === 0 ? 1 : -1;
  let kickHold = 0, serveT = 0, act = 0;
  return {
    update(dt) {
      const b = state.ball;
      const speed = Math.hypot(b.vx, b.vy);
      // barra relevante: la primera barra propia en el camino de la bola; si
      // la bola está parada o no hay ninguna por delante, la más cercana
      let rod = null;
      if (b.vy !== 0) {
        let bestDy = Infinity;
        const dir = Math.sign(b.vy);
        for (const r of myRods) {
          const dy = (r.y - b.y) * dir;
          if (dy > -Physics.KICK_REACH_Y && dy < bestDy) { bestDy = dy; rod = r; }
        }
      }
      if (!rod) {
        let bestDy = Infinity;
        for (const r of myRods) {
          const dy = Math.abs(r.y - b.y);
          if (dy < bestDy) { bestDy = dy; rod = r; }
        }
      }
      // replanificar (con retardo de reacción) cuando cambia la jugada:
      // otra barra objetivo, la bola cambia de sentido o hay un chut nuevo
      const key = rod.idx + ':' + Math.sign(b.vy) + ':' + (speed > 400 ? 1 : 0);
      if (key !== planKey) { planKey = key; reactLeft = P.react; engaged = false; errScale = 1; }
      // bola parada a tiro en profundidad pero fuera del alcance lateral (el
      // error de alineación la dejó lejos): "tantear" — reintentar con la
      // mitad de error. Sin esto la IA se quedaba pasmada mirando la bola
      // hasta el saque neutral (bug real del primer intento).
      if (engaged && speed < 20 && Math.abs(b.y - rod.y) < Physics.KICK_REACH_Y
        && Math.abs(targetOff - off) < 2 && !canKick(seat, b)) {
        engaged = false; reactLeft = 0.18; errScale *= 0.5; shootSide = -shootSide;
      }
      if (!engaged) {
        reactLeft -= dt;
        if (reactLeft <= 0) {
          const pred = Physics.predictX(b, rod.y);
          // offset de contacto deseado (0.35-0.55): el chut sale cruzado
          // dentro de la boca Y esquiva al delantero centro PROPIO, que con
          // las barras sincronizadas tapa cualquier chut recto (offset<~0.32)
          const q = shootSide * (0.35 + Math.random() * 0.2);
          const aim = pred.x + gauss(P.errorStd) * errScale - q * Physics.KICK_REACH_X;
          // figura de la barra que puede plantarse en `aim`: prima poder
          // llegar de verdad (el error residual tras el clamp pesa el triple)
          let best = 0, bestCost = Infinity;
          for (const fo of rod.figs) {
            const want = clamp(aim - fo, -rod.travel, rod.travel);
            const resid = Math.abs((want + fo) - aim);
            const cost = Math.abs(want - off) + resid * 3;
            if (cost < bestCost) { bestCost = cost; best = want; }
          }
          targetOff = best;
          engaged = true;
        }
      }
      const d = targetOff - off;
      const stepMove = Math.min(Math.abs(d), P.maxSpeed * dt);
      off += Math.sign(d) * stepMove;
      off = clamp(off, -Physics.MAX_TRAVEL, Physics.MAX_TRAVEL);

      // chut: cuando una figura tiene la bola al alcance, tras kickDelay.
      // Con carga disponible gasta un súper con probabilidad por nivel
      // (aleatoriedad fuera del motor, como todo lo de la IA).
      if (state.phase === 'play' && state.kickCd[seat] <= 0 && canKick(seat, b)) {
        kickHold += dt;
        if (kickHold >= P.kickDelay) {
          act = (state.power[seat] >= 1 && Math.random() < P.superP) ? 2 : 1;
          kickHold = 0;
        }
      } else kickHold = 0;
      if (state.phase === 'kickoff' && state.server === seat) {
        serveT += dt;
        if (serveT > P.serveDelay) { act = 1; serveT = 0; }
      } else serveT = 0;
      return off;
    },
    wantsAction() {
      const a = act; act = 0; return a;
    },
  };
}

// Barras del rival online: persiguen con un lerp corto el último offset
// recibido en snapshot (τ≈60ms) para disimular los 20Hz.
function remoteSource() {
  const src = {
    toff: 0, off: 0,
    update(dt) {
      const k = 1 - Math.exp(-dt / 0.06);
      src.off += (src.toff - src.off) * k;
      return src.off;
    },
    wantsAction() { return 0; },
  };
  return src;
}

// ---------------------------------------------------------------- HUD / DOM

function setStatus(txt) { $('status').textContent = txt || ''; }

function updateHud() {
  const leftSeat = viewFlip ? 1 : 0; // el HUD muestra al jugador "de abajo/izquierda" a la izquierda
  [0, 1].forEach(i => {
    const seat = i === 0 ? leftSeat : 1 - leftSeat;
    const el = $('p' + i);
    el.querySelector('.pname').textContent = names[seat] || '—';
    el.classList.toggle('active', !!state && state.phase === 'kickoff' && state.server === seat);
    const av = el.querySelector('.avatar');
    const g = av.getContext('2d');
    g.clearRect(0, 0, 40, 40);
    g.imageSmoothingEnabled = false;
    if (cosmetics[seat]) drawTeamBadge(g, teamDefOf(seat), 40);
  });
}

function showOver(winnerSeat) {
  const meWins = mode === 'online' ? winnerSeat === mySeat : winnerSeat === 0;
  const txt = mode === '1p'
    ? (winnerSeat === 0 ? '¡Has ganado!' : 'Ha ganado la CPU…')
    : `¡Gana ${names[winnerSeat]}!`;
  $('overText').textContent = `${txt}  ${state.scores[0]}-${state.scores[1]}`;
  $('overMsg').classList.remove('hidden');
  playSound(mode === 'local' ? 'win' : (meWins ? 'win' : 'lose'));
  if (mode !== 'online' || meWins) addEffect({ type: 'confetti', dur: 4 });
  updateHud();
}

function hideOver() {
  $('overMsg').classList.add('hidden');
  effects = effects.filter(fx => fx.type !== 'confetti');
}

function goalBanner(scorer, own) {
  const mine = mode === 'online' ? scorer === mySeat : scorer === 0;
  const sub = own ? 'EN PROPIA PUERTA'
    : (mode === '1p' ? (scorer === 0 ? 'TU GOL' : 'GOL DE LA CPU') : `DE ${(names[scorer] || '').slice(0, 10)}`);
  addEffect({ type: 'banner', dur: 1.3, text: '¡GOL!', sub, color: mine ? '#8fdc97' : '#ff9b92' });
  playSound('goal');
  triggerShake(0.3, 2);
}

// ---------------------------------------------------------------- flujo de partida

function startMatch(newMode, opts) {
  mode = newMode;
  opts = opts || {};
  viewFlip = newMode === 'online' && mySeat === 1;
  const firstKickoff = opts.firstKickoff != null ? opts.firstKickoff : (Math.random() < 0.5 ? 0 : 1);
  state = Physics.createState(firstKickoff);
  betweenT = 0; pendingScorer = null;
  effects = [];
  kickAnimT = [-9, -9];
  lastSentOff = null;

  if (newMode === '1p') {
    aiLevel = opts.level;
    names = [myName() || 'Tú', `CPU (${{ easy: 'fácil', medium: 'media', hard: 'difícil' }[opts.level]})`];
    cosmetics = [
      { team: myTeam, ball: myBall, table: myTable },
      { team: (myTeam + 1 + ['easy', 'medium', 'hard'].indexOf(opts.level)) % Cosmetics.TEAMS.length, ball: myBall, table: myTable },
    ];
    sources = [pointerSource(0, 'bottom'), aiSource(1, opts.level)];
  } else if (newMode === 'local') {
    names = ['Jugador 1', 'Jugador 2'];
    cosmetics = [
      { team: myTeam, ball: myBall, table: myTable },
      { team: (myTeam + 1) % Cosmetics.TEAMS.length, ball: myBall, table: myTable },
    ];
    sources = [pointerSource(0, 'bottom'), pointerSource(1, 'top')];
  } else { // online: names/cosmetics ya vienen del servidor
    sources = [null, null];
    sources[mySeat] = pointerSource(mySeat, 'bottom');
    sources[1 - mySeat] = remoteSource();
  }

  rebuildSprites();
  $('lobby').classList.add('hidden');
  $('game').classList.remove('hidden');
  $('chat').classList.toggle('hidden', newMode !== 'online');
  $('roomTag').classList.toggle('hidden', newMode !== 'online');
  // recordatorio de controles, siempre visible bajo el canvas
  $('controls').textContent = newMode === 'local'
    ? 'J1: desliza · ← → · Espacio chuta (mantén: ¡SÚPER!)   |   J2: A D · W chuta (mantén: ¡SÚPER!)'
    : 'Desliza para mover las barras · Toque: ¡CHUT! · Mantén pulsado y suelta: ¡SÚPER GOLPE! ⚡ (Espacio o Ⓐ)';
  hideOver();
  updateHud();
  setStatus(serveHint());
  startMusic();
}

function serveHint() {
  if (!state || state.phase !== 'kickoff') return '';
  const s = state.server;
  if (mode === 'online') return s === mySeat ? 'Tu saque: toca la pantalla' : `Saca ${names[s]}`;
  if (mode === 'local') return `Saca ${names[s]}`;
  return s === 0 ? 'Tu saque: toca o pulsa Espacio' : 'Saca la CPU…';
}

function backToMenu() {
  if (ws) { try { ws.close(); } catch { } ws = null; }
  mode = null; state = null; roomCode = null;
  stopMusic();
  hideOver();
  $('game').classList.add('hidden');
  $('lobby').classList.remove('hidden');
}

// eventos de física → sonido y efectos (compartido online/offline)
function handleEvents(evs) {
  for (const ev of evs) {
    if (ev.type === 'kick') {
      kickAnimT[ev.seat] = nowT;
      if (ev.hit) {
        const p = worldToScreen(ev.x, ev.y);
        if (ev.super) {
          addEffect({ type: 'flash', dur: 0.3, x: Math.round(p.x), y: Math.round(p.y), color: '#ffe25a' });
          triggerShake(0.2, 2);
          playSound('superkick', ev.speed);
        } else {
          addEffect({ type: 'flash', dur: 0.15, x: Math.round(p.x), y: Math.round(p.y), color: '#fff' });
          playSound('kick', ev.speed);
        }
      } else {
        playSound('swish');
      }
    } else if (ev.type === 'figure') {
      playSound('figure', ev.speed);
    } else if (ev.type === 'wall') {
      const p = worldToScreen(ev.x, ev.y);
      addEffect({ type: 'puff', dur: 0.25, x: Math.round(p.x), y: Math.round(p.y) });
      playSound('wall', ev.speed);
    } else if (ev.type === 'serve') {
      playSound('serve', 300);
    } else if (ev.type === 'dead') {
      addEffect({ type: 'banner', dur: 1.2, text: 'SAQUE NEUTRAL', color: '#c9d4e0' });
      playSound('dead');
      setStatus(serveHint());
      updateHud();
    } else if (ev.type === 'goal') {
      if (mode === 'online') {
        // La predicción local solo congela la bola: el gol de verdad (y el
        // marcador) llegan siempre del servidor en el mensaje 'goal'.
      } else {
        pendingScorer = ev.scorer;
        betweenT = 1.4;
        const own = state.lastTouch !== null && state.lastTouch !== ev.scorer;
        goalBanner(ev.scorer, own);
        updateHud();
      }
    }
  }
}

// ---------------------------------------------------------------- red (online)

function myName() { return $('nameInput').value.trim(); }

function connect(firstMsg) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = window.FUTBOLIN_SERVER_URL || `${proto}://${location.host}${location.pathname}`;
  let sock;
  try { sock = new WebSocket(url); } catch {
    $('lobbyError').textContent = 'No se ha podido conectar al servidor.';
    return;
  }
  ws = sock;
  ws.onopen = () => ws.send(JSON.stringify(firstMsg));
  ws.onmessage = e => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    if (mode === 'online') {
      setStatus('Conexión perdida. Vuelve al menú.');
    }
    ws = null;
  };
  ws.onerror = () => { $('lobbyError').textContent = 'No se ha podido conectar al servidor.'; };
}

function onMessage(m) {
  switch (m.t) {
    case 'error':
      $('lobbyError').textContent = m.msg;
      break;
    case 'joined':
      mySeat = m.seat;
      roomCode = m.room;
      names = m.names.slice();
      cosmetics = m.cosmetics.slice();
      $('roomCode').textContent = roomCode;
      $('lobby').classList.add('hidden');
      $('game').classList.remove('hidden');
      $('chat').classList.remove('hidden');
      $('roomTag').classList.remove('hidden');
      initAudio();
      setStatus('Esperando rival… comparte el código ' + roomCode);
      history.replaceState(null, '', location.pathname + '?sala=' + roomCode);
      break;
    case 'opponent':
      names[1 - mySeat] = m.name;
      cosmetics[1 - mySeat] = m.cosmetics;
      break;
    case 'start':
      names = m.names ? m.names.slice() : names;
      startMatch('online', { firstKickoff: m.server });
      addChat(null, 'Empieza la partida. ¡A ganar!');
      break;
    case 'state':
      if (mode !== 'online' || !state) break;
      applySnapshot(m);
      break;
    case 'goal': {
      if (mode !== 'online' || !state) break;
      state.scores = m.scores.slice();
      goalBanner(m.scorer, m.own);
      serveReadyAt = performance.now() + 1000;
      if (m.over) {
        state.phase = 'over';
        state.winner = m.matchWinner;
        showOver(m.matchWinner);
      } else {
        state.phase = 'kickoff';
        state.server = m.server;
        state.ball.x = 0; state.ball.y = 0; state.ball.vx = 0; state.ball.vy = 0;
      }
      updateHud();
      setStatus(serveHint());
      break;
    }
    case 'kick':
      // chut del rival: el snapshot trae la bola; esto solo adelanta pose/sonido
      if (m.seat !== mySeat) {
        kickAnimT[m.seat] = nowT;
        playSound(m.super ? 'superkick' : (m.hit ? 'kick' : 'swish'), 500);
        if (m.super) triggerShake(0.2, 2);
      }
      break;
    case 'serve':
      if (m.seat !== mySeat) { kickAnimT[m.seat] = nowT; playSound('serve', 300); }
      break;
    case 'chat':
      addChat(m.from, m.text, m.seat);
      break;
    case 'left':
      setStatus('Tu rival se ha ido.');
      addChat(null, 'El rival se ha desconectado.');
      if (state) { state.phase = 'over'; }
      $('overText').textContent = 'El rival se ha desconectado';
      $('overMsg').classList.remove('hidden');
      break;
  }
}

// Reconciliación con el snapshot del servidor: corrección suave si el error es
// pequeño, snap si es grande o cambió la fase. Las barras rivales van aparte
// (remoteSource) para poder suavizarlas sin tocar la física. kickCd/deadT
// viajan en el snapshot para que la predicción local juzgue igual que el
// servidor (mismo motivo que la contabilidad de botes del pingpong).
function applySnapshot(m) {
  const b = state.ball;
  const sb = m.ball;
  const err = Math.hypot(b.x - sb.x, b.y - sb.y);
  if (state.phase !== m.phase || err > 40) {
    Object.assign(b, sb);
  } else if (err > 6) {
    b.x += (sb.x - b.x) * 0.35; b.y += (sb.y - b.y) * 0.35;
    b.vx = sb.vx; b.vy = sb.vy;
  }
  state.phase = m.phase;
  state.server = m.server;
  state.scores = m.scores.slice();
  state.kickCd = m.kickCd.slice();
  state.power = m.power.slice();
  state.deadT = m.deadT;
  state.lastTouch = m.lastTouch;
  const rs = sources[1 - mySeat];
  if (rs && rs.toff !== undefined) rs.toff = m.rods[1 - mySeat];
  updateHud();
}

function addChat(from, text, seat) {
  const log = $('chatLog');
  const div = document.createElement('div');
  if (from === null || from === undefined) {
    div.className = 'sys'; div.textContent = text;
  } else {
    const b = document.createElement('span');
    b.className = 'from' + (seat === mySeat ? ' me' : '');
    b.textContent = from + ': ';
    div.appendChild(b);
    div.appendChild(document.createTextNode(text));
  }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// ---------------------------------------------------------------- bucle

let lastTs = 0;

function frame(ts) {
  const dt = Math.min(0.05, (ts - lastTs) / 1000 || 0.016);
  lastTs = ts;
  nowT += dt;
  crowdT += dt;
  if (shakeT > 0) shakeT -= dt;

  for (const fx of effects) fx.t += dt;
  effects = effects.filter(fx => fx.t < fx.dur);

  if (mode && state) {
    // 1) fuentes → offsets de barras (+ acciones de chut/saque)
    for (let seat = 0; seat < 2; seat++) {
      const src = sources[seat];
      if (!src) continue;
      const off = src.update(dt);
      Physics.setRods(state, seat, off);
      // la acción se consume SIEMPRE (un toque en pausa se descarta, no queda
      // en cola — mismo criterio deliberado que el saque del pingpong).
      // act: 1 = chut/saque normal · 2 = SÚPER golpe
      const act = src.wantsAction();
      if (act) {
        if (state.phase === 'kickoff' && state.server === seat && betweenT <= 0) {
          if (mode === 'online') {
            if (seat === mySeat && performance.now() >= serveReadyAt) {
              ws && ws.send(JSON.stringify({ t: 'serve' }));
              const evs = [];
              Physics.serve(state, seat, evs); // predicción local; el server manda
              handleEvents(evs);
              setStatus('');
            }
          } else {
            const evs = [];
            Physics.serve(state, seat, evs);
            handleEvents(evs);
            setStatus('');
          }
        } else if (state.phase === 'play') {
          if (mode === 'online') {
            if (seat === mySeat) {
              ws && ws.send(JSON.stringify({ t: 'kick', super: act === 2 }));
              const evs = [];
              Physics.kick(state, seat, evs, act === 2); // predicción local del chut
              handleEvents(evs);
            }
          } else {
            const evs = [];
            Physics.kick(state, seat, evs, act === 2);
            handleEvents(evs);
          }
        }
      }
    }

    // 2) pausa tras gol (solo offline: online la lleva el servidor)
    if (mode !== 'online' && betweenT > 0) {
      betweenT -= dt;
      if (betweenT <= 0 && pendingScorer !== null) {
        Physics.applyGoal(state, pendingScorer);
        pendingScorer = null;
        updateHud();
        if (state.phase === 'over') showOver(state.winner);
        else setStatus(serveHint());
      }
    }

    // 3) física. En online esto es PREDICCIÓN para animar a 60fps entre
    // snapshots (doble motor intencional, como billar y pingpong): si
    // discrepa, el snapshot del servidor siempre gana.
    if (state.phase === 'play' || state.phase === 'kickoff') {
      const evs = [];
      Physics.step(state, dt, evs);
      handleEvents(evs);
    }

    // 4) online: enviar mi offset (throttled ~30Hz, solo si cambió)
    if (mode === 'online' && ws && ws.readyState === 1 && ts - lastRodSend > 33) {
      const r = state.rods[mySeat];
      if (r.toff !== lastSentOff) {
        ws.send(JSON.stringify({ t: 'rod', off: Math.round(r.toff * 10) / 10 }));
        lastSentOff = r.toff;
        lastRodSend = ts;
      }
    }

    if (state.phase === 'kickoff' && !$('status').textContent) setStatus(serveHint());
  }

  // En el lobby solo se anima el logo: la escena queda tapada por el overlay
  // opaco y dibujarla igualmente saturaba el hilo principal en móviles
  // modestos (gotcha real de billar y pingpong).
  if (!$('lobby').classList.contains('hidden')) drawLogo(nowT);
  else if (!document.hidden) draw();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- lobby

// Logo animado del menú: FURBOLIN pixel ondulante + una barra con tres
// figuritas que persiguen a la bola. Se dibuja desde frame() solo mientras el
// lobby está visible.
const logoCanvas = $('logo');
const logoCtx = logoCanvas.getContext('2d');
const LOGO_COLS = ['#f0c541', '#e05545', '#3d9ad4', '#3db554', '#e060a8'];

function drawLogo(t) {
  const g = logoCtx;
  const Wl = logoCanvas.width, Hl = logoCanvas.height;
  g.clearRect(0, 0, Wl, Hl);
  const txt = 'FURBOLIN';
  const scale = 4;
  let x = (Wl - pixelTextWidth(txt, scale)) / 2;
  [...txt].forEach((ch, i) => {
    const bob = Math.round(Math.sin(t * 2.5 + i * 0.7) * 2);
    drawPixelText(g, ch, x + 2, 10 + bob + 2, scale, '#0c0906');
    drawPixelText(g, ch, x, 10 + bob, scale, LOGO_COLS[i % LOGO_COLS.length]);
    x += 4 * scale;
  });
  // mini-futbolín: la bola va y viene y las figuritas la persiguen
  const by = 52;
  const bx = 20 + (Math.sin(t * 1.1) * 0.5 + 0.5) * (Wl - 40);
  g.fillStyle = '#9aa2ac'; g.fillRect(8, by, Wl - 16, 2);
  g.fillStyle = '#d4dae0'; g.fillRect(8, by, Wl - 16, 1);
  const fx0 = Math.max(20, Math.min(Wl - 20 - 34, bx - 20));
  for (let i = 0; i < 3; i++) {
    const fxp = Math.round(fx0 + i * 14);
    g.fillStyle = '#d43d3d'; g.fillRect(fxp, by - 4, 6, 10);
    g.fillStyle = '#e8b88a'; g.fillRect(fxp + 1, by - 2, 4, 4);
  }
  g.fillStyle = '#0c0906'; g.fillRect(Math.round(bx) - 2, by + 6, 5, 5);
  g.fillStyle = '#f8f8f0'; g.fillRect(Math.round(bx) - 3, by + 5, 5, 5);
}

function buildPicker(containerId, items, size, drawFn, onSelect) {
  const box = $(containerId);
  items.forEach((item, idx) => {
    const btn = document.createElement('button');
    btn.className = 'pick' + (idx === 0 ? ' selected' : '');
    btn.title = item.name;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    drawFn(g, item, size);
    btn.appendChild(c);
    btn.addEventListener('click', () => {
      box.querySelectorAll('.pick').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      onSelect(idx);
    });
    box.appendChild(btn);
  });
}

buildPicker('teamPicker', Cosmetics.TEAMS, 36, (g, item, s) => drawTeamBadge(g, item, s), idx => { myTeam = idx; });
buildPicker('ballPicker', Cosmetics.BALLS, 36, (g, item, s) => {
  const r = Math.round(s * 0.3);
  fillPixelCircle(g, Math.round(s / 2), Math.round(s / 2), r, item.color);
  g.fillStyle = item.dark;
  g.fillRect(Math.round(s / 2) - Math.floor(r / 2), Math.round(s / 2) + r - 2, r, 2);
  g.fillStyle = '#fff';
  g.fillRect(Math.round(s / 2) - Math.floor(r / 2), Math.round(s / 2) - Math.floor(r / 2), Math.max(2, Math.floor(r / 2)), 2);
}, idx => { myBall = idx; });
buildPicker('tablePicker', Cosmetics.TABLES, 36, (g, item, s) => {
  const u = s / 12;
  g.fillStyle = item.frame; g.fillRect(0, 0, s, s);
  g.fillStyle = item.field; g.fillRect(1.5 * u, 2 * u, 9 * u, 8 * u);
  g.fillStyle = item.line;
  g.fillRect(1.5 * u, 5.7 * u, 9 * u, 0.6 * u);
  g.fillRect(5 * u, 4.5 * u, 2 * u, 3 * u);
}, idx => { myTable = idx; });

document.querySelectorAll('[data-level]').forEach(btn => {
  btn.addEventListener('click', () => {
    initAudio();
    startMatch('1p', { level: btn.dataset.level });
  });
});
$('localBtn').addEventListener('click', () => { initAudio(); startMatch('local', {}); });
$('createBtn').addEventListener('click', () => {
  $('lobbyError').textContent = '';
  connect({ t: 'create', name: myName(), team: myTeam, ball: myBall, table: myTable });
});
function joinFromInput() {
  const code = $('codeInput').value.trim().toUpperCase();
  if (code.length < 4) { $('lobbyError').textContent = 'El código tiene 4 letras.'; return; }
  $('lobbyError').textContent = '';
  connect({ t: 'join', room: code, name: myName(), team: myTeam, ball: myBall, table: myTable });
}
$('joinBtn').addEventListener('click', joinFromInput);
$('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinFromInput(); });

// enlace de invitación ?sala=XXXX
{
  const saved = new URLSearchParams(location.search).get('sala');
  if (saved) $('codeInput').value = saved.toUpperCase();
}

$('exitBtn').addEventListener('click', backToMenu);
$('menuBtn').addEventListener('click', backToMenu);
$('rematchBtn').addEventListener('click', () => {
  if (mode === 'online') {
    ws && ws.send(JSON.stringify({ t: 'rematch' }));
    addChat(null, 'Esperando a que tu rival acepte…');
  } else {
    // offline: saca el que perdió
    const loser = 1 - state.winner;
    startMatch(mode, { level: aiLevel, firstKickoff: loser });
  }
});

$('chatForm').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text || !ws) return;
  ws.send(JSON.stringify({ t: 'chat', text }));
  $('chatInput').value = '';
});

layout();
window.addEventListener('resize', layout);
window.addEventListener('orientationchange', layout);
requestAnimationFrame(frame);
