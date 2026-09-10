/**
 * Controlador reactivo de la UI: wiring de inputs (data-bind), orquestación
 * del cálculo (designBeam), render de resultados/memoria/cuadro de acero,
 * y utilidades de exportación (PNG/JSON/impresión). Mismo patrón general
 * que MurosPro-Web/js/ui/uiController.js y ZapatasPro-Web equivalente.
 */

import { REBAR_TABLE, STIRRUP_REBAR_IDS, DEFAULT_BEAM_DATA, PRESET_PROJECTS } from '../constants.js';
import {
  calcRequiredRebar, calcStirrupSpacing, roundSpacingDown,
  minDepthByDeflection_m, concreteShearCapacity_kg, PHI_SHEAR,
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

/**
 * Ordena visualmente las barras de una capa para el despiece: el grupo
 * principal (1°) va al centro y el grupo adicional (2°) va a los costados
 * (extremos, alternando lado), que es como se acostumbra a detallar en obra
 * — las barras "extra" quedan junto a los estribos y las principales al
 * medio. Devuelve un arreglo de objetos REBAR_TABLE, uno por posición,
 * ordenado de izquierda a derecha.
 */
function orderBarsForDisplay(groups) {
  const n = groups.reduce((s, g) => s + g.n, 0);
  const slots = new Array(n);
  let left = 0, right = n - 1;
  for (let gi = groups.length - 1; gi >= 1; gi--) {
    let remaining = groups[gi].n;
    while (remaining > 0 && left <= right) {
      slots[left] = groups[gi].rebar; remaining--; left++;
      if (remaining > 0 && left <= right) { slots[right] = groups[gi].rebar; remaining--; right--; }
    }
  }
  for (let i = left; i <= right; i++) slots[i] = groups[0].rebar;
  return slots;
}

/** Reparte un arreglo ya ordenado en `capas` filas horizontales, de tamaño
 * lo más parejo posible (el sobrante va en las primeras filas — las más
 * cercanas a la cara traccionada). */
function splitIntoRows(orderedBars, capas) {
  const n = orderedBars.length;
  const k = Math.max(1, capas);
  const base = Math.floor(n / k);
  const extra = n % k;
  const rows = [];
  let idx = 0;
  for (let r = 0; r < k; r++) {
    const count = base + (r < extra ? 1 : 0);
    rows.push(orderedBars.slice(idx, idx + count));
    idx += count;
  }
  return rows;
}

/**
 * Resuelve una capa de acero longitudinal ingresada manualmente (igual que
 * Columnas): hasta 2 grupos de diámetro/cantidad, repartidos en `cfg.capas`
 * filas horizontales cuando no caben (o no se quieren) todas juntas en una
 * sola fila. `id2 < 0` o `n2 <= 0` significa que el segundo grupo no se usa.
 * Devuelve el total de barras, el As provisto, el diámetro máximo, las
 * filas ya repartidas (`rows`) y una etiqueta legible.
 */
function resolveBarLayer(cfg) {
  const groups = [];
  const g1 = rebarById(cfg.id1);
  const n1 = Math.max(0, cfg.n1 || 0);
  if (n1 > 0) groups.push({ rebar: g1, n: n1 });
  if (cfg.id2 >= 0 && cfg.n2 > 0) {
    groups.push({ rebar: rebarById(cfg.id2), n: cfg.n2 });
  }
  const n_bars = groups.reduce((s, g) => s + g.n, 0);
  const As_prov_cm2 = groups.reduce((s, g) => s + g.n * g.rebar.area_cm2, 0);
  const maxDiameter_m = groups.length ? Math.max(...groups.map((g) => g.rebar.diameter_m)) : g1.diameter_m;
  const label = groups.length ? groups.map((g) => `${g.n} ${g.rebar.inches}`).join(' + ') : '— sin barras —';
  const capas = Math.max(1, cfg.capas || 1);
  const barsOrdered = groups.length ? orderBarsForDisplay(groups) : [];
  const rows = splitIntoRows(barsOrdered, capas);
  return { groups, n_bars, As_prov_cm2, maxDiameter_m, label, barsOrdered, rows, capas };
}

/** Espaciamiento libre vertical entre capas de acero (E.060/ACI 318: el
 * mayor entre 25mm y el diámetro de barra — se usa un valor fijo simple de
 * 2.5cm, suficiente para la mayoría de diámetros comerciales usuales). */
const CLEAR_SPACING_BETWEEN_LAYERS_M = 0.025;

/** Distancia desde la cara traccionada al centroide del acero de una capa
 * (ya repartida en filas por resolveBarLayer): promedio ponderado por
 * cantidad de barras de cada fila, cada una a su propia distancia a la cara
 * (cover + estribo + radio de su propia barra + filas previas). Con 1 sola
 * fila se reduce exactamente al cálculo simple de siempre. */
function centroidDistFromFace_m(layer, cover_m, stirrupDiameter_m) {
  let sumND = 0, sumN = 0;
  layer.rows.forEach((row, i) => {
    if (row.length === 0) return;
    const rowDiameter_m = Math.max(...row.map((r) => r.diameter_m));
    const y = cover_m + stirrupDiameter_m + rowDiameter_m / 2.0 + i * (layer.maxDiameter_m + CLEAR_SPACING_BETWEEN_LAYERS_M);
    sumND += row.length * y;
    sumN += row.length;
  });
  return sumN > 0 ? sumND / sumN : cover_m + stirrupDiameter_m + layer.maxDiameter_m / 2.0;
}

// ---------------------------------------------------------------------------
// Motor de diseño: combina análisis de cargas + diseño en concreto armado
// ---------------------------------------------------------------------------
function designBeam(data) {
  return data.loads.mode === 'etabs' ? designBeamEtabs(data) : designBeamManual(data);
}

/**
 * Ensambla los resultados de diseño (flexión + cortante + deflexión) a
 * partir de la envolvente de momentos/cortante ya obtenida (por análisis
 * directo en modo manual, o por combinaciones E.060 en modo ETABS). El
 * acero longitudinal es el que el usuario ingresó manualmente (igual que
 * Columnas) — aquí solo se verifica si el As provisto cubre el requerido.
 */
function buildStruct(data, { Mu_pos, Mu_neg, Vu_face, Vu_design, endZoneLength_m }) {
  const { b, h, L } = data.geometry;
  const { phi_flex, phi_shear } = data.safety_req;

  const rebarStirrup = rebarById(data.materials.rebar_stirrup_id);
  const bottomLayer = resolveBarLayer(data.materials.bottom);
  const topLayer = resolveBarLayer(data.materials.top);
  // Peralte efectivo al centroide del acero (si hay más de una capa, se
  // pondera por cantidad de barras de cada fila) — se toma la distancia
  // mayor entre inferior y superior, mismo criterio simplificado de antes.
  const bottomDist = centroidDistFromFace_m(bottomLayer, data.materials.cover, rebarStirrup.diameter_m);
  const topDist = centroidDistFromFace_m(topLayer, data.materials.cover, rebarStirrup.diameter_m);
  const d_m = h - Math.max(bottomDist, topDist);

  const bottomCalc = calcRequiredRebar(Mu_pos, data.materials.fc_kgcm2, data.materials.fy_kgcm2, b, d_m, phi_flex);
  const topCalc = calcRequiredRebar(Mu_neg, data.materials.fc_kgcm2, data.materials.fy_kgcm2, b, d_m, phi_flex);

  const Av_cm2 = 2 * rebarStirrup.area_cm2; // estribo cerrado de 2 ramas
  const spacing = calcStirrupSpacing(Vu_design, data.materials.fc_kgcm2, data.materials.fy_kgcm2, b, d_m, Av_cm2, phi_shear);
  const s_end_cm = roundSpacingDown(spacing.s_cm);
  const s_mid_cm = roundSpacingDown(Math.min((d_m * 100) / 2.0, 60.0));

  const h_min = minDepthByDeflection_m(L);

  return {
    d_m,
    flexure: {
      Mu_kgm: Mu_pos, Mu_neg_kgm: Mu_neg,
      ...bottomCalc,
      bottom: { ...bottomCalc, ...bottomLayer, ok: bottomLayer.As_prov_cm2 >= bottomCalc.As_design },
      top: { ...topCalc, ...topLayer, ok: topLayer.As_prov_cm2 >= topCalc.As_design },
      doubleReinfRequired: bottomCalc.doubleReinfRequired || topCalc.doubleReinfRequired,
    },
    shear: {
      Vu_face, Vu_d: Vu_design, ...spacing,
      s_end_cm, s_mid_cm, endZoneLength_m,
    },
    deflection: { h_min, passes: h >= h_min },
    rebars: { stirrup: rebarStirrup },
  };
}

function designBeamManual(data) {
  const { L, b, h } = data.geometry;
  const { LF_D, LF_L } = data.safety_req;
  const gamma_c = data.materials.gamma_c_kgm3;

  const selfWeight = data.loads.include_self_weight ? gamma_c * b * h : 0;
  const wd_total = data.loads.wd + selfWeight;
  const wu = combineLoads(wd_total, data.loads.wl, LF_D, LF_L);

  const pointLoadsU = (data.loads.point_loads || [])
    .filter(p => (p.Pd + p.Pl) > 0)
    .map(p => ({ pos: p.pos, Pu: combineLoads(p.Pd, p.Pl, LF_D, LF_L) }));

  const analysis = analyzeSimpleBeam(L, wu, pointLoadsU);

  // El peralte efectivo depende del acero elegido, así que primero se
  // resuelve una capa "provisional" solo para ubicar la sección crítica de
  // cortante a distancia d (buildStruct la vuelve a calcular con detalle).
  const provisionalStirrup = rebarById(data.materials.rebar_stirrup_id);
  const provisionalBottom = resolveBarLayer(data.materials.bottom);
  const provisionalTop = resolveBarLayer(data.materials.top);
  const provisionalD = h - Math.max(
    centroidDistFromFace_m(provisionalBottom, data.materials.cover, provisionalStirrup.diameter_m),
    centroidDistFromFace_m(provisionalTop, data.materials.cover, provisionalStirrup.diameter_m)
  );

  const Vu_left_d = analysis.Vu_at(provisionalD);
  const Vu_right_d = -analysis.Vu_at(L - provisionalD);
  const Vu_d = Math.max(Math.abs(Vu_left_d), Math.abs(Vu_right_d));
  const Vu_face = Math.max(Math.abs(analysis.Vu_left_face), Math.abs(analysis.Vu_right_face));

  // Longitud de la zona de extremos: hasta donde Vu(x) cae por debajo de
  // phiVc/2 (criterio simplificado — a partir de ahí basta el espaciamiento
  // máximo constructivo). Se estima con la capacidad del concreto (no
  // depende de estribos), suficiente para ubicar la zona.
  const phiVcApprox = PHI_SHEAR * concreteShearCapacity_kg(data.materials.fc_kgcm2, b, provisionalD);
  let endZoneLength_m = L / 4;
  for (const pt of analysis.points) {
    if (Math.abs(pt.V) <= phiVcApprox / 2.0) { endZoneLength_m = pt.x; break; }
  }
  endZoneLength_m = Math.min(L / 2, Math.max(provisionalD, endZoneLength_m));

  const struct = buildStruct(data, {
    Mu_pos: analysis.Mu_max.M, Mu_neg: 0,
    Vu_face, Vu_design: Vu_d, endZoneLength_m,
  });
  struct.flexure.Mu_x = analysis.Mu_max.x;
  struct.wu = wu; struct.wd_total = wd_total; struct.selfWeight = selfWeight;

  return { analysis, struct };
}

/** Ton / Ton·m (ETABS) -> kg / kg·m (unidades internas del motor). */
function etabsCaseToKg(c) {
  return { M: (c.M || 0) * 1000, V: (c.V || 0) * 1000 };
}

/** Arma la envolvente ilustrativa (parábola tipo tramo continuo) para el
 * visualizador y devuelve la estructura de análisis compartida por ambos
 * sub-modos de ETABS ('cases' y 'direct'), a partir de Mu+/Mu-/Vu. */
function buildEtabsIllustrativeAnalysis(L, Mu_pos, Mu_neg, Vu) {
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
  return {
    points, Mu_max,
    Vu_left_face: Vu, Vu_right_face: Vu,
    Vu_at: () => Vu,
  };
}

/**
 * Diseño a partir de valores de servicio de ETABS (M, V) para CM/CV/Sismo
 * X/Sismo Y — mismo criterio del módulo de Columnas: se arman las 9
 * combinaciones E.060 y se toma la envolvente (Mu+ para el acero inferior,
 * Mu- para el superior, Vu para estribos). Un solo juego de valores para
 * toda la viga (sin variación por estación).
 */
function designBeamEtabsCases(data) {
  const { L } = data.geometry;
  const { LF_D, LF_L } = data.safety_req;

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
  const endZoneLength_m = Math.min(L / 2, L / 4);

  const struct = buildStruct(data, { Mu_pos, Mu_neg, Vu_face: Vu, Vu_design: Vu, endZoneLength_m });
  struct.flexure.Mu_x = L / 2;
  struct.etabs = { combos, posCombo, negCombo, vCombo, Mu_pos, Mu_neg, Vu };

  const analysis = buildEtabsIllustrativeAnalysis(L, Mu_pos, Mu_neg, Vu);
  return { analysis, struct };
}

/**
 * Diseño a partir de momentos últimos ya combinados, ingresados por
 * estación (Izquierdo/Medio/Derecho) y cara (inferior/superior) — igual
 * formato que una hoja de cálculo de viga continua leída de ETABS. El
 * acero se diseña con el mayor momento inferior (Mu+) y el mayor momento
 * superior (Mu-) de las 3 estaciones; además se calcula el As requerido en
 * cada una de las 6 celdas para mostrar la tabla detallada por estación
 * (struct.etabsStations), aunque el acero provisto es uno solo por capa.
 */
function designBeamEtabsDirect(data) {
  const { L, b } = data.geometry;
  const { fc_kgcm2, fy_kgcm2 } = data.materials;
  const { phi_flex } = data.safety_req;
  const st = data.loads.etabsDirect;

  const Mu_pos = Math.max(st.izq.Minf, st.medio.Minf, st.der.Minf, 0) * 1000;
  const Mu_neg = Math.max(st.izq.Msup, st.medio.Msup, st.der.Msup, 0) * 1000;
  const Vu = Math.abs(st.V || 0) * 1000;
  const endZoneLength_m = Math.min(L / 2, L / 4);

  const struct = buildStruct(data, { Mu_pos, Mu_neg, Vu_face: Vu, Vu_design: Vu, endZoneLength_m });
  struct.flexure.Mu_x = L / 2;

  const cell = (M_tonm) => ({ Mu_tonm: M_tonm, ...calcRequiredRebar(Math.abs(M_tonm) * 1000, fc_kgcm2, fy_kgcm2, b, struct.d_m, phi_flex) });
  struct.etabsStations = {
    izq:   { inf: cell(st.izq.Minf), sup: cell(st.izq.Msup) },
    medio: { inf: cell(st.medio.Minf), sup: cell(st.medio.Msup) },
    der:   { inf: cell(st.der.Minf), sup: cell(st.der.Msup) },
  };

  const analysis = buildEtabsIllustrativeAnalysis(L, Mu_pos, Mu_neg, Vu);
  return { analysis, struct };
}

function designBeamEtabs(data) {
  return data.loads.etabsInputMode === 'direct' ? designBeamEtabsDirect(data) : designBeamEtabsCases(data);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
let canvas;

function fmt(n, dec = 1) {
  if (!isFinite(n)) return '—';
  return n.toLocaleString('es-PE', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

/** Etiqueta de una capa de acero, indicando el N° de capas cuando hay más de una. */
function layerLabel(layer) {
  return layer.capas > 1 ? `${layer.label} (${layer.capas} capas)` : layer.label;
}

function renderKPIs(struct) {
  const banner = document.getElementById('global_status_banner');
  const problems = [];
  if (struct.flexure.doubleReinfRequired) problems.push('Requiere doble refuerzo (Mu excede la capacidad simplemente reforzada) o aumentar la sección.');
  if (!struct.flexure.bottom.ok) problems.push(`Acero inferior insuficiente: provisto ${fmt(struct.flexure.bottom.As_prov_cm2, 2)} cm² &lt; requerido ${fmt(struct.flexure.As_design, 2)} cm² — agrega barras o un diámetro mayor.`);
  if (!struct.flexure.top.ok) problems.push(`Acero superior insuficiente: provisto ${fmt(struct.flexure.top.As_prov_cm2, 2)} cm² &lt; requerido ${fmt(struct.flexure.top.As_design, 2)} cm².`);
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
    ['Acero inferior provisto', layerLabel(struct.flexure.bottom), fmt(struct.flexure.bottom.As_prov_cm2, 2) + ' cm²'],
    ['Acero superior (constructivo)', layerLabel(struct.flexure.top), fmt(struct.flexure.top.As_prov_cm2, 2) + ' cm²'],
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
    <div class="memoria-box" style="padding-top:14px">
    <div class="memoria-figure">
      <p class="caption">Figura 1 — Geometría y Cargas</p>
      ${shots.geometry ? `<img src="${shots.geometry}">` : ''}
      <p class="desc">Elevación esquemática de la viga con la luz, la sección transversal y las cargas actuantes.</p>
    </div>
    <div class="memoria-figure">
      <p class="caption">Figura 2 — Vista en Planta (Sección Transversal)</p>
      ${shots.planta ? `<img src="${shots.planta}">` : ''}
      <p class="desc">Sección b × h a escala, con recubrimiento, estribo y disposición del acero superior/inferior.</p>
    </div>
    <div class="memoria-figure">
      <p class="caption">Figura 3 — Despiece de Armadura (2D)</p>
      ${shots.rebar ? `<img src="${shots.rebar}">` : ''}
      <p class="desc">Disposición del acero longitudinal (superior e inferior) y espaciamiento de estribos por zonas.</p>
    </div>
    <div class="memoria-figure">
      <p class="caption">Figura 4 — Modelo 3D de Armadura</p>
      ${shots.render3d ? `<img src="${shots.render3d}">` : ''}
      <p class="desc">Vista tridimensional del concreto (translúcido), acero longitudinal y estribos.</p>
    </div>
    </div>`;
}

/** Redibuja el canvas 2D en los modos "geometry", "planta" y "rebar" para
 * capturar sus imágenes, restaura el modo activo del usuario, y toma una
 * foto del render 3D — todo para incrustar en la Memoria de Cálculo. */
function captureSnapshots() {
  const currentMode = canvas.getMode();
  canvas.setMode('geometry');
  const geometryShot = document.getElementById('beam_canvas').toDataURL('image/png');
  canvas.setMode('planta');
  const plantaShot = document.getElementById('beam_canvas').toDataURL('image/png');
  canvas.setMode('rebar');
  const rebarShot = document.getElementById('beam_canvas').toDataURL('image/png');
  canvas.setMode(currentMode);
  const render3dShot = beam3D ? beam3D.snapshot() : '';
  return { geometry: geometryShot, planta: plantaShot, rebar: rebarShot, render3d: render3dShot };
}

function renderMemoria(data, analysis, struct) {
  const el = document.getElementById('report_panel');
  const shots = captureSnapshots();
  const dbEst_cm = (struct.rebars.stirrup.diameter_mm / 10).toFixed(2);
  const dbMain_cm = (Math.max(struct.flexure.bottom.maxDiameter_m, struct.flexure.top.maxDiameter_m) * 100).toFixed(2);

  el.innerHTML = `
    <div class="memoria-doc p-6">
      ${memoriaHeaderHtml(data, 'Norma E.060 (Concreto Armado) / ACI 318 — Análisis por carga distribuida')}

      <div class="memoria-banner">I) DATOS DE DISEÑO</div>
      <div class="memoria-box">
        <div class="memoria-group memoria-datagrid">
          <span class="k">Luz libre (L)</span><span class="v">${fmt(data.geometry.L,2)} m</span>
          <span class="k">Sección (b × h)</span><span class="v">${fmt(data.geometry.b*100,0)} × ${fmt(data.geometry.h*100,0)} cm</span>
          <span class="k">Resistencia del concreto (f'c)</span><span class="v">${fmt(data.materials.fc_kgcm2,0)} kg/cm²</span>
          <span class="k">Resistencia del acero (fy)</span><span class="v">${fmt(data.materials.fy_kgcm2,0)} kg/cm²</span>
          <span class="k">Carga muerta (wD)</span><span class="v">${fmt(data.loads.wd,0)} kg/m${data.loads.include_self_weight ? ` + p.p. ${fmt(struct.selfWeight,0)}` : ''}</span>
          <span class="k">Carga viva (wL)</span><span class="v">${fmt(data.loads.wl,0)} kg/m</span>
        </div>
      </div>

      <div class="memoria-banner">II) ANÁLISIS DE CARGAS (E.060)</div>
      <div class="memoria-box">
        <div class="memoria-group">
          <p>Wu = 1.4·wD + 1.7·wL = 1.4 × ${fmt(struct.wd_total,0)} + 1.7 × ${fmt(data.loads.wl,0)}</p>
          <p><strong>Wu = ${fmt(struct.wu,0)} kg/m</strong></p>
        </div>
        <div class="memoria-group">
          <p>Momento último máximo (viga simplemente apoyada, superposición de reacciones):</p>
          <p><strong>Mu = ${fmt(struct.flexure.Mu_kgm,0)} kg·m</strong>, en x = ${fmt(struct.flexure.Mu_x,2)} m</p>
          <p>Vu en la cara del apoyo = ${fmt(struct.shear.Vu_face,0)} kg &nbsp;|&nbsp; Vu a distancia d (crítica) = <strong>${fmt(struct.shear.Vu_d,0)} kg</strong></p>
        </div>
      </div>

      <div class="memoria-banner">III) DISEÑO A FLEXIÓN (E.060 Capítulo 10)</div>
      <div class="memoria-box">
        <div class="memoria-group">
          <p>d = h − r − øe − øp/2 = ${fmt(data.geometry.h*100,1)} − ${fmt(data.materials.cover*100,1)} − ${dbEst_cm} − ${dbMain_cm}/2</p>
          <p><strong>d = ${fmt(struct.d_m*100,1)} cm</strong></p>
        </div>
        <div class="memoria-group">
          <p>Rn = Mu/(φ·b·d²) = (${fmt(struct.flexure.Mu_kgm,0)} × 100)/(0.90 × ${fmt(data.geometry.b*100,0)} × ${fmt(struct.d_m*100,1)}²) = <strong>${fmt(struct.flexure.Rn,1)} kg/cm²</strong></p>
          <p>ρ = (0.85f'c/fy)·[1 − √(1 − 2Rn/0.85f'c)] = <strong>${fmt(struct.flexure.rho*100,3)} %</strong></p>
        </div>
        <div class="memoria-group">
          <p>As,calc = ρ·b·d = ${fmt(struct.flexure.As_calc,2)} cm² &nbsp;|&nbsp; As,min = ${fmt(struct.flexure.As_min,2)} cm² &nbsp;|&nbsp; As,max = ${fmt(struct.flexure.As_max,2)} cm²</p>
          <p><strong>As,diseño = ${fmt(struct.flexure.As_design,2)} cm²</strong> &rarr; <strong>${layerLabel(struct.flexure.bottom)}</strong> (As provisto = ${fmt(struct.flexure.bottom.As_prov_cm2,2)} cm²) <span class="${struct.flexure.bottom.ok ? 'memoria-badge-ok' : 'memoria-badge-warn'}">${struct.flexure.bottom.ok ? 'CUMPLE' : 'REVISAR'}</span></p>
          <p>Acero superior (constructivo, As mín = ${fmt(struct.flexure.top.As_design,2)} cm²): ${layerLabel(struct.flexure.top)} (As provisto = ${fmt(struct.flexure.top.As_prov_cm2,2)} cm²) <span class="${struct.flexure.top.ok ? 'memoria-badge-ok' : 'memoria-badge-warn'}">${struct.flexure.top.ok ? 'CUMPLE' : 'REVISAR'}</span></p>
        </div>
        ${struct.flexure.doubleReinfRequired ? `<div class="memoria-group"><p><span class="memoria-badge-warn">ATENCIÓN</span> La sección requiere doble refuerzo o mayor peralte — fuera del alcance de este módulo.</p></div>` : ''}
      </div>

      <div class="memoria-banner">IV) DISEÑO A CORTANTE (E.060 Capítulo 13)</div>
      <div class="memoria-box">
        <div class="memoria-group">
          <p>Vc = 0.53·√f'c·b·d = 0.53 × √${fmt(data.materials.fc_kgcm2,0)} × ${fmt(data.geometry.b*100,0)} × ${fmt(struct.d_m*100,1)}</p>
          <p><strong>Vc = ${fmt(struct.shear.Vc,0)} kg</strong> &nbsp; φVc = ${fmt(struct.shear.phiVc,0)} kg</p>
        </div>
        <div class="memoria-group">
          ${struct.shear.requiresStirrupsByCalc
            ? `<p>Vs = Vu/φ − Vc = ${fmt(struct.shear.Vu_d,0)}/0.85 − ${fmt(struct.shear.Vc,0)} = <strong>${fmt(struct.shear.Vs_req,0)} kg</strong></p>`
            : `<p>Vu ≤ φVc: no se requieren estribos por cálculo, se usa el espaciamiento máximo constructivo.</p>`}
          <p>s = Av·fy·d/Vs &rarr; <strong>s = ${fmt(struct.shear.s_end_cm,1)} cm</strong> (extremos, Lext = ${fmt(struct.shear.endZoneLength_m,2)} m) &nbsp;|&nbsp; s = mín(d/2,60cm) = <strong>${fmt(struct.shear.s_mid_cm,1)} cm</strong> (centro)</p>
          <p>=&gt; Estribos ${struct.rebars.stirrup.inches}: @ ${fmt(struct.shear.s_end_cm,1)}cm (extremos) / @ ${fmt(struct.shear.s_mid_cm,1)}cm (centro)</p>
        </div>
        ${struct.shear.exceedsCapacity ? `<div class="memoria-group"><p><span class="memoria-badge-warn">ATENCIÓN</span> Vs requerido excede el límite máximo de la norma — aumentar la sección.</p></div>` : ''}
      </div>

      <div class="memoria-banner">V) VERIFICACIÓN POR DEFLEXIÓN (E.060 Art. 9.6.2)</div>
      <div class="memoria-box">
        <div class="memoria-group">
          <p>Elemento simplemente apoyado, sin tabiquería susceptible a dañarse: h,min = L/16 = ${fmt(data.geometry.L,2)}/16 = <strong>${fmt(struct.deflection.h_min*100,1)} cm</strong></p>
          <p>Peralte provisto h = ${fmt(data.geometry.h*100,1)} cm &rarr; <span class="${struct.deflection.passes ? 'memoria-badge-ok' : 'memoria-badge-warn'}">${struct.deflection.passes ? 'CUMPLE' : 'NO CUMPLE'}</span></p>
        </div>
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

