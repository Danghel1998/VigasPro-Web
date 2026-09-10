/**
 * Utilidades de diseño en concreto armado (Norma E.060 / ACI 318) para vigas
 * rectangulares simplemente reforzadas. Mismas fórmulas y convenciones ya
 * verificadas en ZapatasPro-Web/js/engine/concreteDesign.js (viga de
 * conexión), portadas aquí para el caso general de una viga principal.
 */

export const PHI_FLEX = 0.90;
export const PHI_SHEAR = 0.85; // E.060 9.3.2

/** Acero mínimo de viga — E.060 10.5 / ACI 318 9.6.1.2: max(0.7√f'c/fy, 14/fy) en kg/cm² directos. fc, fy en kg/cm²; b, d en cm; resultado en cm². */
export function beamAsMin_cm2(fc_kgcm2, fy_kgcm2, b_cm, d_cm) {
  const rho_min1 = (0.7 * Math.sqrt(fc_kgcm2)) / fy_kgcm2;
  const rho_min2 = 14.0 / fy_kgcm2;
  return Math.max(rho_min1, rho_min2) * b_cm * d_cm;
}

/** Acero máximo de viga por ductilidad — E.060 10.3.3: As_max = 0.75·ρ_balanceada·b·d, β1=0.85 (válido para f'c ≤ 280 kg/cm²). fc, fy en kg/cm²; b, d en cm; resultado en cm². */
export function beamAsMax_cm2(fc_kgcm2, fy_kgcm2, b_cm, d_cm) {
  const beta1 = fc_kgcm2 <= 280 ? 0.85 : Math.max(0.65, 0.85 - 0.05 * (fc_kgcm2 - 280) / 70);
  const rho_bal = 0.85 * beta1 * (fc_kgcm2 / fy_kgcm2) * (6300 / (6300 + fy_kgcm2));
  return 0.75 * rho_bal * b_cm * d_cm;
}

/** Gancho estándar a 90° de una barra principal (E.060/ACI 318 25.3.1): 12·db más allá del doblez. */
export function hookMainBar_m(diameter_m) {
  return Math.max(0.10, diameter_m * 12.0);
}

/** Gancho de estribo (E.060/ACI 318 25.3.2): 6·db para Ø ≤ 5/8", 12·db para diámetros mayores. */
export function hookStirrup_m(diameter_mm, diameter_m) {
  const factor = diameter_mm <= 15.9 ? 6.0 : 12.0;
  return Math.max(0.075, diameter_m * factor);
}

/**
 * Acero requerido por flexión en una viga rectangular simplemente reforzada.
 * Mu en kg·m (positivo o negativo, se usa el valor absoluto), fc/fy en
 * kg/cm², b/d en m. Si la sección es insuficiente (discriminante negativo)
 * se marca `overstressed=true` y se reporta una cuantía alta para que la
 * verificación falle visiblemente (mismo criterio que ZapatasPro).
 */
export function calcRequiredRebar(Mu_kgm, fc_kgcm2, fy_kgcm2, b_m, d_m, phi = PHI_FLEX) {
  const Mu = Math.max(1.0, Math.abs(Mu_kgm));
  const b_cm = b_m * 100.0;
  const d_cm = d_m * 100.0;

  const Mu_kgcm = Mu * 100.0; // kg·m -> kg·cm
  const Rn = Mu_kgcm / (phi * b_cm * d_cm * d_cm); // kg/cm²

  let rho;
  let overstressed = false;
  const discr = 1.0 - (2.0 * Rn) / (0.85 * fc_kgcm2);
  if (discr > 0) {
    rho = (0.85 * fc_kgcm2 / fy_kgcm2) * (1.0 - Math.sqrt(discr));
  } else {
    rho = 0.025;
    overstressed = true;
  }

  const As_calc = rho * b_cm * d_cm;
  const As_min = beamAsMin_cm2(fc_kgcm2, fy_kgcm2, b_cm, d_cm);
  const As_max = beamAsMax_cm2(fc_kgcm2, fy_kgcm2, b_cm, d_cm);
  const As_design = Math.max(As_calc, As_min);
  const rho_min = As_min / (b_cm * d_cm);
  const doubleReinfRequired = overstressed || As_design > As_max;

  const a_cm = (As_design * fy_kgcm2) / (0.85 * fc_kgcm2 * b_cm);

  return { Mu_kgm: Mu, Rn, rho, rho_min, As_calc, As_min, As_max, As_design, a_cm, overstressed, doubleReinfRequired };
}


