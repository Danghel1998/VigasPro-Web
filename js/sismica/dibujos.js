/** Dibujos SVG (colores fijos para que impriman y exporten igual). */
import { BARS, posicionesEstribos } from './engine.js';

const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="Arial" font-size="12"><rect width="${w}" height="${h}" fill="#fff"/>${body}</svg>`;
const line = (x1, y1, x2, y2, c = '#111', sw = 1, extra = '') => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="${sw}" ${extra}/>`;
const text = (x, y, t, c = '#111', anchor = 'middle', extra = '') => `<text x="${x}" y="${y}" fill="${c}" text-anchor="${anchor}" ${extra}>${t}</text>`;
const cota = (x1, x2, y, t) => line(x1, y, x2, y, '#555') + line(x1, y - 4, x1, y + 4, '#555') + line(x2, y - 4, x2, y + 4, '#555') + text((x1 + x2) / 2, y - 5, t, '#333');
export const etiqueta = (grupos) => grupos.filter((x) => x.n > 0).map((x) => `${x.n} ϕ ${BARS[x.id].t}`).join(' + ') || '—';

export function elevacion(D, R) {
  // Bastones dibujados como barras sueltas desde el apoyo, con sus cotas (apoyo | longitud en la luz).
  const W = 900, H = 330, m = 40;
  const total = D.apIzq + D.ln + D.apDer, k = (W - 2 * m) / total;
  const x0 = m, xa = x0 + D.apIzq * k, xb = xa + D.ln * k, x1 = xb + D.apDer * k;
  const top = 90, bot = 220;
  let s = '';
  [[x0, xa], [xb, x1]].forEach(([a, b]) => {
    s += `<rect x="${a}" y="68" width="${b - a}" height="174" fill="#d9d9d9"/>`;
    s += text((a + b) / 2, (top + bot) / 2 + 4, 'Apoyo', '#333');
  });
  s += line(xa, top, xb, top, '#111', 1.5) + line(xa, bot, xb, bot, '#111', 1.5);
  [x0, xa, xb, x1].forEach((x) => { s += line(x, 68, x, top, '#111', 1.2) + line(x, bot, x, 242, '#111', 1.2); });
  const corr = (f, y) => line(x0 + 6, y, x1 - 6, y, '#111', 2.2) + line(x0 + 6, y, x0 + 6, y + (f ? 20 : -20), '#111', 2.2) + line(x1 - 6, y, x1 - 6, y + (f ? 20 : -20), '#111', 2.2);
  s += corr(true, top + 12) + corr(false, bot - 12);
  s += text((xa + xb) / 2, top - 5, etiqueta([D.barras[3][0]]), '#111', 'middle', 'font-weight="bold"');
  s += text((xa + xb) / 2, bot + 15, etiqueta([D.barras[2][0]]), '#111', 'middle', 'font-weight="bold"');
  const Li = Math.min(R.Lb1, D.ln), Ld = Math.min(R.Lb2, D.ln);
  [0, 1].forEach((f) => { // 0 inferior, 1 superior
    const y = f ? top + 36 : bot - 36;
    const extra = (i) => D.barras[i + f].slice(1);
    const hay = (i) => extra(i).some((v) => v.n > 0);
    if (hay(0)) s += line(x0 + 12, y, xa + Li * k, y, '#1d4ed8', 2.5) + text(xa + 4, y + 14, etiqueta(extra(0)), '#1d4ed8', 'start');
    if (hay(4)) s += line(xb - Ld * k, y, x1 - 12, y, '#1d4ed8', 2.5) + text(xb - 4, y + 14, etiqueta(extra(4)), '#1d4ed8', 'end');
    if (hay(2)) s += line(xa + D.ln * k / 4, y, xb - D.ln * k / 4, y, '#1d4ed8', 2.5) + text((xa + xb) / 2, y + 14, etiqueta(extra(2)), '#1d4ed8');
    // Cotas: arriba para los bastones superiores, abajo para los inferiores.
    const yc = f ? 56 : 264;
    if (hay(0)) s += cota(x0, xa, yc, `${D.apIzq.toFixed(2)} m`) + cota(xa, xa + Li * k, yc, `${Li.toFixed(2)} m`);
    if (hay(4)) s += cota(xb - Ld * k, xb, yc, `${Ld.toFixed(2)} m`) + cota(xb, x1, yc, `${D.apDer.toFixed(2)} m`);
  });
  [['A', xa + 14], ['B', (xa + xb) / 2], ['C', xb - 14]].forEach(([n, x]) => { s += text(x, (top + bot) / 2 + 4, n, '#d97706', 'middle', 'font-weight="bold"'); });
  s += cota(xa, xb, 298, `Ln = ${D.ln.toFixed(2)} m`);
  s += text(x0, 20, `Estribos ϕ ${BARS[D.estribo].t}: ${R.distribucion}`, '#111', 'start', 'font-weight="bold"');
  return svg(W, H, s);
}

