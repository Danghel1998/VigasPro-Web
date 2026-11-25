/** Interfaz tipo hoja de cálculo de la viga sísmica. */
import { BARS, POS, DEFAULTS, calcular, metrado } from './engine.js';
import { elevacion, seccion, cortante, etiqueta, envolvente, dibujoFinal } from './dibujos.js';
import { memoriaHtml, MEMORIA_CSS, f, esc, NOMBRES, SISTEMAS } from './memoria.js';

const KEY = 'vigaspro_sismica';
const clone = (o) => JSON.parse(JSON.stringify(o));
let D = clone(DEFAULTS), R;
try { D = { ...D, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch (e) { /* sin almacenamiento */ }

const $ = (id) => document.getElementById(id);
const get = (p) => p.split('.').reduce((o, k) => o?.[k], D);
const set = (p, v) => { const k = p.split('.'); const last = k.pop(); k.reduce((o, x) => o[x], D)[last] = v; };

// --- celdas de entrada y de salida
const num = (p, step = 'any') => `<input type="number" step="${step}" min="0" data-p="${p}" aria-label="${p}">`;
const txt = (p) => `<input type="text" data-p="${p}" aria-label="${p}">`;
const sel = (p, opts) => `<select data-p="${p}" aria-label="${p}">${opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>`;
const out = (k) => `<span data-o="${k}"></span>`;
const fila = (label, content, unit = '', cls = '') => `<tr class="${cls}"><th>${label}</th><td>${content}</td><td class="u">${unit}</td></tr>`;
const barOpts = Object.entries(BARS).map(([k, v]) => [k, v.t]);
const seis = (label, fn, cls = '') => `<tr class="${cls}"><th>${label}</th>${POS.map((_, i) => `<td>${fn(i)}</td>`).join('')}</tr>`;
const titulo = (t) => `<h2>${t}</h2>`;

function plantilla() {
  return `
<section>${titulo('DATOS')}
 <div class="grid3">
  <table>${fila("f'c", num('fc'), 'kg/cm²')}${fila('fy', num('fy'), 'kg/cm²')}${fila('φ flexión', num('phi'))}${fila('Armadura', sel('capas', [[1, 'Una capa'], [2, 'Dos capas']]))}${fila('Estribos ϕ', sel('estribo', barOpts.slice(0, 4)))}${fila('Ramas', num('ramas', 1))}${fila('Recubrimiento', num('rec'), 'cm')}</table>
  <table>${fila('b', num('b'), 'cm')}${fila('h', num('h'), 'cm')}${fila("d'", num('dp'), 'cm')}${fila('d', out('d'), 'cm')}${fila('β1', out('beta1'))}${fila('Luz libre Ln', num('ln'), 'm')}${fila('Apoyo izq. / der.', `<div class="par">${num('apIzq')}${num('apDer')}</div>`, 'm')}</table>
  <table>${fila('Sistema', sel('sistema', Object.entries(SISTEMAS)))}${fila('Proyecto', txt('proyecto'))}${fila('Ubicación', txt('ubicacion'))}${fila('Elemento', txt('elemento'))}${fila('Diseñado por', txt('autor'))}${fila('Fecha', txt('fecha'))}${fila('bw mínimo / Ln/h', `${out('bwOk')} · ${out('lnh')}`)}</table>
 </div>
</section>
<section data-env>${titulo('ENVOLVENTE ETABS')}<div class="dib" data-o="svgEnv"></div></section>
<section>${titulo('DISEÑO POR FLEXIÓN')}
 <div class="scroll"><table class="seis">
  <thead><tr><th rowspan="2"></th><th colspan="2">Nudo Izq</th><th colspan="2">Medio</th><th colspan="2">Nudo Der</th></tr><tr>${NOMBRES.map((n) => `<th>${n}</th>`).join('')}</tr></thead>
  ${seis('Mu (tnf·m)', (i) => num(`mu.${i}`, 0.01), 'mu')}
  ${seis('a (cm)', (i) => out(`aCalc${i}`))}${seis('As calc (cm²)', (i) => out(`AsCalc${i}`), 'rosa')}${seis('As mín (cm²)', (i) => out(`AsMin${i}`))}${seis('As máx (cm²)', (i) => out(`AsMax${i}`))}${seis('As req (cm²)', (i) => out(`AsReq${i}`), 'amarillo')}
  ${[0, 1, 2].map((k) => seis(k ? `Bastón ${k} (N° / ϕ)` : 'Corridas (N° / ϕ)', (i) => `<div class="par">${num(`barras.${i}.${k}.n`, 1)}${sel(`barras.${i}.${k}.id`, barOpts)}</div>`, 'barras')).join('')}
  ${seis('As colocado (cm²)', (i) => out(`As${i}`), 'amarillo')}${seis('a (cm)', (i) => out(`a${i}`))}${seis('Mn (tnf·m)', (i) => out(`Mn${i}`), 'rosa')}${seis('ρ', (i) => out(`rho${i}`))}
  ${seis('As ≥ As req', (i) => out(`okAs${i}`))}${seis('Cuantía', (i) => out(`okCuantia${i}`))}${seis('Ancho', (i) => out(`okAncho${i}`))}${seis('Mn ≥ Mn máx/4', (i) => out(`cuarto${i}`))}
  <tr><th>Mn(+) ≥ <span data-o="frac"></span>·Mn(−)</th><td colspan="2">${out('caraIzq')}</td><td colspan="2"></td><td colspan="2">${out('caraDer')}</td></tr>
 </table></div>
</section>
<section>${titulo('DISEÑO POR CORTANTE')}
 <div class="grid3">
  <table><caption>Metrado de cargas</caption>${fila('Ancho tributario', num('trib'), 'm')}${fila('Peso propio', out('pp'), 't/m')}${fila('Losa', num('losa'), 't/m²')}${fila('Acabados', num('acab'), 't/m²')}${fila('Tabiquería', num('tabiq'), 't/m²')}${fila('S/C (E.020)', num('sc'), 't/m²')}${fila('CM', out('CM'), 't/m')}${fila('CV', out('CV'), 't/m')}${fila('wu = 1.25(CM+CV)', out('wu'), 't/m', 'amarillo')}</table>
  <table><caption>Cortante por capacidad</caption>${fila('V isostático', out('Viso'), 't')}${fila('V antihorario', out('V1'), 't')}${fila('V horario', out('V2'), 't')}${fila('V máx en cara', out('Vcara'), 't')}${fila('V sismo ×2.5 (opcional)', num('vu25'), 't')}${fila('Vu de diseño (a "d")', out('Vu'), 't', 'amarillo')}${fila('Vc', out('Vc'), 't')}${fila('φVc', out('phiVc'), 't')}${fila('Vs', out('Vs'), 't')}</table>
  <table><caption>Estribos</caption>${fila('Av', out('Av'), 'cm²')}${fila('s por resistencia', out('sCalc'), 'cm')}${fila('Vs máx', out('VsMax'), 't')}${fila('Zona confinada 2h', out('Lconf'), 'cm')}${fila('d/4', out('d4'), 'cm')}${fila('<span data-o="factorDb"></span>·db', out('db'), 'cm')}${fila('24·de', out('de'), 'cm')}${fila('s confinamiento', out('sConf'), 'cm', 'amarillo')}${fila('s resto', out('sResto'), 'cm', 'amarillo')}</table>
 </div>
 <div class="resultado">Estribos ϕ ${out('estriboT')}: ${out('distribucion')}</div>
 <div class="dib" data-o="svgCortante"></div>
</section>
<section>${titulo('DISEÑO POR TORSIÓN')}
 <div class="grid3">
  <table><caption>Datos y sección</caption>${fila('Tipo de torsión', sel('tipoTorsion', [['equilibrio', 'De equilibrio'], ['compatibilidad', 'De compatibilidad']]))}${fila('Acp / pcp', out('acp'), 'cm² / cm')}${fila('Aoh / Ao', out('aoh'), 'cm²')}${fila('ph', out('ph'), 'cm')}${fila('Umbral (se desprecia)', out('Tth'), 't·m')}${fila('φ·Tcr', out('phiTcr'), 't·m')}</table>
  <table><caption>Sección V + T</caption>${fila('Esfuerzo combinado', out('esf'), 'kg/cm²')}${fila('Máximo permitido', out('esfMax'), 'kg/cm²')}${fila('Sección', out('okSeccion'))}${fila('s máx (ph/8, 30)', out('sMaxT'), 'cm')}</table>
  <table><caption>Acero lateral</caption>${fila('Requerido', out('latReq'), 'cm²', 'amarillo')}${fila('Colocado (en "Detalle de armado")', out('AsLat'), 'cm²')}${fila('Área', out('okLat'))}${fila('Separación ≤ 30 cm', out('okSep'))}${fila('Diámetro mínimo', out('okDb'))}</table>
 </div>
 <div class="scroll"><table class="seis">
  <thead><tr><th></th><th>Zona izq. (0 a 2h)</th><th>Centro</th><th>Zona der. (0 a 2h)</th></tr></thead>
  <tr class="mu"><th>Tu de ETABS (tnf·m)</th>${[0, 1, 2].map((z) => `<td>${num(`tu.${z}`, 0.01)}</td>`).join('')}</tr>
  ${[['Tu de diseño (tnf·m)', 'tTd'], ['¿Se considera?', 'tAp'], ['At/s por rama (cm²/cm)', 'tAts'], ['Al por Tu (cm²)', 'tAl'], ['Al mínimo (cm²)', 'tAlMin'], ['Al requerido (cm²)', 'tAlReq'], ['Sobra de flexión abajo (cm²)', 'tInf'], ['Sobra de flexión arriba (cm²)', 'tSup'], ['Lateral requerido (cm²)', 'tLat']].map(([t, k]) => `<tr><th>${t}</th>${[0, 1, 2].map((z) => `<td>${out(k + z)}</td>`).join('')}</tr>`).join('')}
 </table></div>
</section>
<section>${titulo('DETALLE DE ARMADO')}
 <table class="corto">${fila('Distancia al punto de inflexión izq. (x1)', num('x1', 0.01), 'm')}${fila('Distancia al punto de inflexión der. (x2)', num('x2', 0.01), 'm')}${fila('Fijar longitud izq. / der. (0 = automática)', `<div class="par">${num('lb1', 0.05)}${num('lb2', 0.05)}</div>`, 'm')}${fila('Acero lateral (N° / ϕ)', `<div class="par">${num('lat.n', 1)}${sel('lat.id', barOpts)}</div>`)}${fila('Nombre en el plano', txt('tipo'))}${fila('Estribos del dibujo final (vacío = calculados)', txt('estribosFinal'))}${fila('Bastón izq. / der.', out('Lb'), 'm', 'amarillo')}</table>
 <div class="dib" data-o="svgElev"></div>
 <div class="cortes"><div data-o="svgA"></div><div data-o="svgB"></div><div data-o="svgC"></div></div>
 <div class="dib" data-o="svgFinal"></div>
</section>
<section>${titulo('METRADO DE ACERO')}<div class="scroll" data-o="metrado"></div></section>`;
}

const ok = (b) => `<b class="${b ? 'ok' : 'mal'}">${b ? 'OK' : 'CORREGIR'}</b>`;

function render() {
  R = calcular(D);
  const o = {
    d: f(R.d), beta1: f(R.beta1), bwOk: ok(R.bwOk), lnh: f(D.ln / (D.h / 100)),
    frac: R.porticos ? '1/2' : '1/3', caraIzq: ok(R.caraIzq), caraDer: ok(R.caraDer),
    pp: f(R.pp, 3), CM: f(R.CM, 3), CV: f(R.CV, 3), wu: f(R.wu, 3), Viso: f(R.Viso), V1: f(R.V1), V2: f(R.V2), Vcara: f(R.Vcara),
    Vu: f(R.Vu), Vc: f(R.Vc), phiVc: f(R.phiVc), Vs: f(R.Vs), Av: f(R.Av), sCalc: R.sCalc > 999 ? '> 999' : f(R.sCalc, 1), VsMax: f(R.VsMax),
    Lconf: R.Lconf, d4: f(R.limites.d4), factorDb: R.factorDb, db: f(R.limites.db), de: f(R.limites.de), sConf: R.sConf, sResto: R.todoConfinado ? '—' : R.sResto,
    estriboT: BARS[D.estribo].t, distribucion: R.distribucion, Lb: `${f(R.Lb1)} / ${f(R.Lb2)}`,
    svgEnv: envolvente(D, R), svgFinal: dibujoFinal(D, R), svgCortante: cortante(D, R), svgElev: elevacion(D, R), svgA: seccion(D, R, 0, 'A'), svgB: seccion(D, R, 2, 'B'), svgC: seccion(D, R, 4, 'C'),
  };
  const T = R.T;
  Object.assign(o, {
    acp: `${f(T.Acp, 0)} / ${f(T.pcp, 0)}`, aoh: `${f(T.Aoh, 0)} / ${f(T.Ao, 0)}`, ph: f(T.ph, 1), Tth: f(T.Tth), phiTcr: f(T.phiTcr),
    esf: f(T.esf, 1), esfMax: f(T.esfMax, 1), okSeccion: ok(T.okSeccion), sMaxT: f(T.sMax, 1),
    latReq: f(T.latReq), AsLat: f(T.AsLat), okLat: ok(T.okLat), okSep: ok(T.okSep), okDb: ok(T.okDb),
  });
  T.zonas.forEach((z, i) => {
    Object.assign(o, { [`tTd${i}`]: f(z.Td), [`tAp${i}`]: z.aplica ? 'Sí' : 'No', [`tAts${i}`]: f(z.Ats, 4), [`tAl${i}`]: f(z.Al), [`tAlMin${i}`]: f(z.AlMin), [`tAlReq${i}`]: f(z.AlReq), [`tInf${i}`]: f(z.excInf), [`tSup${i}`]: f(z.excSup), [`tLat${i}`]: f(z.latReq) });
  });
  document.querySelector('[data-env]').hidden = !o.svgEnv;
  R.col.forEach((c, i) => {
    ['aCalc', 'AsCalc', 'AsMin', 'AsMax', 'AsReq', 'As', 'a', 'Mn'].forEach((k) => { o[k + i] = f(c[k]); });
    o[`rho${i}`] = f(c.rho, 5);
    ['okAs', 'okCuantia', 'okAncho'].forEach((k) => { o[k + i] = ok(c[k]); });
    o[`cuarto${i}`] = ok(R.cuarto[i]);
  });
  const mt = metrado(D, R);
  o.metrado = `<table><tr><th>Descripción</th><th>ϕ</th><th>N°</th><th>Long. (m)</th><th>Peso (kg)</th></tr>${mt.rows.map((r) => `<tr><td>${r.desc}</td><td>${BARS[r.id].t}</td><td>${r.n}</td><td>${f(r.L)}</td><td>${f(r.kg, 1)}</td></tr>`).join('')}<tr class="amarillo"><th colspan="4">Total</th><td>${f(mt.total, 1)}</td></tr></table>`;
  document.querySelectorAll('[data-o]').forEach((el) => { el.innerHTML = o[el.dataset.o] ?? ''; });
  const st = $('estado');
  st.className = R.avisos.length ? 'mal' : 'ok';
  st.textContent = R.avisos.length ? `⚠ ${R.avisos.join('  |  ')}` : `✔ La viga cumple las verificaciones de flexión, cortante${R.T.datos ? ', torsión' : ''} y capítulo 21.${R.T.datos ? '' : ' (Torsión sin verificar: falta ingresar Tu.)'}`;
  $('memoria').innerHTML = memoriaHtml(D, R);
  try { localStorage.setItem(KEY, JSON.stringify(D)); } catch (e) { /* sin almacenamiento */ }
}

function fill() { document.querySelectorAll('[data-p]').forEach((el) => { el.value = get(el.dataset.p); }); }

function descargar(nombre, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nombre;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const nombreArchivo = () => (D.elemento || 'viga').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '');

/** Word no dibuja bien SVG en línea: se convierten a PNG antes de exportar. */
async function svgAPng(svgEl) {
  const w = +svgEl.getAttribute('width'), h = +svgEl.getAttribute('height');
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svgEl))}`;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = w * 2; c.height = h * 2;
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const out2 = document.createElement('img');
  const ancho = w > 400 ? 620 : 200;
  out2.src = c.toDataURL('image/png');
  out2.setAttribute('width', ancho); out2.setAttribute('height', Math.round(h * ancho / w));
  return out2;
}

async function descargarWord() {
  const copia = $('memoria').cloneNode(true);
  const originales = [...$('memoria').querySelectorAll('svg')], copias = [...copia.querySelectorAll('svg')];
  for (let i = 0; i < originales.length; i++) copias[i].replaceWith(await svgAPng(originales[i]));
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(D.elemento)}</title><style>${MEMORIA_CSS}</style></head><body>${copia.innerHTML}</body></html>`;
  descargar(`Memoria_${nombreArchivo()}.doc`, new Blob(['﻿', html], { type: 'application/msword' }));
}

