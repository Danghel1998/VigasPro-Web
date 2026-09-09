/**
 * Controlador reactivo de la UI: wiring de inputs (data-bind), orquestación
 * del cálculo (designBeam), render de resultados/memoria/cuadro de acero,
 * y utilidades de exportación (PNG/JSON/impresión). Mismo patrón general
 * que MurosPro-Web/js/ui/uiController.js y ZapatasPro-Web equivalente.
 */

import { REBAR_TABLE, STIRRUP_REBAR_IDS, DEFAULT_BEAM_DATA, PRESET_PROJECTS } from '../constants.js';
import {
  calcRequiredRebar, calcBarCount, calcStirrupSpacing, roundSpacingDown,
  minDepthByDeflection_m, PHI_SHEAR,
} from '../engine/concreteDesign.js';
import { combineLoads, analyzeSimpleBeam, generarCombinacionesE060Viga } from '../engine/loadAnalysis.js';
import { calculateBeamRebarSchedule } from '../engine/rebarSchedule.js';
import { createBeamCanvas } from '../visualizer/beamCanvas.js';
import { createBeam3D } from '../visualizer/beamRenderer3D.js';

function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

let state = clone(DEFAULT_BEAM_DATA);
let lastAnalysis = null, lastStruct = null, lastRebarSched = null;
let beam3D;

// ---------------------------------------------------------------------------
// Acceso genérico a rutas "a.b.c" o "a.b.0.c" (arreglos) dentro del estado
// ---------------------------------------------------------------------------
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
  o[keys[keys.length - 1]] = value;
}

function rebarById(id) {
  return REBAR_TABLE[id] || REBAR_TABLE[0];
}

// ---------------------------------------------------------------------------
// Motor de diseño: combina análisis de cargas + diseño en concreto armado
// ---------------------------------------------------------------------------
function designBeam(data) {
  return data.loads.mode === 'etabs' ? designBeamEtabs(data) : designBeamManual(data);
}

function designBeamManual(data) {
  const { L, b, h } = data.geometry;
  const { LF_D, LF_L, phi_flex, phi_shear } = data.safety_req;
  const gamma_c = data.materials.gamma_c_kgm3;

  const selfWeight = data.loads.include_self_weight ? gamma_c * b * h : 0;
  const wd_total = data.loads.wd + selfWeight;
  const wu = combineLoads(wd_total, data.loads.wl, LF_D, LF_L);

  const pointLoadsU = (data.loads.point_loads || [])
    .filter(p => (p.Pd + p.Pl) > 0)
    .map(p => ({ pos: p.pos, Pu: combineLoads(p.Pd, p.Pl, LF_D, LF_L) }));

  const analysis = analyzeSimpleBeam(L, wu, pointLoadsU);

  const rebarTop = rebarById(data.materials.rebar_top_id);
  const rebarBottom = rebarById(data.materials.rebar_bottom_id);
  const rebarStirrup = rebarById(data.materials.rebar_stirrup_id);

  const d_m = h - data.materials.cover - rebarStirrup.diameter_m - rebarBottom.diameter_m / 2.0;

  const flexureCalc = calcRequiredRebar(analysis.Mu_max.M, data.materials.fc_kgcm2, data.materials.fy_kgcm2, b, d_m, phi_flex);
  const bottomBars = calcBarCount(flexureCalc.As_design, rebarBottom.area_cm2, data.materials.n_bars_bottom_min);
  const topBars = data.materials.n_bars_top_min;

  const Vu_left_d = analysis.Vu_at(d_m);
  const Vu_right_d = -analysis.Vu_at(L - d_m);
  const Vu_d = Math.max(Math.abs(Vu_left_d), Math.abs(Vu_right_d));

  const Av_cm2 = 2 * rebarStirrup.area_cm2; // estribo cerrado de 2 ramas
  const spacingAtFace = calcStirrupSpacing(Vu_d, data.materials.fc_kgcm2, data.materials.fy_kgcm2, b, d_m, Av_cm2, phi_shear);
  const s_end_cm = roundSpacingDown(spacingAtFace.s_cm);
  const s_mid_raw = Math.min(d_m * 100 / 2.0, 60.0);
  const s_mid_cm = roundSpacingDown(s_mid_raw);

  // Longitud de la zona de extremos: hasta donde Vu(x) cae por debajo de
  // phiVc/2 (criterio simplificado — a partir de ahí basta el espaciamiento
  // máximo constructivo).
  let endZoneLength_m = L / 4;
  for (const pt of analysis.points) {
    if (Math.abs(pt.V) <= spacingAtFace.phiVc / 2.0) { endZoneLength_m = pt.x; break; }
  }
  endZoneLength_m = Math.min(L / 2, Math.max(d_m, endZoneLength_m));

  const h_min = minDepthByDeflection_m(L);
  const deflectionPasses = h >= h_min;

  const struct = {
    d_m, wu, wd_total, selfWeight,
    flexure: {
      Mu_kgm: analysis.Mu_max.M, Mu_x: analysis.Mu_max.x,
      ...flexureCalc,
      top: { n_bars: topBars, As_prov_cm2: topBars * rebarTop.area_cm2 },
      bottom: { n_bars: bottomBars, As_prov_cm2: bottomBars * rebarBottom.area_cm2 },
    },
    shear: {
      Vu_face: Math.max(Math.abs(analysis.Vu_left_face), Math.abs(analysis.Vu_right_face)),
      Vu_d, ...spacingAtFace,
      s_end_cm, s_mid_cm, endZoneLength_m,
    },
    deflection: { h_min, passes: deflectionPasses },
    rebars: { top: rebarTop, bottom: rebarBottom, stirrup: rebarStirrup },
  };

  return { analysis, struct };
}