export function seccion(D, R, i, nombre) { // i: 0 = A (izq), 2 = B (medio), 4 = C (der)
  const W = 290, H = 300, k = Math.min(150 / D.b, 220 / D.h);
  const bw = D.b * k, hw = D.h * k, x = (W - bw) / 2, y = 40;
  const est = BARS[D.estribo], r = D.rec * k;
  let s = text(W / 2, 20, `CORTE ${nombre}-${nombre}`, '#111', 'middle', 'font-weight="bold"');
  s += `<rect x="${x}" y="${y}" width="${bw}" height="${hw}" fill="#f1f5f9" stroke="#111"/>`;
  s += `<rect x="${x + r}" y="${y + r}" width="${bw - 2 * r}" height="${hw - 2 * r}" rx="5" fill="none" stroke="#111" stroke-width="1.8"/>`;
  [0, 1].forEach((f) => {
    const bars = D.barras[i + f].flatMap((v, gi) => Array(Math.max(0, v.n)).fill({ d: BARS[v.id].d, c: gi ? '#1d4ed8' : '#b91c1c' }));
    // Dos capas: las corridas van en la primera y los bastones debajo. Sin bastones, solo se
    // parte en dos si las barras no caben en una fila.
    const nCorr = Math.max(0, D.barras[i + f][0].n);
    const ancho = 2 * (D.rec + est.d) + bars.reduce((t, x) => t + x.d, 0) + bars.slice(1).reduce((t, x) => t + Math.max(x.d, 2.5), 0);
    let filas = [bars];
    if (D.capas === 2 && nCorr > 0 && bars.length > nCorr) filas = [bars.slice(0, nCorr), bars.slice(nCorr)];
    else if (D.capas === 2 && ancho > D.b) filas = [bars.slice(0, Math.ceil(bars.length / 2)), bars.slice(Math.ceil(bars.length / 2))];
    for (let row = 0; row < filas.length; row++) {
      const fila = filas[row];
      fila.forEach((bar, j) => {
        const rr = bar.d * k / 2;
        const ini = x + r + est.d * k + rr, fin = x + bw - r - est.d * k - rr;
        const cx = fila.length === 1 ? W / 2 : ini + (fin - ini) * j / (fila.length - 1);
        const off = r + est.d * k + rr + row * (bar.d + 2.5) * k;
        s += `<circle cx="${cx}" cy="${f ? y + off : y + hw - off}" r="${rr}" fill="${bar.c}"/>`;
      });
    }
  });
  s += text(W / 2, y - 6, etiqueta(D.barras[i + 1]));
  s += text(W / 2, y + hw + 16, etiqueta(D.barras[i]));
  s += text(W / 2, y + hw + 34, `${D.b} × ${D.h} cm`, '#555');
  return svg(W, H, s);
}

