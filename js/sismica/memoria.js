/** Memoria de cálculo (HTML autónomo para imprimir o abrir en Word). */
import { BARS, POS, metrado } from './engine.js';
import { elevacion, seccion, cortante, etiqueta } from './dibujos.js';

export const f = (v, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : '—');
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const NOMBRES = ['M inf', 'M sup', 'M inf', 'M sup', 'M inf', 'M sup'];
export const SISTEMAS = { muros: 'Muros estructurales / Dual Tipo I (E.060 21.4)', porticos: 'Pórticos / Dual Tipo II (E.060 21.5)' };

export function memoriaHtml(D, R) {
  const ok = (b) => `<td class="${b ? 'ok' : 'mal'}">${b ? 'OK' : 'CORREGIR'}</td>`;
  const row = (label, vals) => `<tr><th>${label}</th>${vals.map((v) => `<td>${v}</td>`).join('')}</tr>`;
  const head = `<tr><th rowspan="2">Sección</th><th colspan="2">Nudo izquierdo</th><th colspan="2">Medio</th><th colspan="2">Nudo derecho</th></tr><tr>${NOMBRES.map((n) => `<th>${n}</th>`).join('')}</tr>`;
  const tabla = (rows) => `<table width="100%" border="1" cellspacing="0" cellpadding="3">${rows}</table>`;
  const c = R.col, mt = metrado(D, R);
  const fig = (s) => `<p class="fig">${s}</p>`;
  const lim = R.limites;
  return `
<h1>MEMORIA DE CÁLCULO — DISEÑO DE VIGA SÍSMICA</h1>
${tabla(row('Proyecto', [esc(D.proyecto) || '—']) + row('Ubicación', [esc(D.ubicacion) || '—']) + row('Elemento', [esc(D.elemento)]) + row('Diseñado por', [esc(D.autor)]) + row('Fecha', [esc(D.fecha) || '—']) + row('Sistema', [SISTEMAS[D.sistema]]))}
<h2>1. Datos</h2>
${tabla(row("f'c", [`${D.fc} kg/cm²`]) + row('fy', [`${D.fy} kg/cm²`]) + row('b × h', [`${D.b} × ${D.h} cm`]) + row('d = h − d\'', [`${D.h} − ${D.dp} = ${f(R.d)} cm`]) + row('Luz libre Ln', [`${f(D.ln)} m`]) + row('Recubrimiento / φ flexión / β1', [`${D.rec} cm / ${D.phi} / ${f(R.beta1)}`]))}
<h2>2. Diseño por flexión</h2>
<p>a = d − √(d² − 2·Mu/(φ·0.85·f'c·b)); As = Mu/(φ·fy·(d − a/2)); As mín = 0.7·√f'c/fy·b·d; As máx = 0.75·ρb·b·d (ρ máx = ${f(R.rhoMax * 100, 3)} %).</p>
${tabla(head + row('Mu (tnf·m)', c.map((x) => f(x.Mu))) + row('a (cm)', c.map((x) => f(x.aCalc))) + row('As calc (cm²)', c.map((x) => f(x.AsCalc))) + row('As mín (cm²)', c.map((x) => f(x.AsMin))) + row('As máx (cm²)', c.map((x) => f(x.AsMax))) + row('<b>As req (cm²)</b>', c.map((x) => f(x.AsReq))) + row('Acero colocado', POS.map((_, i) => etiqueta(D.barras[i]))) + row('<b>As colocado (cm²)</b>', c.map((x) => f(x.As))) + row('a (cm)', c.map((x) => f(x.a))) + row('Mn (tnf·m)', c.map((x) => f(x.Mn))) + (R.porticos ? row('Mpr (tnf·m)', c.map((x) => f(x.Mpr))) : '') + row('Ancho necesario (cm)', c.map((x) => f(x.ancho, 1))) + `<tr><th>As ≥ As req</th>${c.map((x) => ok(x.okAs)).join('')}</tr><tr><th>Cuantía</th>${c.map((x) => ok(x.okCuantia)).join('')}</tr><tr><th>Ancho</th>${c.map((x) => ok(x.okAncho)).join('')}</tr><tr><th>Mn ≥ Mn máx/4</th>${R.cuarto.map(ok).join('')}</tr>`)}
<p>Mn(+) ≥ ${R.porticos ? '1/2' : '1/3'}·Mn(−) en la cara del nudo: izquierdo <b>${R.caraIzq ? 'OK' : 'CORREGIR'}</b>, derecho <b>${R.caraDer ? 'OK' : 'CORREGIR'}</b>.</p>
<h2>3. Diseño por cortante (capacidad)</h2>
${tabla(row('Peso propio', [`${f(R.pp, 3)} t/m`]) + row('Losa + acabados + tabiquería', [`(${D.losa} + ${D.acab} + ${D.tabiq}) × ${D.trib} m`]) + row('CM', [`${f(R.CM, 3)} t/m`]) + row('CV = s/c × ancho tributario', [`${D.sc} × ${D.trib} = ${f(R.CV, 3)} t/m`]) + row('wu = 1.25(CM+CV)', [`${f(R.wu, 3)} t/m`]) + row('V isostático = wu·Ln/2', [`${f(R.Viso)} t`]) + row(`V por capacidad, antihorario (${R.porticos ? 'Mpr' : 'Mn'})`, [`(${f(R.porticos ? c[1].Mpr : c[1].Mn)} + ${f(R.porticos ? c[4].Mpr : c[4].Mn)}) / ${f(D.ln)} = ${f(R.V1)} t`]) + row(`V por capacidad, horario (${R.porticos ? 'Mpr' : 'Mn'})`, [`(${f(R.porticos ? c[0].Mpr : c[0].Mn)} + ${f(R.porticos ? c[5].Mpr : c[5].Mn)}) / ${f(D.ln)} = ${f(R.V2)} t`]) + row('V máx en la cara', [`${f(R.Vcara)} t`]) + row('Vu a "d" = V cara − wu·d', [`${f(R.VuCap)} t`]) + (R.usa25 ? row('Vu con sismo amplificado 2.5 (gobierna)', [`${f(R.Vu)} t`]) : ''))}
${fig(cortante(D, R))}
${tabla(row('Vc = 0.53·√f\'c·b·d', [`${f(R.Vc)} t`]) + row('φVc (φ = 0.85)', [`${f(R.phiVc)} t`]) + row('Vs = Vu/φ − Vc', [`${f(R.Vs)} t`]) + row(`Av (${D.ramas} ramas ϕ ${BARS[D.estribo].t})`, [`${f(R.Av)} cm²`]) + row('s por resistencia', [`${f(R.sCalc, 1)} cm`]) + row('Vs máx = 2.1·√f\'c·b·d', [`${f(R.VsMax)} t`]) + row('s máx por cortante', [`${f(R.sMax, 1)} cm`]) + row('s máx por Av mínimo', [`${f(R.sAvMin, 1)} cm`]))}
<h3>Confinamiento (2h = ${R.Lconf} cm)</h3>
${tabla(row('d/4', [`${f(lim.d4)} cm`]) + row(`${R.factorDb}·db menor`, [`${f(lim.db)} cm`]) + row('24·de', [`${f(lim.de)} cm`]) + row('Máximo', ['30 cm']) + row('s en confinamiento', [`<b>${R.sConf} cm</b>`]) + row('s fuera de confinamiento', [`<b>${R.sResto} cm</b>`]))}
<p><b>Estribos ϕ ${BARS[D.estribo].t}: ${R.distribucion}</b></p>
<h2>4. Detalle de armado</h2>
${fig(elevacion(D, R))}
${D.lb1 > 0 || D.lb2 > 0 ? '<p>Longitud de bastón fijada por el diseñador: verificar el punto de corte teórico y la prolongación mínima (E.060, capítulo 12).</p>' : ''}
<p class="cortes-m">${[[0, 'A'], [2, 'B'], [4, 'C']].map(([i, n]) => seccion(D, R, i, n)).join(' ')}</p>
<h2>5. Metrado de acero</h2>
${tabla('<tr><th>Descripción</th><th>ϕ</th><th>N°</th><th>Long. (m)</th><th>Peso (kg)</th></tr>' + mt.rows.map((r) => `<tr><td>${r.desc}</td><td>${BARS[r.id].t}</td><td>${r.n}</td><td>${f(r.L)}</td><td>${f(r.kg, 1)}</td></tr>`).join('') + `<tr><th colspan="4">Total</th><th>${f(mt.total, 1)}</th></tr>`)}
<h2>6. Conclusión</h2>
${R.avisos.length ? `<p class="mal"><b>Observaciones por corregir:</b></p><ul>${R.avisos.map((a) => `<li>${a}</li>`).join('')}</ul>` : '<p class="ok"><b>La viga cumple las verificaciones incluidas en esta memoria.</b></p>'}
<p><small>No incluye torsión, deflexiones, fisuración, longitudes de desarrollo en el nudo ni verificación de empalmes en zona de confinamiento.</small></p>`;
}

export const MEMORIA_CSS = `body{font-family:Arial,sans-serif;font-size:10.5pt;color:#111}h1{font-size:15pt;color:#c00000;text-align:center}h2{font-size:12pt;background:#c00000;color:#fff;padding:3px 6px}h3{font-size:11pt}
table{border-collapse:collapse;width:100%;margin:6px 0}th,td{border:1px solid #999;padding:3px 6px;text-align:center}th{background:#fde9e7}.ok{color:#166534}.mal{color:#b91c1c}`;