/** Tabla de As requerido por estación (Izq/Medio/Der) y cara (inf/sup),
 * igual formato que una hoja de cálculo de viga continua — informativa: el
 * acero realmente provisto se diseña con la envolvente (mayor Mu de las 3
 * estaciones), no varía celda por celda. */
function etabsStationsTableHtml(struct) {
  const st = struct.etabsStations;
  const cols = [
    ['Nudo Izq.', st.izq.inf, st.izq.sup],
    ['Medio', st.medio.inf, st.medio.sup],
    ['Nudo Der.', st.der.inf, st.der.sup],
  ];
  const th = cols.map(([name]) => `<th colspan="2" style="text-align:center">${name}</th>`).join('');
  const subth = cols.map(() => `<th style="text-align:right">M inf</th><th style="text-align:right">M sup</th>`).join('');
  function row(label, pick, dec) {
    const cells = cols.map(([, inf, sup]) => `<td style="text-align:right">${fmt(pick(inf), dec)}</td><td style="text-align:right">${fmt(pick(sup), dec)}</td>`).join('');
    return `<tr><td>${label}</td>${cells}</tr>`;
  }
  return `
    <table class="memoria-table">
      <thead>
        <tr><th></th>${th}</tr>
        <tr><th></th>${subth}</tr>
      </thead>
      <tbody>
        ${row('Mu (Ton·m)', (c) => c.Mu_tonm, 2)}
        ${row('As calc (cm²)', (c) => c.As_calc, 2)}
        ${row('As mín (cm²)', (c) => c.As_min, 2)}
        ${row('As máx (cm²)', (c) => c.As_max, 2)}
        ${row('As req (cm²)', (c) => c.As_design, 2)}
      </tbody>
    </table>`;
}