export function cortante(D, R) {
  const W = 900, H = 230, m = 70, mid = 110;
  const k = (W - 2 * m) / D.ln;
  const vi = [R.Viso + R.V2, R.Viso + R.V1];
  const max = Math.max(R.caraMaxIzq, R.caraMaxDer, 0.001), ky = 80 / max;
  const y = (v) => mid - v * ky;
  const L = D.ln, w = R.wu;
  // Sentido antihorario (V1) y horario (V2), con el signo real a lo largo de la luz.
  const diag = [[R.Viso + R.V1, R.Viso + R.V1 - w * L, '#b91c1c'], [R.Viso - R.V2, R.Viso - R.V2 - w * L, '#1d4ed8']];
  let s = line(m, mid, W - m, mid);
  diag.forEach(([a, b, c]) => {
    s += `<polygon points="${m},${mid} ${m},${y(a)} ${m + L * k},${y(b)} ${W - m},${mid}" fill="${c}" fill-opacity="0.12" stroke="${c}"/>`;
    s += text(m - 6, y(a) + 4, `${a.toFixed(2)} t`, c, 'end') + text(W - m + 6, y(b) + 4, `${b.toFixed(2)} t`, c, 'start');
  });
  const xd = m + R.d / 100 * k;
  s += line(xd, 20, xd, 200, '#d97706', 1.2, 'stroke-dasharray="5 3"') + text(xd + 4, 28, 'a "d" del apoyo', '#d97706', 'start');
  s += text(W / 2, 222, `Rojo: momentos antihorarios · Azul: horarios · Vu diseño = ${R.Vu.toFixed(2)} t (máx. en cara = ${Math.max(...vi).toFixed(2)} t)`);
  return svg(W, H, s);
}
/** Envolvente de ETABS de la viga cargada (momento y cortante). Devuelve '' si no hay datos. */
export function envolvente(D, R) {
  const E = (Array.isArray(D.envolvente) ? D.envolvente : [])
    .filter((p) => Array.isArray(p) && p.length === 5 && p.every(Number.isFinite));
  if (E.length < 2) return '';
  const W = 900, H = 430, m = 62, mm = 30;
  const L = Math.max(...E.map((p) => p[0]));
  const X = (x) => m + x / L * (W - m - mm);
  const capSup = (i) => D.phi * R.col[i].Mn, capInf = D.phi * R.col[2].Mn;
  const maxM = Math.max(capSup(1), capSup(5), capInf, ...E.map((p) => Math.max(Math.abs(p[1]), Math.abs(p[2])))) * 1.15;
  const maxV = Math.max(...E.map((p) => Math.max(Math.abs(p[3]), Math.abs(p[4]))), 0.1) * 1.5;
  const yM = (v) => 160 + v / maxM * 120; // positivo hacia abajo
  const yV = (v) => 355 - v / maxV * 50;
  const curva = (k, y, c) => `<polygon points="${X(E[0][0])},${y(0)} ${E.map((p) => `${X(p[0])},${y(p[k])}`).join(' ')} ${X(E[E.length - 1][0])},${y(0)}" fill="${c}" fill-opacity="0.12"/>`
    + `<polyline points="${E.map((p) => `${X(p[0])},${y(p[k])}`).join(' ')}" fill="none" stroke="${c}" stroke-width="2"/>`;
  const rojo = '#e34948', azul = '#2a78d6', gris = '#52514e', raya = 'stroke-dasharray="6 4"';
  let s = text(m, 18, 'Momento (tnf·m)', '#111', 'start', 'font-weight="bold"') + text(m, 292, 'Cortante (tnf)', '#111', 'start', 'font-weight="bold"');
  s += curva(1, yM, rojo) + curva(2, yM, azul) + curva(3, yV, rojo) + curva(4, yV, azul);
  s += line(m, yM(0), W - mm, yM(0)) + line(m, yV(0), W - mm, yV(0));
  // Resistencia φMn: arriba cambia donde terminan los bastones.
  const a = Math.min(R.Lb1, L / 2), b = Math.max(L - R.Lb2, L / 2);
  const sup = [[0, capSup(1)], [a, capSup(1)], [a, capSup(3)], [b, capSup(3)], [b, capSup(5)], [L, capSup(5)]];
  s += `<polyline points="${sup.map(([x, v]) => `${X(x)},${yM(-v)}`).join(' ')}" fill="none" stroke="${gris}" stroke-width="1.3" ${raya}/>`;
  s += line(X(0), yM(capInf), X(L), yM(capInf), gris, 1.3, raya);
  [[E[0], 'start', 4], [E[E.length - 1], 'end', -4]].forEach(([p, anc, dx]) => {
    s += text(X(p[0]) + dx, yM(p[1]) - 5, p[1].toFixed(2), '#111', anc) + text(X(p[0]) + dx, yM(p[2]) - 5, p[2].toFixed(2), '#111', anc);
    s += text(X(p[0]) + dx, yV(p[3]) + 14, p[3].toFixed(2), '#111', anc) + text(X(p[0]) + dx, yV(p[4]) - 5, p[4].toFixed(2), '#111', anc);
  });
  for (let x = 0; x <= L + 1e-9; x += 0.5) s += line(X(x), 406, X(x), 411, gris) + text(X(x), 424, x.toFixed(1), gris);
  s += line(m, 406, W - mm, 406, gris) + text(W - mm, 292, 'x desde la cara izquierda (m)', gris, 'end');
  s += line(330, 14, 352, 14, rojo, 3) + text(357, 18, 'mínimo', '#111', 'start') + line(430, 14, 452, 14, azul, 3) + text(457, 18, 'máximo', '#111', 'start');
  s += line(530, 14, 556, 14, gris, 1.3, raya) + text(561, 18, 'resistencia φMn', '#111', 'start');
  return svg(W, H, s);
}