function pestana(id) {
  ['hoja', 'memoria'].forEach((p) => {
    $(p).hidden = p !== id;
    $(`tab_${p}`).classList.toggle('activo', p === id);
  });
}

$('hoja').innerHTML = plantilla();
fill();
$('hoja').addEventListener('input', (e) => {
  const p = e.target.dataset.p;
  if (!p) return;
  let v = e.target.value;
  if (e.target.type === 'number') { v = parseFloat(v); if (!Number.isFinite(v)) return; if (/\.n$|^ramas$/.test(p)) v = Math.max(0, Math.min(20, Math.round(v))); }
  if (p === 'capas') v = +v;
  // Evita dividir entre cero mientras se está escribiendo.
  if (['fc', 'fy', 'phi', 'b', 'h', 'ln', 'ramas'].includes(p) && !(v > 0)) return;
  if (p === 'dp' && v >= D.h) return;
  set(p, v);
  render();
});
$('tab_hoja').onclick = () => pestana('hoja');
$('tab_memoria').onclick = () => pestana('memoria');
$('btn_word').onclick = descargarWord;
$('btn_pdf').onclick = () => { pestana('memoria'); window.print(); };
$('btn_guardar').onclick = () => descargar(`${nombreArchivo()}.json`, new Blob([JSON.stringify(D, null, 2)], { type: 'application/json' }));
$('btn_ejemplo').onclick = () => { D = clone(DEFAULTS); fill(); render(); };
$('cargar').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  file.text().then((t) => {
    const previo = D;
    try {
      const j = JSON.parse(t);
      if (!Array.isArray(j.barras) || !Array.isArray(j.mu)) throw new Error('no es un archivo de viga sísmica');
      D = { ...clone(DEFAULTS), ...j }; fill(); render();
    } catch (err) { D = previo; fill(); render(); alert(`No se pudo leer el archivo: ${err.message}`); }
    e.target.value = '';
  });
};
render();
