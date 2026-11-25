/** Motor de la viga sísmica (E.060 cap. 21), con la secuencia de la hoja "DISEÑO DE VIGA SÍSMICA".
 *  Unidades: cm, kg/cm², tonf, tonf·m, m (luz y longitudes de detalle). */
export const BARS = {
  '8mm': { a: 0.50, d: 0.80, kgm: 0.395, t: '8 mm' },
  '1/4': { a: 0.32, d: 0.64, kgm: 0.250, t: '1/4"' },
  '3/8': { a: 0.71, d: 0.95, kgm: 0.560, t: '3/8"' },
  '1/2': { a: 1.29, d: 1.27, kgm: 0.994, t: '1/2"' },
  '5/8': { a: 1.98, d: 1.59, kgm: 1.552, t: '5/8"' },
  '3/4': { a: 2.85, d: 1.91, kgm: 2.235, t: '3/4"' },
  '1':   { a: 5.10, d: 2.54, kgm: 3.973, t: '1"' },
  '1-3/8': { a: 10.06, d: 3.58, kgm: 7.907, t: '1-3/8"' },
};
// Orden de las 6 columnas de la hoja.
export const POS = ['izqInf', 'izqSup', 'medInf', 'medSup', 'derInf', 'derSup'];
const g = (n, id) => ({ n, id });

export const DEFAULTS = {
  proyecto: '', ubicacion: '', elemento: 'VIGA EJE B, ENTRE EJES 5-6', autor: 'Ing. Dan Oliden', fecha: '',
  sistema: 'muros', fc: 210, fy: 4200, phi: 0.9, capas: 2, estribo: '3/8', ramas: 2, rec: 4, dp: 5,
  b: 30, h: 45, ln: 3.93, apIzq: 0.60, apDer: 0.60,
  mu: [3.12, 6.97, 2.45, 2.45, 2.81, 5.17],
  barras: POS.map(() => [g(4, '1/2'), g(0, '1/2'), g(0, '1/2')]),
  trib: 2.5, losa: 0.30, acab: 0.10, tabiq: 0.15, sc: 0.25, vu25: 0,
  x1: 0.67, x2: 0.08, lb1: 0, lb2: 0, // lb: longitud fijada (m); 0 = automática
};

const sum = (a) => a.reduce((s, v) => s + v, 0);
const floorTo = (v, step) => Math.floor(v / step + 1e-9) * step;