/** Ton / Ton·m (ETABS) -> kg / kg·m (unidades internas del motor). */
function etabsCaseToKg(c) {
  return { M: (c.M || 0) * 1000, V: (c.V || 0) * 1000 };
}

/**
 * Diseño a partir de valores de servicio de ETABS (M, V) para CM/CV/Sismo
 * X/Sismo Y — mismo criterio del módulo de Columnas: se arman las 9
 * combinaciones E.060 y se toma la envolvente (Mu+ para el acero inferior,
 * Mu- para el superior, Vu para estribos). Un solo juego de valores para
 * toda la viga (sin variación por estación).
 */
function designBeamEtabs(data) {
  const { L, b, h } = data.geometry;
  const { LF_D, LF_L, phi_flex, phi_shear } = data.safety_req;

  const etabsKg = {
    CM: etabsCaseToKg(data.loads.etabs.CM),
    CV: etabsCaseToKg(data.loads.etabs.CV),
    SISXX: etabsCaseToKg(data.loads.etabs.SISXX),
    SISYY: etabsCaseToKg(data.loads.etabs.SISYY),
  };
  const combos = generarCombinacionesE060Viga(etabsKg, LF_D, LF_L);

  let posCombo = combos[0], negCombo = combos[0], vCombo = combos[0];
  for (const c of combos) {
    if (c.M > posCombo.M) posCombo = c;
    if (c.M < negCombo.M) negCombo = c;
    if (Math.abs(c.V) > Math.abs(vCombo.V)) vCombo = c;
  }
  const Mu_pos = Math.max(0, posCombo.M);
  const Mu_neg = Math.abs(Math.min(0, negCombo.M));
  const Vu = Math.abs(vCombo.V);

  const rebarTop = rebarById(data.materials.rebar_top_id);
  const rebarBottom = rebarById(data.materials.rebar_bottom_id);
  const rebarStirrup = rebarById(data.materials.rebar_stirrup_id);
  const d_m = h - data.materials.cover - rebarStirrup.diameter_m - rebarBottom.diameter_m / 2.0;

  const bottomCalc = calcRequiredRebar(Mu_pos, data.materials.fc_kgcm2, data.materials.fy_kgcm2, b, d_m, phi_flex);
  const topCalc = calcRequiredRebar(Mu_neg, data.materials.fc_kgcm2, data.materials.fy_kgcm2, b, d_m, phi_flex);
  const bottomBars = calcBarCount(bottomCalc.As_design, rebarBottom.area_cm2, data.materials.n_bars_bottom_min);
  const topBars = calcBarCount(topCalc.As_design, rebarTop.area_cm2, data.materials.n_bars_top_min);

  const Av_cm2 = 2 * rebarStirrup.area_cm2;
  const spacing = calcStirrupSpacing(Vu, data.materials.fc_kgcm2, data.materials.fy_kgcm2, b, d_m, Av_cm2, phi_shear);
  const s_end_cm = roundSpacingDown(spacing.s_cm);
  const s_mid_cm = roundSpacingDown(Math.min((d_m * 100) / 2.0, 60.0));
  const endZoneLength_m = Math.min(L / 2, Math.max(d_m, L / 4));

  const h_min = minDepthByDeflection_m(L);

  const struct = {
    d_m,
    flexure: {
      Mu_kgm: Mu_pos, Mu_x: L / 2,
      ...bottomCalc,
      top: { ...topCalc, n_bars: topBars, As_prov_cm2: topBars * rebarTop.area_cm2 },
      bottom: { n_bars: bottomBars, As_prov_cm2: bottomBars * rebarBottom.area_cm2 },
      doubleReinfRequired: bottomCalc.doubleReinfRequired || topCalc.doubleReinfRequired,
    },
    shear: {
      Vu_face: Vu, Vu_d: Vu, ...spacing,
      s_end_cm, s_mid_cm, endZoneLength_m,
    },
    deflection: { h_min, passes: h >= h_min },
    rebars: { top: rebarTop, bottom: rebarBottom, stirrup: rebarStirrup },
    etabs: { combos, posCombo, negCombo, vCombo, Mu_pos, Mu_neg, Vu },
  };

  // Envolvente ilustrativa para el visualizador (no es el diagrama real de
  // ETABS): forma parabólica típica de un tramo continuo, momento negativo
  // en los apoyos y positivo al centro, coherente con Mu+/Mu-/Vu de diseño.
  const n = 40;
  const points = [];
  for (let i = 0; i <= n; i++) {
    const x = (L * i) / n;
    const t = x / L;
    const M = -Mu_neg + (Mu_pos + Mu_neg) * 4 * t * (1 - t);
    const V = Vu * (1 - 2 * t);
    points.push({ x, M, V });
  }
  const Mu_max = points.reduce((a, p) => (p.M > a.M ? p : a), points[0]);
  const analysis = {
    points, Mu_max,
    Vu_left_face: Vu, Vu_right_face: Vu,
    Vu_at: () => Vu,
  };

  return { analysis, struct };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
let canvas;

function fmt(n, dec = 1) {
  if (!isFinite(n)) return '—';
  return n.toLocaleString('es-PE', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function renderKPIs(struct) {
  const banner = document.getElementById('global_status_banner');
  const problems = [];
  if (struct.flexure.doubleReinfRequired) problems.push('Requiere doble refuerzo (Mu excede la capacidad simplemente reforzada) o aumentar la sección.');
  if (struct.shear.exceedsCapacity) problems.push('El cortante último excede la capacidad máxima de estribos (Vs > Vs_max) — aumentar la sección.');
  if (!struct.deflection.passes) problems.push(`Peralte insuficiente por deflexión: h_min = ${fmt(struct.deflection.h_min * 100, 1)} cm (L/16).`);

  if (problems.length === 0) {
    banner.className = 'px-4 py-2 text-xs font-bold bg-emerald-50 text-emerald-800 border-b border-emerald-200';
    banner.innerHTML = '✅ La sección cumple con los requisitos de flexión, cortante y deflexión.';
  } else {
    banner.className = 'px-4 py-2 text-xs font-bold bg-rose-50 text-rose-800 border-b border-rose-200';
    banner.innerHTML = '⚠️ ' + problems.join(' &nbsp;|&nbsp; ');
  }

  document.getElementById('kpi_mu').textContent = fmt(struct.flexure.Mu_kgm, 0) + ' kg·m';
  document.getElementById('kpi_vu').textContent = fmt(struct.shear.Vu_face, 0) + ' kg';
  document.getElementById('kpi_as').textContent = fmt(struct.flexure.As_design, 2) + ' cm²';
  document.getElementById('kpi_deflection').textContent = (struct.deflection.passes ? '✓ ' : '✗ ') + fmt(struct.deflection.h_min * 100, 1) + ' cm';
}

function renderResultsTable(struct) {
  const el = document.getElementById('results_table_body');
  const rows = [
    ['Momento último Mu', fmt(struct.flexure.Mu_kgm, 0) + ' kg·m', `en x = ${fmt(struct.flexure.Mu_x, 2)} m`],
    ['Peralte efectivo d', fmt(struct.d_m * 100, 1) + ' cm', ''],
    ['Cuantía requerida ρ', fmt(struct.flexure.rho * 100, 3) + ' %', `ρmin=${fmt(struct.flexure.rho_min * 100, 3)}%`],
    ['As requerido', fmt(struct.flexure.As_design, 2) + ' cm²', `As_min=${fmt(struct.flexure.As_min, 2)}, As_max=${fmt(struct.flexure.As_max, 2)}`],
    ['Acero inferior provisto', `${struct.flexure.bottom.n_bars} ${struct.rebars.bottom.inches}`, fmt(struct.flexure.bottom.As_prov_cm2, 2) + ' cm²'],
    ['Acero superior (constructivo)', `${struct.flexure.top.n_bars} ${struct.rebars.top.inches}`, fmt(struct.flexure.top.As_prov_cm2, 2) + ' cm²'],
    ['Cortante último Vu', fmt(struct.shear.Vu_face, 0) + ' kg', `a d: ${fmt(struct.shear.Vu_d, 0)} kg`],
    ['Capacidad del concreto φVc', fmt(struct.shear.phiVc, 0) + ' kg', `Vc=${fmt(struct.shear.Vc, 0)}`],
    ['Estribos', struct.rebars.stirrup.inches, `@${fmt(struct.shear.s_end_cm, 1)}cm (extremos) / @${fmt(struct.shear.s_mid_cm, 1)}cm (centro)`],
    ['Peralte mínimo por deflexión', fmt(struct.deflection.h_min * 100, 1) + ' cm', struct.deflection.passes ? 'Cumple' : 'No cumple'],
  ];
  el.innerHTML = rows.map(r => `<tr class="border-b border-slate-100"><td class="py-1.5 pr-3 font-semibold text-slate-700">${r[0]}</td><td class="py-1.5 pr-3 font-mono text-slate-900">${r[1]}</td><td class="py-1.5 text-slate-500 text-[11px]">${r[2]}</td></tr>`).join('');
}

function renderRebarTable(sched) {
  const el = document.getElementById('rebar_table_body');
  el.innerHTML = sched.rows.map(r => `
    <tr class="border-b border-slate-100">
      <td class="py-1.5 pr-2 font-bold text-indigo-700">${r.mark}</td>
      <td class="py-1.5 pr-2 text-slate-700">${r.element}</td>
      <td class="py-1.5 pr-2 font-mono text-center">${r.diameter_name}</td>
      <td class="py-1.5 pr-2 text-center">${r.shape === 'stirrup' ? 'Estribo' : 'Recta'}</td>
      <td class="py-1.5 pr-2 text-right font-mono">${fmt(r.unitLength_m, 2)}</td>
      <td class="py-1.5 pr-2 text-right font-mono">${r.quantity}</td>
      <td class="py-1.5 pr-2 text-right font-mono">${fmt(r.totalLength_m, 2)}</td>
      <td class="py-1.5 text-right font-mono font-bold">${fmt(r.weight_kg, 2)}</td>
    </tr>`).join('');
  document.getElementById('rebar_total_weight').textContent = fmt(sched.totalWeight_kg, 2) + ' kg';
}

// ---------------------------------------------------------------------------
// Memoria de Cálculo — formato "hoja de reporte" (igual estilo que
// ColumnasPro): header + tarjeta de metadatos, banners de sección, tarjetas
// de fórmula con sustitución numérica paso a paso, y figuras (2D + 3D).
// ---------------------------------------------------------------------------
function memoriaHeaderHtml(data, subtitle) {
  const p = data.plano;
  return `
    <div class="memoria-header-top">
      <div>
        <div class="memoria-title">Memoria de Cálculo de Viga</div>
        <div class="memoria-subtitle">${subtitle}</div>
      </div>
      <div class="text-right text-xs font-bold" style="color:#64748b">MEMORIA DE CÁLCULO<br>${p.codigo || '—'}</div>
    </div>
    <div class="memoria-metadata">
      <div class="memoria-meta-grid">
        <div><strong>PROYECTO:</strong> ${p.proyecto || '—'}</div>
        <div><strong>PROPIETARIO:</strong> ${p.propietario || '—'}</div>
        <div><strong>UBICACIÓN:</strong> ${p.ubicacion || '—'}</div>
        <div><strong>ELEMENTO:</strong> ${p.elemento || '—'}</div>
        <div><strong>DISEÑADO POR:</strong> ${p.dibujado_por || '—'}</div>
        <div><strong>FECHA:</strong> ${p.fecha || '—'}</div>
        <div><strong>CÓDIGO:</strong> ${p.codigo || '—'}</div>
        <div><strong>NORMATIVA:</strong> E.060 / ACI 318</div>
      </div>
    </div>`;
}

function memoriaFigurasHtml(shots) {
  return `
    <div class="memoria-banner">VI) REPRESENTACIÓN GRÁFICA</div>
    <div class="memoria-figure">
      <p class="caption">Figura 1 — Geometría y Cargas</p>
      ${shots.geometry ? `<img src="${shots.geometry}">` : ''}
      <p class="desc">Elevación esquemática de la viga con la luz, la sección transversal y las cargas actuantes.</p>
    </div>
    <div class="memoria-figure">
      <p class="caption">Figura 2 — Despiece de Armadura (2D)</p>
      ${shots.rebar ? `<img src="${shots.rebar}">` : ''}
      <p class="desc">Disposición del acero longitudinal (superior e inferior) y espaciamiento de estribos por zonas.</p>
    </div>
    <div class="memoria-figure">
      <p class="caption">Figura 3 — Modelo 3D de Armadura</p>
      ${shots.render3d ? `<img src="${shots.render3d}">` : ''}
      <p class="desc">Vista tridimensional del concreto (translúcido), acero longitudinal y estribos.</p>
    </div>`;
}

/** Redibuja el canvas 2D en los modos "geometry" y "rebar" para capturar sus
 * imágenes, restaura el modo activo del usuario, y toma una foto del
 * render 3D — todo para incrustar en la Memoria de Cálculo. */
function captureSnapshots() {
  const currentMode = canvas.getMode();
  canvas.setMode('geometry');
  const geometryShot = document.getElementById('beam_canvas').toDataURL('image/png');
  canvas.setMode('rebar');
  const rebarShot = document.getElementById('beam_canvas').toDataURL('image/png');
  canvas.setMode(currentMode);
  const render3dShot = beam3D ? beam3D.snapshot() : '';
  return { geometry: geometryShot, rebar: rebarShot, render3d: render3dShot };
}

function renderMemoria(data, analysis, struct) {
  const el = document.getElementById('report_panel');
  const shots = captureSnapshots();
  const dbEst_cm = (struct.rebars.stirrup.diameter_mm / 10).toFixed(2);
  const dbMain_cm = (struct.rebars.bottom.diameter_mm / 10).toFixed(2);

  el.innerHTML = `
    <div class="memoria-doc p-6">
      ${memoriaHeaderHtml(data, 'Norma E.060 (Concreto Armado) / ACI 318 — Análisis por carga distribuida')}

      <div class="memoria-banner">I) DATOS DE DISEÑO</div>
      <div class="memoria-formula">
        <p>Luz libre: L = ${fmt(data.geometry.L,2)} m</p>
        <p>Sección: b × h = ${fmt(data.geometry.b*100,0)} × ${fmt(data.geometry.h*100,0)} cm</p>
        <p>Resistencia del concreto: f'c = ${fmt(data.materials.fc_kgcm2,0)} kg/cm²</p>
        <p>Resistencia del acero: fy = ${fmt(data.materials.fy_kgcm2,0)} kg/cm²</p>
        <p>Carga muerta: wD = ${fmt(data.loads.wd,0)} kg/m${data.loads.include_self_weight ? ` + peso propio ${fmt(struct.selfWeight,0)} kg/m = ${fmt(struct.wd_total,0)} kg/m` : ''}</p>
        <p>Carga viva: wL = ${fmt(data.loads.wl,0)} kg/m</p>
      </div>

      <div class="memoria-banner">II) ANÁLISIS DE CARGAS (E.060)</div>
      <div class="memoria-formula">
        <p>Wu = 1.4·wD + 1.7·wL</p>
        <p>Wu = 1.4 × ${fmt(struct.wd_total,0)} + 1.7 × ${fmt(data.loads.wl,0)}</p>
        <p><strong>Wu = ${fmt(struct.wu,0)} kg/m</strong></p>
      </div>
      <div class="memoria-formula">
        <p>Momento último máximo (viga simplemente apoyada, superposición de reacciones):</p>
        <p><strong>Mu = ${fmt(struct.flexure.Mu_kgm,0)} kg·m</strong>, en x = ${fmt(struct.flexure.Mu_x,2)} m</p>
        <p>Cortante último en la cara del apoyo: Vu = ${fmt(struct.shear.Vu_face,0)} kg</p>
        <p>Cortante a distancia d (sección crítica): <strong>Vu = ${fmt(struct.shear.Vu_d,0)} kg</strong></p>
      </div>

      <div class="memoria-banner">III) DISEÑO A FLEXIÓN (E.060 Capítulo 10)</div>
      <div class="memoria-formula">
        <p>Peralte efectivo: d = h − r − øe − øp/2</p>
        <p>d = ${fmt(data.geometry.h*100,1)} − ${fmt(data.materials.cover*100,1)} − ${dbEst_cm} − ${dbMain_cm}/2</p>
        <p><strong>d = ${fmt(struct.d_m*100,1)} cm</strong></p>
      </div>
      <div class="memoria-formula">
        <p>Rn = Mu / (φ·b·d²)</p>
        <p>Rn = (${fmt(struct.flexure.Mu_kgm,0)} × 100) / (0.90 × ${fmt(data.geometry.b*100,0)} × ${fmt(struct.d_m*100,1)}²)</p>
        <p><strong>Rn = ${fmt(struct.flexure.Rn,1)} kg/cm²</strong></p>
        <p>ρ = (0.85f'c/fy)·[1 − √(1 − 2Rn/0.85f'c)] = <strong>${fmt(struct.flexure.rho*100,3)} %</strong></p>
      </div>
      <div class="memoria-formula">
        <p>As,calc = ρ·b·d = ${fmt(struct.flexure.As_calc,2)} cm²</p>
        <p>As,min = máx(0.7√f'c/fy, 14/fy)·b·d = ${fmt(struct.flexure.As_min,2)} cm²</p>
        <p>As,max = 0.75·ρbal·b·d = ${fmt(struct.flexure.As_max,2)} cm²</p>
        <p><strong>As,diseño = máx(As,calc, As,min) = ${fmt(struct.flexure.As_design,2)} cm²</strong></p>
        <p>=&gt; Acero inferior: <strong>${struct.flexure.bottom.n_bars} ${struct.rebars.bottom.inches}</strong> (As provisto = ${fmt(struct.flexure.bottom.As_prov_cm2,2)} cm²) <span class="${struct.flexure.bottom.As_prov_cm2 >= struct.flexure.As_design ? 'memoria-badge-ok' : 'memoria-badge-warn'}">${struct.flexure.bottom.As_prov_cm2 >= struct.flexure.As_design ? 'CUMPLE' : 'REVISAR'}</span></p>
        <p>Acero superior (constructivo): ${struct.flexure.top.n_bars} ${struct.rebars.top.inches} (As provisto = ${fmt(struct.flexure.top.As_prov_cm2,2)} cm²)</p>
      </div>
      ${struct.flexure.doubleReinfRequired ? `<div class="memoria-formula" style="border-color:#fca5a5;background:#fef2f2"><p><span class="memoria-badge-warn">ATENCIÓN</span> La sección requiere doble refuerzo o mayor peralte — fuera del alcance de este módulo.</p></div>` : ''}

      <div class="memoria-banner">IV) DISEÑO A CORTANTE (E.060 Capítulo 13)</div>
      <div class="memoria-formula">
        <p>Vc = 0.53·√f'c·b·d</p>
        <p>Vc = 0.53 × √${fmt(data.materials.fc_kgcm2,0)} × ${fmt(data.geometry.b*100,0)} × ${fmt(struct.d_m*100,1)}</p>
        <p><strong>Vc = ${fmt(struct.shear.Vc,0)} kg</strong> &nbsp; φVc = ${fmt(struct.shear.phiVc,0)} kg</p>
      </div>
      <div class="memoria-formula">
        ${struct.shear.requiresStirrupsByCalc
          ? `<p>Vs = Vu/φ − Vc = ${fmt(struct.shear.Vu_d,0)}/0.85 − ${fmt(struct.shear.Vc,0)} = <strong>${fmt(struct.shear.Vs_req,0)} kg</strong></p><p>s = Av·fy·d / Vs &rarr; <strong>s = ${fmt(struct.shear.s_end_cm,1)} cm</strong> (zona de extremos, Lext = ${fmt(struct.shear.endZoneLength_m,2)} m)</p>`
          : `<p>Vu ≤ φVc: no se requieren estribos por cálculo, se usa el espaciamiento máximo constructivo.</p><p><strong>s = ${fmt(struct.shear.s_end_cm,1)} cm</strong> (zona de extremos, Lext = ${fmt(struct.shear.endZoneLength_m,2)} m)</p>`}
        <p>Zona central: s = mín(d/2, 60cm) = <strong>${fmt(struct.shear.s_mid_cm,1)} cm</strong></p>
        <p>=&gt; Estribos ${struct.rebars.stirrup.inches}: @ ${fmt(struct.shear.s_end_cm,1)}cm (extremos) / @ ${fmt(struct.shear.s_mid_cm,1)}cm (centro)</p>
      </div>
      ${struct.shear.exceedsCapacity ? `<div class="memoria-formula" style="border-color:#fca5a5;background:#fef2f2"><p><span class="memoria-badge-warn">ATENCIÓN</span> Vs requerido excede el límite máximo de la norma — aumentar la sección.</p></div>` : ''}

      <div class="memoria-banner">V) VERIFICACIÓN POR DEFLEXIÓN (E.060 Art. 9.6.2)</div>
      <div class="memoria-formula">
        <p>Elemento simplemente apoyado, sin tabiquería susceptible a dañarse:</p>
        <p>h,min = L/16 = ${fmt(data.geometry.L,2)}/16 = <strong>${fmt(struct.deflection.h_min*100,1)} cm</strong></p>
        <p>Peralte provisto h = ${fmt(data.geometry.h*100,1)} cm &rarr; <span class="${struct.deflection.passes ? 'memoria-badge-ok' : 'memoria-badge-warn'}">${struct.deflection.passes ? 'CUMPLE' : 'NO CUMPLE'}</span></p>
      </div>

      ${memoriaFigurasHtml(shots)}
    </div>`;
}

function comboRowsHtml(struct) {
  const { combos, posCombo, negCombo, vCombo } = struct.etabs;
  return combos.map((c) => {
    const isPos = c === posCombo, isNeg = c === negCombo, isV = c === vCombo;
    const tag = [isPos && 'M+ máx', isNeg && 'M− máx', isV && 'V máx'].filter(Boolean).join(' / ');
    return `<tr class="border-b border-slate-100 ${isPos || isNeg || isV ? 'bg-indigo-50/60 font-semibold' : ''}">
      <td class="py-1.5 pr-3 text-slate-700">${c.nombre}</td>
      <td class="py-1.5 pr-3 text-right font-mono">${fmt(c.M, 0)}</td>
      <td class="py-1.5 pr-3 text-right font-mono">${fmt(c.V, 0)}</td>
      <td class="py-1.5 text-[10px] text-indigo-700 font-bold">${tag}</td>
    </tr>`;
  }).join('');
}

function renderResultsTableEtabs(struct) {
  const el = document.getElementById('results_table_body');
  const rows = [
    ['Momento positivo envolvente Mu+', fmt(struct.etabs.Mu_pos, 0) + ' kg·m', `combo: ${struct.etabs.posCombo.nombre}`],
    ['Momento negativo envolvente Mu−', fmt(struct.etabs.Mu_neg, 0) + ' kg·m', `combo: ${struct.etabs.negCombo.nombre}`],
    ['Cortante envolvente Vu', fmt(struct.etabs.Vu, 0) + ' kg', `combo: ${struct.etabs.vCombo.nombre}`],
    ['Peralte efectivo d', fmt(struct.d_m * 100, 1) + ' cm', ''],
    ['As requerido (inferior, por Mu+)', fmt(struct.flexure.As_design, 2) + ' cm²', `As_min=${fmt(struct.flexure.As_min, 2)}, As_max=${fmt(struct.flexure.As_max, 2)}`],
    ['Acero inferior provisto', `${struct.flexure.bottom.n_bars} ${struct.rebars.bottom.inches}`, fmt(struct.flexure.bottom.As_prov_cm2, 2) + ' cm²'],
    ['As requerido (superior, por Mu−)', fmt(struct.flexure.top.As_design, 2) + ' cm²', `As_min=${fmt(struct.flexure.top.As_min, 2)}`],
    ['Acero superior provisto', `${struct.flexure.top.n_bars} ${struct.rebars.top.inches}`, fmt(struct.flexure.top.As_prov_cm2, 2) + ' cm²'],
    ['Capacidad del concreto φVc', fmt(struct.shear.phiVc, 0) + ' kg', `Vc=${fmt(struct.shear.Vc, 0)}`],
    ['Estribos', struct.rebars.stirrup.inches, `@${fmt(struct.shear.s_end_cm, 1)}cm (extremos) / @${fmt(struct.shear.s_mid_cm, 1)}cm (centro)`],
    ['Peralte mínimo por deflexión', fmt(struct.deflection.h_min * 100, 1) + ' cm', struct.deflection.passes ? 'Cumple' : 'No cumple'],
  ];
  el.innerHTML = rows.map(r => `<tr class="border-b border-slate-100"><td class="py-1.5 pr-3 font-semibold text-slate-700">${r[0]}</td><td class="py-1.5 pr-3 font-mono text-slate-900">${r[1]}</td><td class="py-1.5 text-slate-500 text-[11px]">${r[2]}</td></tr>`).join('');

  const comboSection = document.getElementById('etabs_combos_section');
  if (comboSection) {
    comboSection.classList.remove('hidden');
    document.getElementById('etabs_combos_body').innerHTML = comboRowsHtml(struct);
  }
}

function renderMemoriaEtabs(data, struct) {
  const el = document.getElementById('report_panel');
  const shots = captureSnapshots();
  const e = data.loads.etabs;
  const dbEst_cm = (struct.rebars.stirrup.diameter_mm / 10).toFixed(2);
  const dbMain_cm = (struct.rebars.bottom.diameter_mm / 10).toFixed(2);

  const comboRows = struct.etabs.combos.map((c) => {
    const tag = [c === struct.etabs.posCombo && 'M+', c === struct.etabs.negCombo && 'M−', c === struct.etabs.vCombo && 'V'].filter(Boolean).join('/');
    return `<tr><td>${c.nombre}</td><td style="text-align:right">${fmt(c.M,0)}</td><td style="text-align:right">${fmt(c.V,0)}</td><td style="text-align:center;font-weight:700;color:#4338ca">${tag}</td></tr>`;
  }).join('');

  el.innerHTML = `
    <div class="memoria-doc p-6">
      ${memoriaHeaderHtml(data, 'Norma E.060 (Concreto Armado) / ACI 318 — Valores de servicio de ETABS')}

      <div class="memoria-banner">I) DATOS DE DISEÑO</div>
      <div class="memoria-formula">
        <p>Sección: b × h = ${fmt(data.geometry.b*100,0)} × ${fmt(data.geometry.h*100,0)} cm, luz L = ${fmt(data.geometry.L,2)} m</p>
        <p>f'c = ${fmt(data.materials.fc_kgcm2,0)} kg/cm², fy = ${fmt(data.materials.fy_kgcm2,0)} kg/cm²</p>
      </div>
      <table class="memoria-table">
        <thead><tr><th>Caso</th><th style="text-align:right">M (Ton·m)</th><th style="text-align:right">V (Ton)</th></tr></thead>
        <tbody>
          <tr><td>CM</td><td style="text-align:right">${fmt(e.CM.M,3)}</td><td style="text-align:right">${fmt(e.CM.V,3)}</td></tr>
          <tr><td>CV</td><td style="text-align:right">${fmt(e.CV.M,3)}</td><td style="text-align:right">${fmt(e.CV.V,3)}</td></tr>
          <tr><td>Sismo X</td><td style="text-align:right">${fmt(e.SISXX.M,3)}</td><td style="text-align:right">${fmt(e.SISXX.V,3)}</td></tr>
          <tr><td>Sismo Y</td><td style="text-align:right">${fmt(e.SISYY.M,3)}</td><td style="text-align:right">${fmt(e.SISYY.V,3)}</td></tr>
        </tbody>
      </table>

      <div class="memoria-banner">II) COMBINACIONES DE CARGA E.060 (9 combinaciones)</div>
      <div class="memoria-formula">
        <p>1.4CM+1.7CV; 1.25(CM+CV)±SISXX; 0.9CM±SISXX; 1.25(CM+CV)±SISYY; 0.9CM±SISYY</p>
      </div>
      <table class="memoria-table">
        <thead><tr><th>Combinación</th><th style="text-align:right">M (kg·m)</th><th style="text-align:right">V (kg)</th><th>Gobierna</th></tr></thead>
        <tbody>${comboRows}</tbody>
      </table>
      <div class="memoria-formula">
        <p><strong>Envolvente de diseño:</strong></p>
        <p>Mu+ = ${fmt(struct.etabs.Mu_pos,0)} kg·m &nbsp; (${struct.etabs.posCombo.nombre})</p>
        <p>Mu− = ${fmt(struct.etabs.Mu_neg,0)} kg·m &nbsp; (${struct.etabs.negCombo.nombre})</p>
        <p>Vu = ${fmt(struct.etabs.Vu,0)} kg &nbsp; (${struct.etabs.vCombo.nombre})</p>
      </div>

      <div class="memoria-banner">III) DISEÑO A FLEXIÓN (E.060 Capítulo 10)</div>
      <div class="memoria-formula">
        <p>Peralte efectivo: d = h − r − øe − øp/2</p>
        <p>d = ${fmt(data.geometry.h*100,1)} − ${fmt(data.materials.cover*100,1)} − ${dbEst_cm} − ${dbMain_cm}/2</p>
        <p><strong>d = ${fmt(struct.d_m*100,1)} cm</strong></p>
      </div>
      <div class="memoria-formula">
        <p><strong>Acero inferior (por Mu+):</strong></p>
        <p>As,diseño = ${fmt(struct.flexure.As_design,2)} cm² &rarr; <strong>${struct.flexure.bottom.n_bars} ${struct.rebars.bottom.inches}</strong> (As provisto = ${fmt(struct.flexure.bottom.As_prov_cm2,2)} cm²)</p>
      </div>
      <div class="memoria-formula">
        <p><strong>Acero superior (por Mu−):</strong></p>
        <p>As,diseño = ${fmt(struct.flexure.top.As_design,2)} cm² &rarr; <strong>${struct.flexure.top.n_bars} ${struct.rebars.top.inches}</strong> (As provisto = ${fmt(struct.flexure.top.As_prov_cm2,2)} cm²)</p>
      </div>
      ${struct.flexure.doubleReinfRequired ? `<div class="memoria-formula" style="border-color:#fca5a5;background:#fef2f2"><p><span class="memoria-badge-warn">ATENCIÓN</span> La sección requiere doble refuerzo o mayor peralte.</p></div>` : ''}

      <div class="memoria-banner">IV) DISEÑO A CORTANTE (E.060 Capítulo 13)</div>
      <div class="memoria-formula">
        <p>Vc = 0.53·√f'c·b·d = <strong>${fmt(struct.shear.Vc,0)} kg</strong> &nbsp; φVc = ${fmt(struct.shear.phiVc,0)} kg</p>
        ${struct.shear.requiresStirrupsByCalc
          ? `<p>Vs = Vu/φ − Vc = <strong>${fmt(struct.shear.Vs_req,0)} kg</strong></p>`
          : `<p>Vu ≤ φVc: se usa el espaciamiento máximo constructivo.</p>`}
        <p><strong>s = ${fmt(struct.shear.s_end_cm,1)} cm</strong> (extremos) / <strong>${fmt(struct.shear.s_mid_cm,1)} cm</strong> (centro)</p>
      </div>
      ${struct.shear.exceedsCapacity ? `<div class="memoria-formula" style="border-color:#fca5a5;background:#fef2f2"><p><span class="memoria-badge-warn">ATENCIÓN</span> Vs requerido excede el límite máximo de la norma.</p></div>` : ''}

      <div class="memoria-banner">V) VERIFICACIÓN POR DEFLEXIÓN (E.060 Art. 9.6.2)</div>
      <div class="memoria-formula">
        <p>h,min = L/16 = <strong>${fmt(struct.deflection.h_min*100,1)} cm</strong>. Peralte provisto h = ${fmt(data.geometry.h*100,1)} cm &rarr; <span class="${struct.deflection.passes ? 'memoria-badge-ok' : 'memoria-badge-warn'}">${struct.deflection.passes ? 'CUMPLE' : 'NO CUMPLE'}</span></p>
      </div>

      ${memoriaFigurasHtml(shots)}
    </div>`;
}

function recalc() {
  const { analysis, struct } = designBeam(state);
  lastAnalysis = analysis; lastStruct = struct;
  lastRebarSched = calculateBeamRebarSchedule(state, struct, struct.rebars);
  analysis.struct = struct;

  // El canvas 2D y la escena 3D se actualizan ANTES de generar la Memoria,
  // para que captureSnapshots() (dentro de renderMemoria/renderMemoriaEtabs)
  // capture siempre los datos recién calculados, no los del recalc anterior.
  canvas.render(state, analysis, struct.rebars);
  beam3D.update(state, struct, struct.rebars);

  renderKPIs(struct);
  const comboSection = document.getElementById('etabs_combos_section');
  if (state.loads.mode === 'etabs') {
    renderResultsTableEtabs(struct);
    renderMemoriaEtabs(state, struct);
  } else {
    if (comboSection) comboSection.classList.add('hidden');
    renderResultsTable(struct);
    renderMemoria(state, analysis, struct);
  }
  renderRebarTable(lastRebarSched);
}

// ---------------------------------------------------------------------------
// Binding de inputs
// ---------------------------------------------------------------------------
function refreshAllInputs() {
  document.querySelectorAll('[data-bind]').forEach((el) => {
    const path = el.dataset.bind;
    const value = getPath(state, path);
    if (value === undefined) return;
    if (el.type === 'checkbox') el.checked = !!value;
    else el.value = value;
  });
}

function bindInputs() {
  document.querySelectorAll('[data-bind]').forEach((el) => {
    el.addEventListener('input', () => {
      const path = el.dataset.bind;
      let value;
      if (el.type === 'checkbox') value = el.checked;
      else if (el.type === 'number') value = parseFloat(el.value);
      else if (el.tagName === 'SELECT' && !isNaN(parseFloat(el.value)) && el.dataset.numeric !== 'false') value = parseFloat(el.value);
      else value = el.value;
      if (typeof value === 'number' && isNaN(value)) return;
      setPath(state, path, value);
      recalc();
    });
  });
}

function populateRebarSelects() {
  const mainOptions = REBAR_TABLE.map((r, i) => `<option value="${i}">${r.name}</option>`).join('');
  const stirrupOptions = STIRRUP_REBAR_IDS.map((i) => `<option value="${i}">${REBAR_TABLE[i].name}</option>`).join('');
  document.getElementById('rebar_top_id').innerHTML = mainOptions;
  document.getElementById('rebar_bottom_id').innerHTML = mainOptions;
  document.getElementById('rebar_stirrup_id').innerHTML = stirrupOptions;
}

// ---------------------------------------------------------------------------
// Tabs, tema, presets, export
// ---------------------------------------------------------------------------
function setupTabs(selector, panelPrefix) {
  document.querySelectorAll(selector).forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-' + panelPrefix);
      document.querySelectorAll(selector).forEach((b) => b.classList.remove('bg-white', 'shadow-sm', 'text-indigo-700'));
      btn.classList.add('bg-white', 'shadow-sm', 'text-indigo-700');
      document.querySelectorAll('.' + panelPrefix + '-panel').forEach((p) => p.classList.add('hidden'));
      document.getElementById(target).classList.remove('hidden');
    });
  });
}

