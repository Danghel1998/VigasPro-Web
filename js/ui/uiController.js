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
import { combineLoads, analyzeSimpleBeam } from '../engine/loadAnalysis.js';
import { calculateBeamRebarSchedule } from '../engine/rebarSchedule.js';
import { createBeamCanvas } from '../visualizer/beamCanvas.js';

function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

let state = clone(DEFAULT_BEAM_DATA);
let lastAnalysis = null, lastStruct = null, lastRebarSched = null;

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

function renderMemoria(data, analysis, struct) {
  const el = document.getElementById('report_panel');
  el.innerHTML = `
    <div class="p-8 max-w-3xl mx-auto bg-white text-sm leading-relaxed">
      <h1 class="text-xl font-extrabold mb-1">Memoria de Cálculo — Diseño de Viga</h1>
      <p class="text-slate-500 text-xs mb-6">${data.plano.elemento} · Norma E.060 / ACI 318 · Generado por VigasPro</p>

      <h2 class="font-bold text-base mt-6 mb-2 border-b pb-1">1. Datos de Entrada</h2>
      <p>Luz: $L = ${fmt(data.geometry.L,2)}\\ m$ &nbsp; Sección: $b \\times h = ${fmt(data.geometry.b*100,0)} \\times ${fmt(data.geometry.h*100,0)}\\ cm$</p>
      <p>Materiales: $f'c = ${fmt(data.materials.fc_kgcm2,0)}\\ kg/cm^2$, $f_y = ${fmt(data.materials.fy_kgcm2,0)}\\ kg/cm^2$</p>
      <p>Cargas de servicio: $w_D = ${fmt(struct.wd_total,0)}\\ kg/m$ (incluye peso propio ${fmt(struct.selfWeight,0)} kg/m), $w_L = ${fmt(data.loads.wl,0)}\\ kg/m$</p>

      <h2 class="font-bold text-base mt-6 mb-2 border-b pb-1">2. Combinación de Cargas y Análisis</h2>
      <p>$$W_u = 1.4 W_D + 1.7 W_L = ${fmt(struct.wd_total,0)} \\times 1.4 + ${fmt(data.loads.wl,0)} \\times 1.7 = ${fmt(struct.wu,0)}\\ kg/m$$</p>
      <p>Momento último máximo (superposición de reacciones, viga simplemente apoyada):</p>
      <p>$$M_u = ${fmt(struct.flexure.Mu_kgm,0)}\\ kg{\\cdot}m \\ \\text{ en } x = ${fmt(struct.flexure.Mu_x,2)}\\ m$$</p>
      <p>Cortante último en la cara del apoyo: $V_u = ${fmt(struct.shear.Vu_face,0)}\\ kg$; a distancia $d$: $V_u = ${fmt(struct.shear.Vu_d,0)}\\ kg$</p>

      <h2 class="font-bold text-base mt-6 mb-2 border-b pb-1">3. Diseño a Flexión</h2>
      <p>Peralte efectivo: $d = h - r - \\phi_{estribo} - \\phi_{principal}/2 = ${fmt(struct.d_m*100,1)}\\ cm$</p>
      <p>$$R_n = \\frac{M_u}{\\phi\\, b\\, d^2} = ${fmt(struct.flexure.Rn,1)}\\ kg/cm^2 \\qquad \\rho = \\frac{0.85 f'c}{f_y}\\left(1-\\sqrt{1-\\frac{2R_n}{0.85f'c}}\\right) = ${fmt(struct.flexure.rho*100,3)}\\%$$</p>
      <p>$A_{s,calc} = ${fmt(struct.flexure.As_calc,2)}\\ cm^2$, $A_{s,min} = ${fmt(struct.flexure.As_min,2)}\\ cm^2$, $A_{s,max} = ${fmt(struct.flexure.As_max,2)}\\ cm^2$</p>
      <p class="font-bold">$A_{s,\\text{diseño}} = ${fmt(struct.flexure.As_design,2)}\\ cm^2$ &rarr; ${struct.flexure.bottom.n_bars} ${struct.rebars.bottom.inches} (As provisto = ${fmt(struct.flexure.bottom.As_prov_cm2,2)} cm²)</p>
      ${struct.flexure.doubleReinfRequired ? '<p class="text-rose-700 font-bold">⚠️ La sección requiere doble refuerzo o mayor peralte — fuera del alcance de este módulo (MVP de refuerzo simple).</p>' : ''}

      <h2 class="font-bold text-base mt-6 mb-2 border-b pb-1">4. Diseño a Cortante</h2>
      <p>$$V_c = 0.53\\sqrt{f'c}\\, b\\, d = ${fmt(struct.shear.Vc,0)}\\ kg \\qquad \\phi V_c = ${fmt(struct.shear.phiVc,0)}\\ kg$$</p>
      ${struct.shear.requiresStirrupsByCalc
        ? `<p>$$V_s = \\frac{V_u}{\\phi} - V_c = ${fmt(struct.shear.Vs_req,0)}\\ kg \\qquad s = \\frac{A_v f_y d}{V_s} \\rightarrow s_{\\text{diseño}} = ${fmt(struct.shear.s_end_cm,1)}\\ cm$$</p>`
        : `<p>$V_u \\le \\phi V_c$: se usa el espaciamiento máximo constructivo, $s = ${fmt(struct.shear.s_end_cm,1)}\\ cm$.</p>`}
      <p>Zona central (fuera de la zona de extremos, $L_{ext} = ${fmt(struct.shear.endZoneLength_m,2)}\\ m$): $s = ${fmt(struct.shear.s_mid_cm,1)}\\ cm$ (espaciamiento máximo $\\min(d/2, 60cm)$).</p>
      ${struct.shear.exceedsCapacity ? '<p class="text-rose-700 font-bold">⚠️ Vs requerido excede el límite máximo de la norma — aumentar la sección.</p>' : ''}

      <h2 class="font-bold text-base mt-6 mb-2 border-b pb-1">5. Verificación por Deflexión</h2>
      <p>Elemento simplemente apoyado, sin tabiquería susceptible a dañarse: $h_{min} = L/16 = ${fmt(struct.deflection.h_min*100,1)}\\ cm$. Peralte provisto $h = ${fmt(data.geometry.h*100,1)}\\ cm$ &rarr; <strong>${struct.deflection.passes ? 'Cumple' : 'No cumple'}</strong>.</p>
    </div>`;

  if (window.renderMathInElement) {
    window.renderMathInElement(el, {
      delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }],
      strict: false,
    });
  }
}

