/**
 * Cuadro de habilitación de acero de la viga: acero longitudinal (superior
 * e inferior) y estribos, a partir de los resultados ya calculados por el
 * motor estructural (beamDesign.js, ver uiController.js). Mismo formato de
 * fila (marca, elemento, diámetro, forma, longitud unitaria, cantidad, peso)
 * usado en ZapatasPro-Web/js/engine/rebarSchedule.js.
 */

import { hookMainBar_m, hookStirrup_m } from './concreteDesign.js';

function row(mark, element, rebar, shape, unitLength_m, quantity) {
  const qty = Math.max(0, Math.ceil(quantity));
  const totalLength_m = Math.max(0, unitLength_m) * qty;
  return {
    mark, element,
    diameter_name: rebar.inches || rebar.name,
    diameter_mm: rebar.diameter_mm,
    shape, unitLength_m, quantity: qty, totalLength_m,
    weight_kg: totalLength_m * rebar.weight_kgm,
  };
}

/**
 * @param {object} beamData Datos de entrada (geometry, materials)
 * @param {object} structResults Resultado de designBeam() (ver uiController.js) —
 *   structResults.flexure.top/bottom traen `.groups` (hasta 2 diámetros
 *   distintos por capa, igual que Columnas)
 * @param {object} stirrupRebar objeto de REBAR_TABLE para el estribo
 */
export function calculateBeamRebarSchedule(beamData, structResults, stirrupRebar) {
  const { L, b, h } = beamData.geometry;
  const cover = beamData.materials.cover;
  const rows = [];
  let mark = 1;
  const nextMark = () => `V${mark++}`;

  function pushLayerRows(layer, labelPrefix) {
    layer.groups.forEach((g) => {
      const hookMain = hookMainBar_m(g.rebar.diameter_m);
      const barLength = L + 2 * (b / 2) + 2 * hookMain; // se extiende medio ancho de apoyo típico en cada extremo + gancho
      rows.push(row(nextMark(), `${labelPrefix} (${g.rebar.inches})`, g.rebar, 'straight', barLength, g.n));
    });
  }
  pushLayerRows(structResults.flexure.bottom, 'Acero inferior (positivo, tramo completo)');
  pushLayerRows(structResults.flexure.top, 'Acero superior (constructivo / anclaje de estribos)');

  const hookStirrup = hookStirrup_m(stirrupRebar.diameter_mm, stirrupRebar.diameter_m);
  const stirrupPerimeter = 2 * (b - 2 * cover) + 2 * (h - 2 * cover) + 2 * hookStirrup;

  const { shear } = structResults;
  const endZoneLen = Math.min(L / 2, shear.endZoneLength_m);
  const midZoneLen = Math.max(0, L - 2 * endZoneLen);

  rows.push(row(nextMark(), `Estribos — zona de apoyos (2 extremos, s=${shear.s_end_cm.toFixed(1)}cm)`, stirrupRebar, 'stirrup',
    stirrupPerimeter, 2 * (endZoneLen / (shear.s_end_cm / 100) + 1)));

  if (midZoneLen > 0.05) {
    rows.push(row(nextMark(), `Estribos — zona central (s=${shear.s_mid_cm.toFixed(1)}cm)`, stirrupRebar, 'stirrup',
      stirrupPerimeter, midZoneLen / (shear.s_mid_cm / 100) + 1));
  }

  const totalWeight_kg = rows.reduce((sum, r) => sum + r.weight_kg, 0);
  return { rows, totalWeight_kg };
}