function setupCanvasModeButtons() {
  const canvasEl = document.getElementById('beam_canvas');
  const container3d = document.getElementById('beam_3d_container');
  const reset3dBtn = document.getElementById('btn_reset_3d_camera');

  document.querySelectorAll('[data-canvas-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-canvas-mode]').forEach((b) => {
        b.classList.remove('bg-indigo-600', 'text-white');
        b.classList.add('bg-slate-100', 'text-slate-700');
      });
      btn.classList.remove('bg-slate-100', 'text-slate-700');
      btn.classList.add('bg-indigo-600', 'text-white');

      const mode = btn.dataset.canvasMode;
      if (mode === '3d') {
        canvasEl.classList.add('opacity-0', 'pointer-events-none');
        container3d.classList.remove('opacity-0', 'pointer-events-none');
        reset3dBtn.classList.remove('hidden');
        beam3D.ensureInit();
        beam3D.resize();
        beam3D.resetCamera(state.geometry.L);
      } else {
        canvasEl.classList.remove('opacity-0', 'pointer-events-none');
        container3d.classList.add('opacity-0', 'pointer-events-none');
        reset3dBtn.classList.add('hidden');
        canvas.setMode(mode);
      }
    });
  });

  reset3dBtn.addEventListener('click', () => beam3D.resetCamera(state.geometry.L));
}