export function calcular(D) {
  const { fc, fy, phi, b, h, ln } = D;
  const d = h - D.dp;
  const beta1 = fc <= 280 ? 0.85 : Math.max(0.65, 0.85 - 0.05 * (fc - 280) / 70);
  const rhoMin = 0.7 * Math.sqrt(fc) / fy;
  const rhoMax = 0.75 * 0.85 * beta1 * (fc / fy) * 6000 / (6000 + fy);
  const est = BARS[D.estribo];

  const col = POS.map((_, i) => {
    const Mu = Math.abs(D.mu[i] || 0);
    const disc = d * d - 2 * Mu * 1e5 / (phi * 0.85 * fc * b);
    const insuf = disc < 0;
    const aCalc = d - Math.sqrt(Math.max(0, disc));
    const AsCalc = insuf ? NaN : Mu * 1e5 / (phi * fy * (d - aCalc / 2));
    const AsMin = rhoMin * b * d, AsMax = rhoMax * b * d;
    const AsReq = insuf ? NaN : Math.max(AsMin, AsCalc);
    const grupos = D.barras[i].filter((x) => x.n > 0);
    const lista = grupos.flatMap((x) => Array(x.n).fill(BARS[x.id].d)).sort((p, q) => q - p);
    const As = sum(grupos.map((x) => x.n * BARS[x.id].a));
    const a = As * fy / (0.85 * fc * b);
    const Mn = fy * (d - a / 2) * As / 1e5;
    const Mpr = 1.25 * fy * (d - 1.25 * a / 2) * As / 1e5;
    const porCapa = lista.slice(0, Math.ceil(lista.length / D.capas));
    const ancho = porCapa.length
      ? 2 * D.rec + 2 * est.d + sum(porCapa) + (porCapa.length - 1) * Math.max(2.54, porCapa[0]) : 0;
    return {
      Mu, aCalc, AsCalc, AsMin, AsMax, AsReq, As, a, Mn, Mpr, rho: As / (b * d), ancho, insuf,
      okAs: !insuf && As >= AsReq - 1e-9, okCuantia: As >= AsMin - 1e-9 && As <= AsMax + 1e-9, okAncho: ancho <= b + 1e-9,
    };
  });

  // --- Capítulo 21: momentos resistentes mínimos
  const porticos = D.sistema === 'porticos';
  const frac = porticos ? 1 / 2 : 1 / 3;
  const MnMaxCara = Math.max(col[0].Mn, col[1].Mn, col[4].Mn, col[5].Mn);
  const caraIzq = col[0].Mn >= frac * col[1].Mn - 1e-9;
  const caraDer = col[4].Mn >= frac * col[5].Mn - 1e-9;
  const cuarto = col.map((c) => c.Mn >= MnMaxCara / 4 - 1e-9);

  // --- Metrado y cortante por capacidad
  const pp = 2.4 * (b / 100) * (h / 100);
  const CM = pp + (D.losa + D.acab + D.tabiq) * D.trib;
  const CV = D.sc * D.trib;
  const wu = 1.25 * (CM + CV);
  const Viso = wu * ln / 2;
  const M = (i) => (porticos ? col[i].Mpr : col[i].Mn);
  const V1 = (M(1) + M(4)) / ln; // antihorario: superior izq. + inferior der.
  const V2 = (M(0) + M(5)) / ln; // horario: inferior izq. + superior der.
  const caraMaxIzq = Viso + V1, caraMaxDer = Viso + V2;
  const Vcara = Math.max(caraMaxIzq, caraMaxDer);
  const VuCap = Math.max(0, Vcara - wu * d / 100);
  const usa25 = !porticos && D.vu25 > 0 && D.vu25 < VuCap;
  const Vu = usa25 ? D.vu25 : VuCap;

  const Vc = 0.53 * Math.sqrt(fc) * b * d / 1000;
  const phiVc = 0.85 * Vc;
  const Av = est.a * D.ramas;
  const Vs = Math.max(0, Vu / 0.85 - Vc);
  const sCalc = Vs > 0 ? Av * fy * d / (Vs * 1000) : Infinity;
  const VsMax = 2.1 * Math.sqrt(fc) * b * d / 1000;
  const VsLim = 1.1 * Math.sqrt(fc) * b * d / 1000;
  const sAvMin = Av * fy / (Math.max(0.2 * Math.sqrt(fc), 3.5) * b);
  const sMax = Vs <= VsLim ? Math.min(d / 2, 60) : Math.min(d / 4, 30);

  const usadas = D.barras.flat().filter((x) => x.n > 0).map((x) => BARS[x.id].d);
  const dbMin = usadas.length ? Math.min(...usadas) : 0;
  const dbMax = usadas.length ? Math.max(...usadas) : 0;
  const factorDb = porticos ? 8 : 10;
  const limites = { d4: d / 4, db: factorDb * dbMin, de: 24 * est.d, max: 30 };
  const sConfLim = Math.min(...Object.values(limites), sCalc, sMax, sAvMin);
  const sConf = floorTo(sConfLim, 2.5);
  const Lconf = 2 * h; // cm
  const V2h = Math.max(0, Vcara - wu * Lconf / 100);
  const Vs2h = Math.max(0, Math.min(V2h, Vu) / 0.85 - Vc);
  const sRestoLim = Math.min(d / 2, 60, sAvMin, Vs2h > 0 ? Av * fy * d / (Vs2h * 1000) : Infinity, Vs2h > VsLim ? Math.min(d / 4, 30) : Infinity);
  const sResto = floorTo(sRestoLim, 2.5);
  const todoConfinado = 2 * Lconf >= ln * 100;
  const s0 = 5;
  const nConf = sConf > 0 ? Math.ceil((Lconf - s0) / sConf - 1e-9) : 0;
  const nTodo = sConf > 0 ? Math.ceil((ln * 100 / 2 - s0) / sConf - 1e-9) : 0;
  const m = (cm) => (cm / 100).toFixed(cm % 5 ? 3 : 2).replace(/^0/, '');
  const distribucion = sConf <= 0 ? 'Sección insuficiente'
    : todoConfinado ? `1@${m(s0)}, ${nTodo}@${m(sConf)} desde cada extremo (toda la viga confinada)`
      : `1@${m(s0)}, ${nConf}@${m(sConf)}, rto. @${m(sResto)} a/e`;
  const diamMin = porticos || dbMax > 1.59 + 1e-9 ? 0.95 : 0.80;

  // --- Bastones (criterio de la hoja: x + máx(12db, d), redondeado a 0.50 m)
  const dbRef = dbMax / 100;
  const Lb = (x) => Math.ceil((x + Math.max(12 * dbRef, d / 100)) / 0.5 - 1e-9) * 0.5;
  const Lb1 = D.lb1 > 0 ? D.lb1 : Lb(D.x1), Lb2 = D.lb2 > 0 ? D.lb2 : Lb(D.x2);

  const avisos = [];
  col.forEach((c, i) => {
    const n = ['Izq. inferior', 'Izq. superior', 'Medio inferior', 'Medio superior', 'Der. inferior', 'Der. superior'][i];
    if (c.insuf) avisos.push(`${n}: la sección no resiste Mu.`);
    else if (!c.okAs) avisos.push(`${n}: As provisto menor que el requerido.`);
    if (c.As > c.AsMax) avisos.push(`${n}: As mayor que el máximo.`);
    if (!c.okAncho) avisos.push(`${n}: las barras no caben en el ancho.`);
    if (!cuarto[i]) avisos.push(`${n}: Mn menor que Mn máx/4.`);
  });
  if (!caraIzq) avisos.push('Nudo izquierdo: Mn(+) menor que la fracción de Mn(−) exigida.');
  if (!caraDer) avisos.push('Nudo derecho: Mn(+) menor que la fracción de Mn(−) exigida.');
  if (Vs > VsMax) avisos.push('Cortante: Vs excede el máximo; aumentar la sección.');
  if (sConf < 5 || sResto < 5) avisos.push('Estribos a menos de 5 cm: cambiar diámetro, ramas o sección.');
  if (est.d < diamMin - 1e-9) avisos.push(`Estribo menor que el mínimo para este caso (${diamMin === 0.95 ? '3/8"' : '8 mm'}).`);
  [0, 1].forEach((face) => {
    const ids = [0, 2, 4].map((i) => { const x = D.barras[i + face][0]; return `${x.n}-${x.id}`; });
    if (new Set(ids).size > 1) avisos.push(`El 1.er grupo (barras corridas) ${face ? 'superior' : 'inferior'} debe ser igual en las tres secciones.`);
  });
  const bwOk = b >= 25 && b >= 0.25 * d;
  if (!bwOk) avisos.push('Ancho bw menor que el mínimo (25 cm y 0.25d).');
  if (ln / (h / 100) < 4) avisos.push('Ln/h menor que 4: revisar los límites geométricos del cap. 21 (viga corta).');

  return {
    d, beta1, rhoMin, rhoMax, col, frac, caraIzq, caraDer, cuarto, MnMaxCara, porticos, bwOk,
    pp, CM, CV, wu, Viso, V1, V2, caraMaxIzq, caraMaxDer, Vcara, VuCap, Vu, usa25,
    Vc, phiVc, Av, Vs, sCalc, VsMax, VsLim, sAvMin, sMax, limites, factorDb, dbMin, dbMax,
    sConf, sResto, Lconf, s0, nConf, todoConfinado, distribucion, Lb1, Lb2, avisos,
  };
}