function renderResultsTableEtabs(struct) {
  const el = document.getElementById('results_table_body');
  const hasCombos = !!struct.etabs;
  const rows = [
    ['Momento positivo envolvente Mu+', fmt(struct.flexure.Mu_kgm, 0) + ' kg·m', hasCombos ? `combo: ${struct.etabs.posCombo.nombre}` : 'leído del diagrama ETABS'],
    ['Momento negativo envolvente Mu−', fmt(struct.flexure.Mu_neg_kgm, 0) + ' kg·m', hasCombos ? `combo: ${struct.etabs.negCombo.nombre}` : 'leído del diagrama ETABS'],
    ['Cortante envolvente Vu', fmt(struct.shear.Vu_face, 0) + ' kg', hasCombos ? `combo: ${struct.etabs.vCombo.nombre}` : 'leído del diagrama ETABS'],
    ['Peralte efectivo d', fmt(struct.d_m * 100, 1) + ' cm', ''],
    ['As requerido (inferior, por Mu+)', fmt(struct.flexure.As_design, 2) + ' cm²', `As_min=${fmt(struct.flexure.As_min, 2)}, As_max=${fmt(struct.flexure.As_max, 2)}`],
    ['Acero inferior provisto', layerLabel(struct.flexure.bottom), fmt(struct.flexure.bottom.As_prov_cm2, 2) + ' cm²'],
    ['As requerido (superior, por Mu−)', fmt(struct.flexure.top.As_design, 2) + ' cm²', `As_min=${fmt(struct.flexure.top.As_min, 2)}`],
    ['Acero superior provisto', layerLabel(struct.flexure.top), fmt(struct.flexure.top.As_prov_cm2, 2) + ' cm²'],
    ['Capacidad del concreto φVc', fmt(struct.shear.phiVc, 0) + ' kg', `Vc=${fmt(struct.shear.Vc, 0)}`],
    ['Estribos', struct.rebars.stirrup.inches, `@${fmt(struct.shear.s_end_cm, 1)}cm (extremos) / @${fmt(struct.shear.s_mid_cm, 1)}cm (centro)`],
    ['Peralte mínimo por deflexión', fmt(struct.deflection.h_min * 100, 1) + ' cm', struct.deflection.passes ? 'Cumple' : 'No cumple'],
  ];
  el.innerHTML = rows.map(r => `<tr class="border-b border-slate-100"><td class="py-1.5 pr-3 font-semibold text-slate-700">${r[0]}</td><td class="py-1.5 pr-3 font-mono text-slate-900">${r[1]}</td><td class="py-1.5 text-slate-500 text-[11px]">${r[2]}</td></tr>`).join('');

  const comboSection = document.getElementById('etabs_combos_section');
  if (comboSection) {
    comboSection.classList.toggle('hidden', !hasCombos);
    if (hasCombos) document.getElementById('etabs_combos_body').innerHTML = comboRowsHtml(struct);
  }

  const hasStations = !!struct.etabsStations;
  const stationsSection = document.getElementById('etabs_stations_section');
  if (stationsSection) {
    stationsSection.classList.toggle('hidden', !hasStations);
    if (hasStations) document.getElementById('etabs_stations_body').innerHTML = etabsStationsTableHtml(struct);
  }
}

