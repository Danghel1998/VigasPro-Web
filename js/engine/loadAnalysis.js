/**
 * Análisis estático de una viga simplemente apoyada de un solo tramo, bajo
 * carga uniformemente distribuida y hasta N cargas puntuales. Genera los
 * diagramas de momento flector M(x) y fuerza cortante V(x) por superposición
 * directa de reacciones (estáticamente determinada — no requiere métodos de
 * análisis estructural adicionales).
 *
 * Convención: x medido desde el apoyo izquierdo (x=0) hasta el apoyo
 * derecho (x=L). Todas las cargas de entrada ya deben venir factoradas
 * (Wu = 1.4·CM + 1.7·CV), ver combineLoads().
 */

/** Combina cargas de servicio (muerta/viva) en la carga última Wu, según los factores de la Norma E.060 (por defecto 1.4D+1.7L). */
export function combineLoads(D, L, LF_D = 1.4, LF_L = 1.7) {
  return LF_D * D + LF_L * L;
}

/**
 * @param {number} L_m Luz de la viga (m)
 * @param {number} wu_kgm Carga distribuida última (kg/m)
 * @param {Array<{pos:number, Pu:number}>} pointLoads Cargas puntuales últimas, posición medida desde el apoyo izquierdo (m)
 * @param {number} nSamples Número de puntos de muestreo para los diagramas
 */
export function analyzeSimpleBeam(L_m, wu_kgm, pointLoads = [], nSamples = 200) {
  const loads = pointLoads.filter(p => p.pos >= 0 && p.pos <= L_m && p.Pu > 0);
  const sumPu = loads.reduce((s, p) => s + p.Pu, 0);
  const momentPu = loads.reduce((s, p) => s + p.Pu * p.pos, 0);

  const R2 = (wu_kgm * L_m * L_m) / 2.0 / L_m + momentPu / L_m; // = wu*L/2 + Σ(Pu·pos)/L
  const R1 = wu_kgm * L_m + sumPu - R2;

  function V(x) {
    let v = R1 - wu_kgm * x;
    for (const p of loads) {
      if (p.pos <= x) v -= p.Pu;
    }
    return v;
  }

  function M(x) {
    let m = R1 * x - (wu_kgm * x * x) / 2.0;
    for (const p of loads) {
      if (p.pos <= x) m -= p.Pu * (x - p.pos);
    }
    return m;
  }

  // Puntos de muestreo: malla uniforme + posiciones exactas de cargas
  // puntuales (justo antes/después, para capturar el salto de V sin
  // interpolar sobre la discontinuidad).
  const xs = new Set();
  for (let i = 0; i <= nSamples; i++) xs.add((L_m * i) / nSamples);
  const eps = Math.min(0.001, L_m / 1e4);
  for (const p of loads) {
    xs.add(Math.max(0, p.pos - eps));
    xs.add(p.pos);
    xs.add(Math.min(L_m, p.pos + eps));
  }
  const sortedXs = Array.from(xs).sort((a, b) => a - b);
  const points = sortedXs.map(x => ({ x, M: M(x), V: V(x) }));

  let MuMax = points[0];
  for (const pt of points) if (pt.M > MuMax.M) MuMax = pt;

  return {
    R1, R2, points,
    Mu_max: MuMax,
    Vu_left_face: V(0),
    Vu_right_face: -V(L_m),
    Vu_at: (x) => V(Math.max(0, Math.min(L_m, x))),
  };
}
