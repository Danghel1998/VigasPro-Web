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
    const per = Math.ceil(bars.length / D.capas) || 1;
    for (let row = 0; row * per < bars.length; row++) {
      const fila = bars.slice(row * per, (row + 1) * per);
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
