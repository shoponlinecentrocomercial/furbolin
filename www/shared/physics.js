'use strict';
// Motor de futbolín compartido cliente/servidor (UMD, como billar y pingpong).
// 2D cenital. Determinista: cero Math.random aquí dentro — el input son solo
// el offset de barras por asiento (setRods) y las acciones serve/kick. Toda
// la aleatoriedad (errores de la IA, efectos) vive fuera del motor: así
// cliente (predicción) y servidor corren la MISMA física con los mismos inputs.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Physics = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // Unidades ~mm de futbolín real (campo 120×68 cm). x = lateral (las barras
  // deslizan en x), y = profundidad (0 = medio campo). Asiento 0 defiende y<0.
  const W = 680, L = 1200;
  const HALF_W = W / 2, HALF_L = L / 2;
  const BALL_R = 17;         // bola de 34 mm
  const FIG_R = 20;          // colisionador de figura: círculo (como las bolas del billar)
  const GOAL_W = 220;        // boca de portería en y=±HALF_L, |x| < 110
  const FRICTION = 85;       // desaceleración por rodadura (mm/s²). Bajó de 110 tras el
                             // feedback de jul-2026: con 110 la bola moría demasiado en
                             // tierra de nadie y llovían saques neutrales
  const STOP_SPEED = 8;      // por debajo de esto la bola se para
  const WALL_REST = 0.8;     // rebote en banda
  const FIG_REST = 0.6;      // rebote pasivo bola-figura
  const KICK_SPEED = 1050;   // velocidad del chut normal (subió de 950, mismo feedback)
  const KICK_REACH_X = 42;   // alcance lateral del chut respecto a la figura
  const KICK_REACH_Y = 66;   // alcance en profundidad. Subió de 48: la banda muerta entre
                             // barras (cada 150) pasa de 54 mm a 18 mm — casi desaparece la
                             // tierra de nadie. Debe seguir < 75 (medio hueco): con más, dos
                             // barras podrían alcanzar la misma bola y habría ambigüedad
  const KICK_COOLDOWN = 0.3; // s entre chuts de un mismo asiento (anti-spam determinista)
  const DEAD_BALL_T = 3;     // s con la bola parada → saque neutral
  const SUPER_CHARGES = 2;   // tope de cargas de súper golpe por jugador
  const SUPER_REGEN_T = 20;  // s de partida para regenerar una carga
  const SUPER_SPEED = 1500;  // velocidad del SÚPER golpe (mantener pulsado y soltar)
  const MAX_TRAVEL = 200;    // recorrido de la barra más larga (defensa) = rango del input
  const VFIG_MAX = 600;      // tope de velocidad de figura a efectos de impulso: sin él, un
                             // barrido rápido (voff llega a 1400) lanzaría la bola más
                             // fuerte que el propio chut (950)
  const SUB = 1 / 240;       // substep fijo de integración (como billar/pingpong)
  const WIN_GOALS = 5;       // gana el primero a 5, como en el bar

  // Las 8 barras reglamentarias (1-2-3-5-5-3-2-1 desde y=-600), cada 150.
  // figs = offsets x de cada figura respecto al offset de su asiento.
  // travel = clamp del offset para ESA barra (= HALF_W - FIG_R - offset extremo):
  //   defensa 340-20-120=200 · medios 340-20-240=80 · delanteros 340-20-185=135.
  //   El portero (±115 + radio) cubre la boca (±110) pero NO llega a las
  //   esquinas — de ahí la regla de bola muerta (DEAD_BALL_T). Huecos de 80
  //   entre medios > ∅34 de la bola: se puede pasar entre figuras.
  const RODS = [
    { seat: 0, y: -525, type: 'portero',    figs: [0],                       travel: 115 },
    { seat: 0, y: -375, type: 'defensa',    figs: [-120, 120],               travel: 200 },
    { seat: 1, y: -225, type: 'delanteros', figs: [-185, 0, 185],            travel: 135 },
    { seat: 0, y: -75,  type: 'medios',     figs: [-240, -120, 0, 120, 240], travel: 80 },
    { seat: 1, y: 75,   type: 'medios',     figs: [-240, -120, 0, 120, 240], travel: 80 },
    { seat: 0, y: 225,  type: 'delanteros', figs: [-185, 0, 185],            travel: 135 },
    { seat: 1, y: 375,  type: 'defensa',    figs: [-120, 120],               travel: 200 },
    { seat: 1, y: 525,  type: 'portero',    figs: [0],                       travel: 115 },
  ];

  // El saque rueda hacia el propio medio campo y se frena en |y|=33: a 42 de
  // la barra de medios propia (y=∓75) — dentro del alcance de chut (48) pero
  // sin llegar a tocar la figura central (37 = BALL_R+FIG_R). v²=2·F·d.
  const SERVE_STOP_Y = 33;
  const SERVE_SPEED = Math.sqrt(2 * FRICTION * SERVE_STOP_Y);

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  function createState(firstKickoff) {
    return {
      ball: { x: 0, y: 0, vx: 0, vy: 0 },
      // Un offset por ASIENTO, no por barra (control "todas las barras a la
      // vez"): cada barra satura en su propio travel vía rodOff().
      rods: [{ off: 0, toff: 0, voff: 0 }, { off: 0, toff: 0, voff: 0 }],
      phase: 'kickoff',        // kickoff | play | between | over
      server: firstKickoff,    // quién saca (tras gol: el que lo encajó)
      firstKickoff,
      scores: [0, 0],
      winner: null,
      kickCd: [0, 0],          // cooldown de chut restante por asiento (s)
      power: [1, 1],           // cargas de súper golpe (0..SUPER_CHARGES, flotante;
                               // se EMPIEZA con una y regenera en step; los goles
                               // no la resetean — dura toda la partida)
      deadT: 0,                // segundos acumulados con la bola parada en juego
      lastTouch: null,         // solo para efectos/banners (gol en propia)
    };
  }

  // El input son POSICIONES objetivo; step() deriva las velocidades — mismo
  // patrón que las palas del pingpong (independiente de relojes).
  function setRods(state, seat, off) {
    state.rods[seat].toff = clamp(off, -MAX_TRAVEL, MAX_TRAVEL);
  }

  // Offset efectivo de una barra: el offset del asiento saturado al recorrido
  // de esa barra concreta.
  function rodOff(state, rod) {
    return clamp(state.rods[rod.seat].off, -rod.travel, rod.travel);
  }

  // Velocidad lateral efectiva de las figuras de una barra. Cero si la barra
  // está saturada en su clamp: el tope no "dispara" la bola. Con tope VFIG_MAX
  // para que el barrido no supere al chut.
  function rodVel(state, rod) {
    const r = state.rods[rod.seat];
    if (Math.abs(r.off) >= rod.travel) return 0;
    return clamp(r.voff, -VFIG_MAX, VFIG_MAX);
  }

  // Posiciones efectivas de las figuras de un asiento — render, IA y chut
  // comparten esta única fuente. rod = índice en RODS.
  function figures(state, seat) {
    const out = [];
    for (let i = 0; i < RODS.length; i++) {
      const rod = RODS[i];
      if (rod.seat !== seat) continue;
      const off = rodOff(state, rod), vfig = rodVel(state, rod);
      for (const fo of rod.figs) out.push({ x: off + fo, y: rod.y, rod: i, vx: vfig });
    }
    return out;
  }

  function resetBall(state) {
    const b = state.ball;
    b.x = 0; b.y = 0; b.vx = 0; b.vy = 0;
  }

  // Saque: la bola rueda desde el centro hacia el PROPIO medio campo del que
  // saca (saca quien encaja, como en el bar) y se frena al alcance de sus medios.
  function serve(state, seat, events) {
    if (state.phase !== 'kickoff' || state.server !== seat) return false;
    const b = state.ball;
    const dir = seat === 0 ? -1 : 1;
    b.x = 0; b.y = 0;
    b.vx = 0; b.vy = dir * SERVE_SPEED;
    state.phase = 'play';
    state.lastTouch = seat;
    state.deadT = 0;
    if (events) events.push({ type: 'serve', seat });
    return true;
  }

  // Chut determinista "por objetivo" (principio del hitBall del pingpong): el
  // offset de contacto bola-figura decide el punto de la línea de fondo rival
  // al que va el tiro. La boca es ±110 y el abanico llega a ±180 (más el
  // efecto de la barra en movimiento): offset > ~0.6 → poste o fuera. Los
  // fallos EMERGEN de la geometría, sin tiradas de dados.
  // wantSuper pide gastar una carga de súper golpe: solo se consume SI la
  // figura golpea de verdad (el súper al aire no castiga — el coste ya fue
  // quedarse quieto cargando el gesto).
  function kick(state, seat, events, wantSuper) {
    if (state.phase !== 'play') return false;
    if (state.kickCd[seat] > 0) return false;
    state.kickCd[seat] = KICK_COOLDOWN; // siempre, también al aire: anti-spam
    const b = state.ball;
    let best = null, bestD2 = Infinity;
    for (const rod of RODS) {
      if (rod.seat !== seat) continue;
      const dy = b.y - rod.y;
      if (Math.abs(dy) >= KICK_REACH_Y) continue;
      const off = rodOff(state, rod);
      for (const fo of rod.figs) {
        const dx = b.x - (off + fo);
        if (Math.abs(dx) >= KICK_REACH_X) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; best = { fx: off + fo, rod }; }
      }
    }
    if (!best) {
      if (events) events.push({ type: 'kick', seat, hit: false, x: b.x, y: b.y });
      return false;
    }
    // Siempre hacia la portería rival — el chut nunca va hacia atrás: el
    // portero "despeja" hacia delante, que es lo que se quiere (decisión).
    const dir = seat === 0 ? 1 : -1;
    const offset = clamp((b.x - best.fx) / KICK_REACH_X, -1, 1);
    const vfig = rodVel(state, best.rod);
    const tx = clamp(offset * 180 + vfig * 0.055, -HALF_W, HALF_W);
    const ty = dir * HALF_L;
    const mx = tx - b.x, my = ty - b.y;
    const m = Math.hypot(mx, my) || 1;
    const isSuper = !!wantSuper && state.power[seat] >= 1;
    if (isSuper) state.power[seat] -= 1;
    const speed = isSuper ? SUPER_SPEED : KICK_SPEED;
    b.vx = (mx / m) * speed;
    b.vy = (my / m) * speed;
    state.lastTouch = seat;
    state.deadT = 0;
    if (events) events.push({ type: 'kick', seat, hit: true, super: isSuper, x: b.x, y: b.y, speed });
    return true;
  }

  function applyGoal(state, scorer) {
    state.scores[scorer]++;
    if (state.scores[scorer] >= WIN_GOALS) {
      state.phase = 'over';
      state.winner = scorer;
    } else {
      state.server = 1 - scorer; // saca quien encaja
      state.phase = 'kickoff';
    }
    resetBall(state);
    state.kickCd[0] = 0; state.kickCd[1] = 0;
    state.deadT = 0;
    state.lastTouch = null;
  }

  function substep(state, h, events) {
    const b = state.ball;
    // Fricción + movimiento (modelo del billar: desaceleración lineal)
    const sp = Math.hypot(b.vx, b.vy);
    if (sp > 0) {
      const dec = FRICTION * h;
      if (sp <= dec || sp < STOP_SPEED) { b.vx = 0; b.vy = 0; }
      else { b.vx -= (b.vx / sp) * dec; b.vy -= (b.vy / sp) * dec; }
    }
    b.x += b.vx * h;
    b.y += b.vy * h;

    // Gol: la bola cruza ENTERA la línea de fondo dentro de la boca. Entra por
    // y=+HALF_L → gol del asiento 0 (ataca hacia +y). Los goles en propia
    // cuentan solos para el rival — no hace falta regla extra.
    if (Math.abs(b.x) < GOAL_W / 2 && Math.abs(b.y) > HALF_L + BALL_R) {
      const scorer = b.y > 0 ? 0 : 1;
      b.vx = 0; b.vy = 0;
      state.phase = 'between';
      if (events) events.push({ type: 'goal', scorer, x: b.x, y: b.y });
      return;
    }

    // Bandas (AABB como el billar). Las cortas se ignoran dentro de la boca
    // de portería — mismo patrón que nearPocket/troneras en el billar; el
    // resto de la banda corta hace de poste sin geometría extra.
    let bounced = 0;
    if (b.x < -HALF_W + BALL_R) { b.x = -HALF_W + BALL_R; if (b.vx < 0) { b.vx = -b.vx * WALL_REST; bounced = Math.abs(b.vx); } }
    else if (b.x > HALF_W - BALL_R) { b.x = HALF_W - BALL_R; if (b.vx > 0) { b.vx = -b.vx * WALL_REST; bounced = Math.abs(b.vx); } }
    if (Math.abs(b.x) >= GOAL_W / 2) {
      if (b.y < -HALF_L + BALL_R) { b.y = -HALF_L + BALL_R; if (b.vy < 0) { b.vy = -b.vy * WALL_REST; bounced = Math.max(bounced, Math.abs(b.vy)); } }
      else if (b.y > HALF_L - BALL_R) { b.y = HALF_L - BALL_R; if (b.vy > 0) { b.vy = -b.vy * WALL_REST; bounced = Math.max(bounced, Math.abs(b.vy)); } }
    }
    if (bounced > 20 && events) events.push({ type: 'wall', speed: bounced, x: b.x, y: b.y });

    // Colisión bola-figura: círculos cinemáticos de masa infinita (la figura
    // no se inmuta). El rebote suma la velocidad lateral de la barra (vfig):
    // el "regate" arrastrando la barra emerge de aquí, sin código específico.
    for (const rod of RODS) {
      if (Math.abs(b.y - rod.y) >= BALL_R + FIG_R) continue;
      const off = rodOff(state, rod);
      const vfig = rodVel(state, rod);
      for (const fo of rod.figs) {
        const fx = off + fo;
        const dx = b.x - fx, dy = b.y - rod.y;
        const min = BALL_R + FIG_R;
        const d2 = dx * dx + dy * dy;
        if (d2 >= min * min || d2 === 0) continue;
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
        // Separación: la bola sale entera del círculo de la figura
        b.x = fx + nx * min;
        b.y = rod.y + ny * min;
        const rel = (b.vx - vfig) * nx + b.vy * ny;
        if (rel < 0) {
          b.vx -= (1 + FIG_REST) * rel * nx;
          b.vy -= (1 + FIG_REST) * rel * ny;
          state.lastTouch = rod.seat;
          state.deadT = 0;
          if (events && -rel > 20) events.push({ type: 'figure', seat: rod.seat, x: b.x, y: b.y, speed: -rel });
        }
      }
    }
  }

  // Avanza la simulación dt segundos. Devuelve true si la bola se mueve.
  function step(state, dt, events) {
    dt = Math.min(dt, 0.1);
    if (dt <= 0) return false;
    // Mover barras hacia su objetivo y derivar velocidad (suavizada) — patrón
    // exacto de las palas del pingpong.
    for (const r of state.rods) {
      const nv = (r.toff - r.off) / dt;
      r.voff = r.voff * 0.5 + clamp(nv, -1400, 1400) * 0.5;
      r.off = r.toff;
    }
    state.kickCd[0] = Math.max(0, state.kickCd[0] - dt);
    state.kickCd[1] = Math.max(0, state.kickCd[1] - dt);
    // el súper regenera con el tiempo de PARTIDA (también en kickoff/between:
    // por eso va antes del early return de fase)
    state.power[0] = Math.min(SUPER_CHARGES, state.power[0] + dt / SUPER_REGEN_T);
    state.power[1] = Math.min(SUPER_CHARGES, state.power[1] + dt / SUPER_REGEN_T);
    if (state.phase !== 'play') return false;
    let t = dt;
    while (t > 1e-9 && state.phase === 'play') {
      const h = Math.min(SUB, t);
      substep(state, h, events);
      t -= h;
    }
    const b = state.ball;
    const moving = Math.hypot(b.vx, b.vy) >= STOP_SPEED;
    // Bola muerta: en el futbolín real la bola puede quedar parada fuera del
    // alcance de todas las figuras (esquinas tras el portero). Regla arcade:
    // 4 s parada → saque neutral para el dueño de la mitad donde murió.
    if (state.phase === 'play' && !moving) {
      state.deadT += dt;
      if (state.deadT >= DEAD_BALL_T) {
        state.server = b.y < 0 ? 0 : 1;
        state.phase = 'kickoff';
        resetBall(state);
        state.deadT = 0;
        if (events) events.push({ type: 'dead' });
      }
    } else {
      state.deadT = 0;
    }
    return moving;
  }

  // ¿Dónde cruzará la bola el plano y=planeY? Simula fricción + rebotes en
  // bandas laterales, IGNORANDO figuras (los bloqueos son parte del juego).
  // Para la IA — comparte el motor para que "vea" la misma física. Si la bola
  // se para antes de llegar, devuelve dónde se paró.
  function predictX(ball, planeY) {
    const b = { x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy };
    const toward = planeY < b.y ? -1 : 1;
    if (b.vy === 0 || Math.sign(b.vy) !== toward) return { x: clamp(b.x, -HALF_W, HALF_W), t: 0 };
    let t = 0;
    while (t < 3) {
      const sp = Math.hypot(b.vx, b.vy);
      if (sp === 0) break;
      const dec = FRICTION * SUB;
      if (sp <= dec || sp < STOP_SPEED) break;
      b.vx -= (b.vx / sp) * dec;
      b.vy -= (b.vy / sp) * dec;
      b.x += b.vx * SUB;
      b.y += b.vy * SUB;
      t += SUB;
      if (b.x < -HALF_W + BALL_R) { b.x = -HALF_W + BALL_R; if (b.vx < 0) b.vx = -b.vx * WALL_REST; }
      else if (b.x > HALF_W - BALL_R) { b.x = HALF_W - BALL_R; if (b.vx > 0) b.vx = -b.vx * WALL_REST; }
      if ((toward === -1 && b.y <= planeY) || (toward === 1 && b.y >= planeY)) break;
    }
    return { x: clamp(b.x, -HALF_W, HALF_W), t };
  }

  return {
    W, L, HALF_W, HALF_L, BALL_R, FIG_R, GOAL_W, MAX_TRAVEL,
    KICK_REACH_X, KICK_REACH_Y, KICK_COOLDOWN, WIN_GOALS, RODS,
    KICK_SPEED, SUPER_SPEED, SUPER_CHARGES, SUPER_REGEN_T,
    createState, setRods, serve, kick, step, applyGoal, figures, predictX,
  };
});