function renderMemoriaEtabs(data, struct) {
  const el = document.getElementById('report_panel');
  const shots = captureSnapshots();
  const hasCombos = !!struct.etabs;
  const e = data.loads.etabs;
  const dbEst_cm = (struct.rebars.stirrup.diameter_mm / 10).toFixed(2);
  const dbMain_cm = (Math.max(struct.flexure.bottom.maxDiameter_m, struct.flexure.top.maxDiameter_m) * 100).toFixed(2);

  const datosBox = hasCombos ? `
      <div class="memoria-banner">I) DATOS DE DISEÑO</div>
      <div class="memoria-box">
        <div class="memoria-group memoria-datagrid">
          <span class="k">Sección (b × h)</span><span class="v">${fmt(data.geometry.b*100,0)} × ${fmt(data.geometry.h*100,0)} cm</span>
          <span class="k">Luz (L)</span><span class="v">${fmt(data.geometry.L,2)} m</span>
          <span class="k">Resistencia del concreto (f'c)</span><span class="v">${fmt(data.materials.fc_kgcm2,0)} kg/cm²</span>
          <span class="k">Resistencia del acero (fy)</span><span class="v">${fmt(data.materials.fy_kgcm2,0)} kg/cm²</span>
        </div>
        <div class="memoria-group">
          <table class="memoria-table">
            <thead><tr><th>Caso</th><th style="text-align:right">M (Ton·m)</th><th style="text-align:right">V (Ton)</th></tr></thead>
            <tbody>
              <tr><td>CM</td><td style="text-align:right">${fmt(e.CM.M,3)}</td><td style="text-align:right">${fmt(e.CM.V,3)}</td></tr>
              <tr><td>CV</td><td style="text-align:right">${fmt(e.CV.M,3)}</td><td style="text-align:right">${fmt(e.CV.V,3)}</td></tr>
              <tr><td>Sismo X</td><td style="text-align:right">${fmt(e.SISXX.M,3)}</td><td style="text-align:right">${fmt(e.SISXX.V,3)}</td></tr>
              <tr><td>Sismo Y</td><td style="text-align:right">${fmt(e.SISYY.M,3)}</td><td style="text-align:right">${fmt(e.SISYY.V,3)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>` : `
      <div class="memoria-banner">I) DATOS DE DISEÑO</div>
      <div class="memoria-box">
        <div class="memoria-group memoria-datagrid">
          <span class="k">Sección (b × h)</span><span class="v">${fmt(data.geometry.b*100,0)} × ${fmt(data.geometry.h*100,0)} cm</span>
          <span class="k">Luz (L)</span><span class="v">${fmt(data.geometry.L,2)} m</span>
          <span class="k">Resistencia del concreto (f'c)</span><span class="v">${fmt(data.materials.fc_kgcm2,0)} kg/cm²</span>
          <span class="k">Resistencia del acero (fy)</span><span class="v">${fmt(data.materials.fy_kgcm2,0)} kg/cm²</span>
        </div>
      </div>`;

  const combosBox = hasCombos ? (() => {
    const comboRows = struct.etabs.combos.map((c) => {
      const tag = [c === struct.etabs.posCombo && 'M+', c === struct.etabs.negCombo && 'M−', c === struct.etabs.vCombo && 'V'].filter(Boolean).join('/');
      return `<tr><td>${c.nombre}</td><td style="text-align:right">${fmt(c.M,0)}</td><td style="text-align:right">${fmt(c.V,0)}</td><td style="text-align:center;font-weight:700;color:#4338ca">${tag}</td></tr>`;
    }).join('');
    return `
      <div class="memoria-banner">II) COMBINACIONES DE CARGA E.060 (9 combinaciones)</div>
      <div class="memoria-box">
        <div class="memoria-group">
          <p>1.4CM+1.7CV; 1.25(CM+CV)±SISXX; 0.9CM±SISXX; 1.25(CM+CV)±SISYY; 0.9CM±SISYY</p>
        </div>
        <div class="memoria-group">
          <table class="memoria-table">
            <thead><tr><th>Combinación</th><th style="text-align:right">M (kg·m)</th><th style="text-align:right">V (kg)</th><th>Gobierna</th></tr></thead>
            <tbody>${comboRows}</tbody>
          </table>
        </div>
        <div class="memoria-group">
          <p><strong>Envolvente de diseño:</strong></p>
          <p>Mu+ = ${fmt(struct.etabs.Mu_pos,0)} kg·m (${struct.etabs.posCombo.nombre}) &nbsp;|&nbsp; Mu− = ${fmt(struct.etabs.Mu_neg,0)} kg·m (${struct.etabs.negCombo.nombre})</p>
          <p>Vu = ${fmt(struct.etabs.Vu,0)} kg (${struct.etabs.vCombo.nombre})</p>
        </div>
      </div>`;
  })() : `
      <div class="memoria-banner">II) MOMENTOS POR ESTACIÓN (leídos del diagrama envolvente de ETABS)</div>
      <div class="memoria-box">
        <div class="memoria-group">
          <p>Momentos últimos ya combinados, ingresados por estación (izquierdo/medio/derecho) e inferior/superior — igual formato que una viga continua leída de ETABS:</p>
        </div>
        <div class="memoria-group">
          ${etabsStationsTableHtml(struct)}
        </div>
        <div class="memoria-group">
          <p><strong>Envolvente de diseño</strong> (mayor valor de las 3 estaciones):</p>
          <p><strong>Mu+ = ${fmt(struct.flexure.Mu_kgm,0)} kg·m</strong> (inferior) &nbsp;|&nbsp; <strong>Mu− = ${fmt(struct.flexure.Mu_neg_kgm,0)} kg·m</strong> (superior) &nbsp;|&nbsp; <strong>Vu = ${fmt(struct.shear.Vu_face,0)} kg</strong></p>
        </div>
      </div>`;

  el.innerHTML = `
    <div class="memoria-doc p-6">
      ${memoriaHeaderHtml(data, hasCombos ? 'Norma E.060 (Concreto Armado) / ACI 318 — Valores de servicio de ETABS' : 'Norma E.060 (Concreto Armado) / ACI 318 — Momentos leídos del diagrama de ETABS')}

      ${datosBox}
      ${combosBox}

      <div class="memoria-banner">III) DISEÑO A FLEXIÓN (E.060 Capítulo 10)</div>
      <div class="memoria-box">
        <div class="memoria-group">
          <p>d = h − r − øe − øp/2 = ${fmt(data.geometry.h*100,1)} − ${fmt(data.materials.cover*100,1)} − ${dbEst_cm} − ${dbMain_cm}/2</p>
          <p><strong>d = ${fmt(struct.d_m*100,1)} cm</strong></p>
        </div>
        <div class="memoria-group">
          <p><strong>Acero inferior (por Mu+):</strong> As,diseño = ${fmt(struct.flexure.As_design,2)} cm² &rarr; <strong>${layerLabel(struct.flexure.bottom)}</strong> (As provisto = ${fmt(struct.flexure.bottom.As_prov_cm2,2)} cm²) <span class="${struct.flexure.bottom.ok ? 'memoria-badge-ok' : 'memoria-badge-warn'}">${struct.flexure.bottom.ok ? 'CUMPLE' : 'REVISAR'}</span></p>
        </div>
        <div class="memoria-group">
          <p><strong>Acero superior (por Mu−):</strong> As,diseño = ${fmt(struct.flexure.top.As_design,2)} cm² &rarr; <strong>${layerLabel(struct.flexure.top)}</strong> (As provisto = ${fmt(struct.flexure.top.As_prov_cm2,2)} cm²) <span class="${struct.flexure.top.ok ? 'memoria-badge-ok' : 'memoria-badge-warn'}">${struct.flexure.top.ok ? 'CUMPLE' : 'REVISAR'}</span></p>
        </div>
        ${struct.flexure.doubleReinfRequired ? `<div class="memoria-group"><p><span class="memoria-badge-warn">ATENCIÓN</span> La sección requiere doble refuerzo o mayor peralte.</p></div>` : ''}
      </div>

      <div class="memoria-banner">IV) DISEÑO A CORTANTE (E.060 Capítulo 13)</div>
      <div class="memoria-box">
        <div class="memoria-group">
          <p>Vc = 0.53·√f'c·b·d = <strong>${fmt(struct.shear.Vc,0)} kg</strong> &nbsp; φVc = ${fmt(struct.shear.phiVc,0)} kg</p>
          ${struct.shear.requiresStirrupsByCalc
            ? `<p>Vs = Vu/φ − Vc = <strong>${fmt(struct.shear.Vs_req,0)} kg</strong></p>`
            : `<p>Vu ≤ φVc: se usa el espaciamiento máximo constructivo.</p>`}
          <p><strong>s = ${fmt(struct.shear.s_end_cm,1)} cm</strong> (extremos) &nbsp;|&nbsp; <strong>${fmt(struct.shear.s_mid_cm,1)} cm</strong> (centro)</p>
        </div>
        ${struct.shear.exceedsCapacity ? `<div class="memoria-group"><p><span class="memoria-badge-warn">ATENCIÓN</span> Vs requerido excede el límite máximo de la norma.</p></div>` : ''}
      </div>

      <div class="memoria-banner">V) VERIFICACIÓN POR DEFLEXIÓN (E.060 Art. 9.6.2)</div>
      <div class="memoria-box">
        <div class="memoria-group">
          <p>h,min = L/16 = <strong>${fmt(struct.deflection.h_min*100,1)} cm</strong>. Peralte provisto h = ${fmt(data.geometry.h*100,1)} cm &rarr; <span class="${struct.deflection.passes ? 'memoria-badge-ok' : 'memoria-badge-warn'}">${struct.deflection.passes ? 'CUMPLE' : 'NO CUMPLE'}</span></p>
        </div>
      </div>

      ${memoriaFigurasHtml(shots)}
    </div>`;
}