/** Capacidad a cortante del concreto Vc = 0.53√f'c·b·d (kg, cm). Resultado en kg. */
export function concreteShearCapacity_kg(fc_kgcm2, b_m, d_m) {
  return 0.53 * Math.sqrt(fc_kgcm2) * (b_m * 100.0) * (d_m * 100.0);
}

/**
 * Espaciamiento de estribos requerido (cm) para resistir Vu (kg) con un
 * estribo de área `Av_cm2` (2 ramas) a fy — E.060 13.5 / ACI 318 22.5.10.
 * Devuelve también si se requieren estribos por cálculo (Vu > φVc/2) o si
 * basta el espaciamiento máximo constructivo.
 */
export function calcStirrupSpacing(Vu_kg, fc_kgcm2, fy_kgcm2, b_m, d_m, Av_cm2, phi = PHI_SHEAR) {
  const Vc = concreteShearCapacity_kg(fc_kgcm2, b_m, d_m);
  const d_cm = d_m * 100.0;
  const phiVc = phi * Vc;

  const s_max_construct = Math.min(d_cm / 2.0, 60.0);
  const requiresStirrupsByCalc = Vu_kg > phiVc / 2.0;

  if (Vu_kg <= phiVc) {
    return { Vc, phiVc, Vs_req: 0, s_cm: s_max_construct, requiresStirrupsByCalc, exceedsCapacity: false };
  }

  const Vs_req = Vu_kg / phi - Vc;
  const Vs_max = 2.2 * Math.sqrt(fc_kgcm2) * (b_m * 100.0) * d_cm; // E.060 13.5.6.9 límite superior de Vs
  const exceedsCapacity = Vs_req > Vs_max;

  let s_cm = (Av_cm2 * fy_kgcm2 * d_cm) / Math.max(1.0, Vs_req);
  const s_max_by_vs = Vs_req > 0.53 * Math.sqrt(fc_kgcm2) * (b_m * 100.0) * d_cm ? s_max_construct / 2.0 : s_max_construct;
  s_cm = Math.min(s_cm, s_max_by_vs);

  return { Vc, phiVc, Vs_req, s_cm, requiresStirrupsByCalc, exceedsCapacity };
}

/** Redondea un espaciamiento calculado hacia abajo a un valor constructivo estándar (cm). */
export function roundSpacingDown(s_cm) {
  const standard = [5, 7.5, 10, 12.5, 15, 17.5, 20, 25, 30];
  if (s_cm <= standard[0]) return standard[0];
  for (let i = standard.length - 1; i >= 0; i--) {
    if (standard[i] <= s_cm) return standard[i];
  }
  return standard[0];
}

/** Peralte mínimo por deflexión — viga simplemente apoyada, elementos que no soportan tabiques susceptibles a dañarse: h_min = L/16 (E.060 9.6.2 / ACI 318 Tabla 9.3.1.1). L en m, resultado en m. */
export function minDepthByDeflection_m(L_m) {
  return L_m / 16.0;
}

/**
 * Longitud de desarrollo en tracción para barras corrugadas (E.060 25.4.2 /
 * ACI 318 25.4.2.3, caso simplificado). fy, fc en kg/cm², db en mm; L en cm.
 */
export function ldTraccion_cm(fy_kgcm2, fc_kgcm2, db_mm) {
  const db_cm = db_mm / 10.0;
  const divisor = db_mm <= 22.2 ? 8.2 : 6.6;
  return Math.max(30.0, (fy_kgcm2 / (divisor * Math.sqrt(fc_kgcm2))) * db_cm);
}