/** Posiciones de estribos (m) desde la cara izquierda. */
export function posicionesEstribos(D, R) {
  const L = D.ln, out = new Set();
  const lc = R.todoConfinado ? L / 2 : R.Lconf / 100;
  const sc = Math.max(R.sConf, 2.5) / 100, sr = Math.max(R.sResto, 2.5) / 100;
  let x = R.s0 / 100;
  out.add(x);
  while (x < lc - 1e-9 && x + sc <= L / 2 + 1e-9) { x += sc; out.add(x); }
  while (!R.todoConfinado && x + sr <= L / 2 + 1e-9) { x += sr; out.add(x); }
  [...out].forEach((v) => out.add(L - v));
  return [...new Set([...out].map((v) => +v.toFixed(3)))].sort((p, q) => p - q);
}

/** Metrado de acero. Barras corridas: 1.er grupo; bastones: 2.º y 3.er grupo. */
export function metrado(D, R) {
  const rows = [];
  const rec = D.rec / 100, empalme = (db) => Math.max(0.30, 1.3 * 1.3 * D.fy / (6.6 * Math.sqrt(D.fc)) * db / 100);
  const add = (desc, id, n, L) => { if (n > 0) rows.push({ desc, id, n, L, kg: n * L * BARS[id].kgm }); };
  [['inferior', 0], ['superior', 1]].forEach(([name, f]) => {
    const c = D.barras[f][0];
    const base = D.ln + D.apIzq + D.apDer - 2 * rec + 2 * 12 * BARS[c.id].d / 100;
    const lap = empalme(BARS[c.id].d);
    const ne = base > 9 ? Math.ceil((base - 9) / (9 - lap)) : 0;
    add(`Corridas ${name}es${ne ? ` (${ne} empalme)` : ''}`, c.id, c.n, base + ne * lap);
    [['izquierdo', 0, R.Lb1, D.apIzq], ['central', 2, D.ln / 2, 0], ['derecho', 4, R.Lb2, D.apDer]].forEach(([z, i, L, ap]) => {
      D.barras[i + f].slice(1).forEach((x) => add(`Bastón ${name} ${z}`, x.id, x.n,
        ap ? L + ap - rec + 12 * BARS[x.id].d / 100 : L));
    });
  });
  const est = BARS[D.estribo];
  const per = 2 * (D.b - 2 * D.rec + D.h - 2 * D.rec) / 100 + 2 * Math.max(0.075, 6 * est.d / 100);
  add('Estribos cerrados', D.estribo, posicionesEstribos(D, R).length, per);
  return { rows, total: sum(rows.map((r) => r.kg)) };
}