function setupTheme() {
  const btn = document.getElementById('btn_toggle_theme');
  btn.addEventListener('click', () => {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('vigaspro_theme', isDark ? 'dark' : 'light');
    document.getElementById('icon_theme_moon').classList.toggle('hidden', isDark);
    document.getElementById('icon_theme_sun').classList.toggle('hidden', !isDark);
  });
  const isDark = document.documentElement.classList.contains('dark');
  document.getElementById('icon_theme_moon').classList.toggle('hidden', isDark);
  document.getElementById('icon_theme_sun').classList.toggle('hidden', !isDark);
}

function setupPresets() {
  const dropdown = document.getElementById('preset_dropdown');
  dropdown.innerHTML = Object.entries(PRESET_PROJECTS).map(([key, p]) => `<option value="${key}">${p.title}</option>`).join('');
  dropdown.addEventListener('change', () => {
    const preset = PRESET_PROJECTS[dropdown.value];
    if (!preset) return;
    state = clone(preset.data);
    refreshAllInputs();
    updateTypeTabsVisibility();
    recalc();
  });
}

function updateTypeTabsVisibility() {
  const mode = state.loads.mode;
  document.querySelectorAll('.only-manual').forEach((el) => el.classList.toggle('hidden', mode !== 'manual'));
  document.querySelectorAll('.only-etabs').forEach((el) => el.classList.toggle('hidden', mode !== 'etabs'));
  document.querySelectorAll('[data-load-mode]').forEach((btn) => {
    const active = btn.dataset.loadMode === mode;
    btn.classList.toggle('bg-indigo-600', active);
    btn.classList.toggle('text-white', active);
    btn.classList.toggle('bg-slate-100', !active);
    btn.classList.toggle('text-slate-700', !active);
  });
}