function recalc() {
  const { analysis, struct } = designBeam(state);
  lastAnalysis = analysis; lastStruct = struct;
  lastRebarSched = calculateBeamRebarSchedule(state, struct, struct.rebars.stirrup);
  analysis.struct = struct;

  // El canvas 2D y la escena 3D se actualizan ANTES de generar la Memoria,
  // para que captureSnapshots() (dentro de renderMemoria/renderMemoriaEtabs)
  // capture siempre los datos recién calculados, no los del recalc anterior.
  canvas.render(state, analysis, struct.rebars.stirrup);
  beam3D.update(state, struct);

  renderKPIs(struct);
  if (state.loads.mode === 'etabs') {
    renderResultsTableEtabs(struct);
    renderMemoriaEtabs(state, struct);
  } else {
    document.getElementById('etabs_combos_section')?.classList.add('hidden');
    document.getElementById('etabs_stations_section')?.classList.add('hidden');
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
  const mainOptionsWithNone = `<option value="-1">— Ninguna —</option>` + mainOptions;
  const stirrupOptions = STIRRUP_REBAR_IDS.map((i) => `<option value="${i}">${REBAR_TABLE[i].name}</option>`).join('');
  ['top_id1', 'bottom_id1'].forEach((id) => { document.getElementById(`rebar_${id}`).innerHTML = mainOptions; });
  ['top_id2', 'bottom_id2'].forEach((id) => { document.getElementById(`rebar_${id}`).innerHTML = mainOptionsWithNone; });
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
    updateEtabsInputModeVisibility();
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

function updateEtabsInputModeVisibility() {
  const mode = state.loads.etabsInputMode;
  document.querySelectorAll('.only-etabs-cases').forEach((el) => el.classList.toggle('hidden', mode !== 'cases'));
  document.querySelectorAll('.only-etabs-direct').forEach((el) => el.classList.toggle('hidden', mode !== 'direct'));
  document.querySelectorAll('[data-etabs-input-mode]').forEach((btn) => {
    const active = btn.dataset.etabsInputMode === mode;
    btn.classList.toggle('bg-white', active);
    btn.classList.toggle('shadow-sm', active);
    btn.classList.toggle('text-indigo-700', active);
    btn.classList.toggle('bg-slate-100', !active);
    btn.classList.toggle('text-slate-700', !active);
  });
}

function setupEtabsInputModeToggle() {
  document.querySelectorAll('[data-etabs-input-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.loads.etabsInputMode = btn.dataset.etabsInputMode;
      updateEtabsInputModeVisibility();
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
  setupEtabsInputModeToggle();
  setupTheme();
  setupPresets();
  setupExport();
  updateTypeTabsVisibility();
  updateEtabsInputModeVisibility();
  if (window.lucide) window.lucide.createIcons();
  recalc();
});
