/**
 * Constantes y tablas de referencia para diseño de vigas de concreto armado
 * (E.060 / ACI 318). Misma tabla de aceros y misma convención de unidades
 * (kg/cm², kg/m³, m) usada en MurosPro-Web y ZapatasPro-Web.
 */

export const REBAR_TABLE = [
  { name: 'Ø 3/8" (9.5 mm)',  diameter_mm: 9.52,  diameter_m: 0.00952, area_cm2: 0.71, weight_kgm: 0.560, inches: '3/8"' },
  { name: 'Ø 1/2" (12.7 mm)', diameter_mm: 12.70, diameter_m: 0.01270, area_cm2: 1.29, weight_kgm: 0.994, inches: '1/2"' },
  { name: 'Ø 5/8" (15.9 mm)', diameter_mm: 15.88, diameter_m: 0.01588, area_cm2: 1.99, weight_kgm: 1.552, inches: '5/8"' },
  { name: 'Ø 3/4" (19.1 mm)', diameter_mm: 19.05, diameter_m: 0.01905, area_cm2: 2.84, weight_kgm: 2.235, inches: '3/4"' },
  { name: 'Ø 7/8" (22.2 mm)', diameter_mm: 22.22, diameter_m: 0.02222, area_cm2: 3.87, weight_kgm: 3.042, inches: '7/8"' },
  { name: 'Ø 1" (25.4 mm)',   diameter_mm: 25.40, diameter_m: 0.02540, area_cm2: 5.10, weight_kgm: 3.973, inches: '1"' },
  { name: 'Ø 1-3/8" (28.6 mm)', diameter_mm: 28.65, diameter_m: 0.02865, area_cm2: 6.45, weight_kgm: 5.060, inches: '1-1/8"' },
  { name: 'Ø 8 mm',  diameter_mm: 8.0,  diameter_m: 0.0080, area_cm2: 0.503, weight_kgm: 0.395, inches: '8mm' },
  { name: 'Ø 10 mm', diameter_mm: 10.0, diameter_m: 0.0100, area_cm2: 0.785, weight_kgm: 0.617, inches: '10mm' },
  { name: 'Ø 12 mm', diameter_mm: 12.0, diameter_m: 0.0120, area_cm2: 1.131, weight_kgm: 0.888, inches: '12mm' },
];

/** Diámetros permitidos para estribos (barras delgadas, doblado en obra). */
export const STIRRUP_REBAR_IDS = [0, 1, 7, 8]; // 3/8", 1/2", 8mm, 10mm

export const DEFAULT_BEAM_DATA = {
  geometry: {
    L: 5.00,        // Luz libre entre apoyos (L)
    b: 0.25,        // Ancho de la sección (b)
    h: 0.50,        // Peralte total (h)
    support: 'simple', // 'simple' (simplemente apoyada) — única opción del MVP
  },

  loads: {
    wd: 800.0,      // Carga muerta distribuida (kg/m), incluye peso propio si se desea
    wl: 500.0,      // Carga viva distribuida (kg/m)
    include_self_weight: true, // Suma automáticamente γc·b·h a wd
    // Hasta 2 cargas puntuales opcionales (MVP): posición medida desde el
    // apoyo izquierdo (m) y magnitud de servicio (kg). Con Pd=Pl=0 la carga
    // no participa en el análisis (se filtra automáticamente).
    point_loads: [
      { pos: 2.50, Pd: 0, Pl: 0 },
      { pos: 2.50, Pd: 0, Pl: 0 },
    ],
  },

  materials: {
    fc_kgcm2: 210.0,
    fy_kgcm2: 4200.0,
    gamma_c_kgm3: 2400.0,
    cover: 0.04,        // Recubrimiento libre a estribo (m)
    rebar_top_id: 1,     // Ø 1/2" (acero superior)
    rebar_bottom_id: 1,  // Ø 1/2" (acero inferior)
    rebar_stirrup_id: 0, // Ø 3/8" (estribos)
    n_bars_top_min: 2,   // Barras mínimas constructivas superiores
    n_bars_bottom_min: 2,// Barras mínimas constructivas inferiores
  },

  safety_req: {
    LF_D: 1.4,
    LF_L: 1.7,
    phi_flex: 0.90,
    phi_shear: 0.85,
    code: 'E060',
  },

  plano: {
    proyecto: '',
    propietario: '',
    ubicacion: '',
    elemento: 'Viga V-1',
    dibujado_por: 'Ing. Dan Oliden',
    escala: 'Como se indica',
    codigo: 'V-01',
  },
};

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export const PRESET_PROJECTS = {
  viga_tipica_vivienda: {
    title: '⭐ Viga Típica de Vivienda (L=5.0m, 25×50cm)',
    desc: 'Viga simplemente apoyada de una vivienda unifamiliar, carga uniforme muerta+viva, sin cargas puntuales.',
    data: clone(DEFAULT_BEAM_DATA),
  },
  viga_carga_puntual: {
    title: 'Viga con Carga Puntual (columna apoyada al centro)',
    desc: 'Viga de L=6.0m con una carga puntual al centro (p.ej. columna que se apoya sobre la viga) además de carga distribuida.',
    data: (() => {
      const d = clone(DEFAULT_BEAM_DATA);
      d.geometry.L = 6.00;
      d.geometry.b = 0.30;
      d.geometry.h = 0.60;
      d.loads.wd = 900.0;
      d.loads.wl = 400.0;
      d.loads.point_loads = [{ pos: 3.00, Pd: 2500, Pl: 1500 }, { pos: 3.00, Pd: 0, Pl: 0 }];
      return d;
    })(),
  },
  viga_gran_luz: {
    title: 'Viga de Gran Luz (L=8.0m, sección robusta)',
    desc: 'Viga de gran luz para salón/auditorio, sección 30×70cm, f\'c=280 kg/cm².',
    data: (() => {
      const d = clone(DEFAULT_BEAM_DATA);
      d.geometry.L = 8.00;
      d.geometry.b = 0.30;
      d.geometry.h = 0.70;
      d.loads.wd = 1000.0;
      d.loads.wl = 600.0;
      d.materials.fc_kgcm2 = 280.0;
      d.materials.rebar_top_id = 2;
      d.materials.rebar_bottom_id = 2;
      return d;
    })(),
  },
};