function setupLoadModeToggle() {
  document.querySelectorAll('[data-load-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.loads.mode = btn.dataset.loadMode;
      updateTypeTabsVisibility();
      recalc();
    });
  });
}

function setupExport() {
  document.getElementById('btn_export_png').addEventListener('click', () => {
    const link = document.createElement('a');
    link.download = `${state.plano.elemento || 'viga'}.png`;
    link.href = document.getElementById('beam_canvas').toDataURL('image/png');
    link.click();
  });

  document.getElementById('btn_export_json').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `${state.plano.elemento || 'viga'}.json`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('input_import_json').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        state = JSON.parse(reader.result);
        refreshAllInputs();
        recalc();
      } catch (err) {
        alert('No se pudo leer el archivo JSON: ' + err.message);
      }
    };
    reader.readAsText(file);
  });

  document.getElementById('btn_print_report').addEventListener('click', () => window.print());
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  canvas = createBeamCanvas(document.getElementById('beam_canvas'));
  beam3D = createBeam3D(document.getElementById('beam_3d_container'));
  populateRebarSelects();
  refreshAllInputs();
  bindInputs();
  setupTabs('[data-input-tab]', 'input-tab');
  setupTabs('[data-result-tab]', 'result-tab');
  setupCanvasModeButtons();
  setupLoadModeToggle();
  setupTheme();
  setupPresets();
  setupExport();
  updateTypeTabsVisibility();
  if (window.lucide) window.lucide.createIcons();
  recalc();
});