function recalc() {
  const { analysis, struct } = designBeam(state);
  lastAnalysis = analysis; lastStruct = struct;
  lastRebarSched = calculateBeamRebarSchedule(state, struct, struct.rebars);

  renderKPIs(struct);
  renderResultsTable(struct);
  renderRebarTable(lastRebarSched);
  renderMemoria(state, analysis, struct);

  analysis.struct = struct;
  canvas.render(state, analysis, struct.rebars);
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
  document.querySelectorAll('[data-canvas-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-canvas-mode]').forEach((b) => {
        b.classList.remove('bg-indigo-600', 'text-white');
        b.classList.add('bg-slate-100', 'text-slate-700');
      });
      btn.classList.remove('bg-slate-100', 'text-slate-700');
      btn.classList.add('bg-indigo-600', 'text-white');
      canvas.setMode(btn.dataset.canvasMode);
    });
  });
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
  // Reservado para futuras variantes de tipo de viga; MVP solo tiene "simple".
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
  populateRebarSelects();
  refreshAllInputs();
  bindInputs();
  setupTabs('[data-input-tab]', 'input-tab');
  setupTabs('[data-result-tab]', 'result-tab');
  setupCanvasModeButtons();
  setupTheme();
  setupPresets();
  setupExport();
  if (window.lucide) window.lucide.createIcons();
  recalc();
});
