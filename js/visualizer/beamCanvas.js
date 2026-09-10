/**
 * Visualizador 2D en Canvas de la viga: (1) geometría + cargas, (2)
 * diagramas de momento M(x) y cortante V(x), (3) despiece de armadura
 * longitudinal y estribos. Soporta pan (arrastre) y zoom (rueda del mouse),
 * igual convención de interacción que MurosPro-Web/js/visualizer/wallCanvas.js.
 */

export function createBeamCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  let mode = 'geometry';
  let view = { scale: 1, offsetX: 0, offsetY: 0, fitted: false };
  let lastData = null, lastResults = null, lastRebars = null;

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function cssSize() {
    return { w: canvas.clientWidth, h: canvas.clientHeight };
  }

  function fitView(worldWidth, worldHeight, padding = 60) {
    const { w, h } = cssSize();
    const sx = (w - 2 * padding) / worldWidth;
    const sy = (h - 2 * padding) / worldHeight;
    view.scale = Math.max(0.001, Math.min(sx, sy));
    view.offsetX = (w - worldWidth * view.scale) / 2;
    view.offsetY = (h - worldHeight * view.scale) / 2;
    view.fitted = true;
  }

  function worldToScreen(x, y) {
    return { x: view.offsetX + x * view.scale, y: view.offsetY + y * view.scale };
  }

  // --- Interacción: pan y zoom ---
  let dragging = false, lastMouse = { x: 0, y: 0 };
  canvas.addEventListener('mousedown', (e) => { dragging = true; lastMouse = { x: e.clientX, y: e.clientY }; canvas.style.cursor = 'grabbing'; });
  window.addEventListener('mouseup', () => { dragging = false; canvas.style.cursor = 'grab'; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    view.offsetX += e.clientX - lastMouse.x;
    view.offsetY += e.clientY - lastMouse.y;
    lastMouse = { x: e.clientX, y: e.clientY };
    redraw();
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const wx = (mx - view.offsetX) / view.scale;
    const wy = (my - view.offsetY) / view.scale;
    view.scale *= factor;
    view.offsetX = mx - wx * view.scale;
    view.offsetY = my - wy * view.scale;
    redraw();
  }, { passive: false });

  function resetView() {
    view.fitted = false;
    redraw();
  }

  function setMode(m) {
    mode = m;
    view.fitted = false;
    redraw();
  }

  // --- Dibujo ---
  function drawArrowDown(x, yTop, yBot, color = '#dc2626') {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, yTop);
    ctx.lineTo(x, yBot);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, yBot);
    ctx.lineTo(x - 4, yBot - 8);
    ctx.lineTo(x + 4, yBot - 8);
    ctx.closePath();
    ctx.fill();
  }

  function drawGeometry(data, results) {
    const { L } = data.geometry;
    const worldW = L + 2.0, worldH = 3.0;
    if (!view.fitted) fitView(worldW, worldH);

    const originX = 1.0, originY = 1.6; // posición del eje de la viga dentro del "mundo"
    const p0 = worldToScreen(originX, originY);
    const p1 = worldToScreen(originX + L, originY);
    const beamThickPx = Math.max(6, 0.35 * view.scale);

    // Viga (elevación, esquemática)
    ctx.fillStyle = '#cbd5e1';
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1.5;
    ctx.fillRect(p0.x, p0.y - beamThickPx / 2, p1.x - p0.x, beamThickPx);
    ctx.strokeRect(p0.x, p0.y - beamThickPx / 2, p1.x - p0.x, beamThickPx);

    // Apoyos (triángulos)
    const supH = 22;
    for (const p of [p0, p1]) {
      ctx.beginPath();
      ctx.moveTo(p.x, p.y + beamThickPx / 2);
      ctx.lineTo(p.x - supH * 0.6, p.y + beamThickPx / 2 + supH);
      ctx.lineTo(p.x + supH * 0.6, p.y + beamThickPx / 2 + supH);
      ctx.closePath();
      ctx.fillStyle = '#1e293b';
      ctx.fill();
    }

    const isEtabs = data.loads.mode === 'etabs';

    // Carga distribuida (flechas arriba de la viga) — solo en modo manual
    const wu = data.loads.wd + data.loads.wl;
    if (!isEtabs && wu > 0) {
      const nArrows = Math.max(6, Math.round(L * 2));
      const loadTopY = p0.y - beamThickPx / 2 - 34;
      ctx.strokeStyle = '#f59e0b';
      ctx.beginPath();
      ctx.moveTo(p0.x, loadTopY);
      ctx.lineTo(p1.x, loadTopY);
      ctx.stroke();
      for (let i = 0; i <= nArrows; i++) {
        const x = p0.x + ((p1.x - p0.x) * i) / nArrows;
        drawArrowDown(x, loadTopY, p0.y - beamThickPx / 2 - 3, '#f59e0b');
      }
      ctx.fillStyle = '#b45309';
      ctx.font = 'bold 12px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`w = ${wu.toFixed(0)} kg/m`, (p0.x + p1.x) / 2, loadTopY - 8);
    }

    // Cargas puntuales — solo en modo manual
    ctx.font = 'bold 11px Inter, sans-serif';
    if (!isEtabs) {
      for (const pl of (data.loads.point_loads || [])) {
        const Pu = pl.Pd + pl.Pl;
        if (Pu <= 0) continue;
        const px = worldToScreen(originX + pl.pos, originY).x;
        const topY = p0.y - beamThickPx / 2 - 54;
        drawArrowDown(px, topY, p0.y - beamThickPx / 2 - 3, '#dc2626');
        ctx.fillStyle = '#991b1b';
        ctx.textAlign = 'center';
        ctx.fillText(`P = ${Pu.toFixed(0)} kg`, px, topY - 6);
      }
    }

    // Modo ETABS: en vez de cargas, se rotulan los momentos/cortante
    // envolventes ya calculados (M+ al centro, M- y V en los apoyos).
    if (isEtabs && results && results.struct && results.struct.etabs) {
      const { Mu_pos, Mu_neg, Vu } = results.struct.etabs;
      const midX = (p0.x + p1.x) / 2;
      const labelY = p0.y - beamThickPx / 2 - 20;
      ctx.font = 'bold 12px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#4f46e5';
      ctx.fillText(`M⁺ = ${Mu_pos.toFixed(0)} kg·m (centro)`, midX, labelY);
      ctx.fillStyle = '#be123c';
      ctx.textAlign = 'left';
      ctx.fillText(`M⁻ = ${Mu_neg.toFixed(0)} kg·m`, p0.x, labelY - 18);
      ctx.textAlign = 'right';
      ctx.fillText(`M⁻ = ${Mu_neg.toFixed(0)} kg·m`, p1.x, labelY - 18);
      ctx.fillStyle = '#059669';
      ctx.font = '11px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`Vu (envolvente ETABS) = ${Vu.toFixed(0)} kg`, midX, labelY - 36);
    }

    // Cota de luz
    const dimY = p0.y + beamThickPx / 2 + supH + 26;
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p0.x, dimY);
    ctx.lineTo(p1.x, dimY);
    ctx.moveTo(p0.x, dimY - 5); ctx.lineTo(p0.x, dimY + 5);
    ctx.moveTo(p1.x, dimY - 5); ctx.lineTo(p1.x, dimY + 5);
    ctx.stroke();
    ctx.fillStyle = '#334155';
    ctx.font = '12px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`L = ${L.toFixed(2)} m`, (p0.x + p1.x) / 2, dimY + 18);

    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 12px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`Sección ${(data.geometry.b * 100).toFixed(0)} × ${(data.geometry.h * 100).toFixed(0)} cm`, p0.x, p0.y - beamThickPx / 2 - (wu > 0 ? 70 : 20));
  }

  function drawDiagram(data, results, key, color, unitLabel, flip) {
    const { L } = data.geometry;
    const pts = results.points;
    const values = pts.map(p => p[key]);
    const maxAbs = Math.max(1, ...values.map(v => Math.abs(v)));
    return { pts, values, maxAbs };
  }

  function drawDiagrams(data, results) {
    const worldW = 10, worldH = 10; // espacio lógico fijo; el dibujo real usa coordenadas de pantalla directamente
    if (!view.fitted) { view.scale = 1; view.offsetX = 0; view.offsetY = 0; view.fitted = true; }

    const { w, h } = cssSize();
    const padL = 70, padR = 30, padTop = 40, chartH = (h - padTop - 40 - 30) / 2;
    const chartW = w - padL - padR;
    const { L } = data.geometry;

    function panel(y0, title, key, color) {
      const { pts, maxAbs } = drawDiagram(data, results, key, color);
      const zeroY = y0 + chartH / 2;

      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 1;
      ctx.strokeRect(padL, y0, chartW, chartH);
      ctx.beginPath();
      ctx.moveTo(padL, zeroY); ctx.lineTo(padL + chartW, zeroY);
      ctx.stroke();

      ctx.beginPath();
      pts.forEach((p, i) => {
        const x = padL + (p.x / L) * chartW;
        const y = zeroY - (p[key] / maxAbs) * (chartH / 2 - 6);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineTo(padL + chartW, zeroY);
      ctx.lineTo(padL, zeroY);
      ctx.closePath();
      ctx.fillStyle = color + '22';
      ctx.fill();

      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 12px Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(title, padL, y0 - 8);

      ctx.font = '10px JetBrains Mono, monospace';
      ctx.fillStyle = '#64748b';
      ctx.textAlign = 'right';
      ctx.fillText((+maxAbs.toFixed(0)).toLocaleString(), padL - 6, y0 + 10);
      ctx.fillText((-maxAbs.toFixed(0)).toLocaleString(), padL - 6, y0 + chartH - 2);
    }

    panel(padTop, `Momento Flector Mu(x) — máx. ${results.Mu_max.M.toFixed(0)} kg·m en x=${results.Mu_max.x.toFixed(2)}m`, 'M', '#4f46e5');
    panel(padTop + chartH + 30, `Fuerza Cortante Vu(x) — extremos ${Math.max(Math.abs(results.Vu_left_face), Math.abs(results.Vu_right_face)).toFixed(0)} kg`, 'V', '#059669');

    ctx.fillStyle = '#334155';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('x = 0', padL, padTop + 2 * chartH + 44);
    ctx.fillText(`x = L = ${L.toFixed(2)}m`, padL + chartW, padTop + 2 * chartH + 44);

    if (data.loads.mode === 'etabs') {
      ctx.fillStyle = '#b45309';
      ctx.font = 'italic 10px Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('⚠ Envolvente ilustrativa a partir de Mu+/Mu-/Vu de ETABS — no es el diagrama real del modelo.', padL, padTop - 20);
    }
  }

  function drawRebar(data, results, stirrupRebar) {
    const { L, b, h } = data.geometry;
    const worldW = L + 2.0, worldH = 2.0;
    if (!view.fitted) fitView(worldW, worldH, 80);

    const originX = 1.0, originY = 0.9;
    const p0 = worldToScreen(originX, originY);
    const p1 = worldToScreen(originX + L, originY);
    const hpx = h * view.scale;
    const topY = p0.y - hpx / 2, botY = p0.y + hpx / 2;

    // Sección/elevación de concreto (contorno)
    ctx.fillStyle = '#f1f5f9';
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1.5;
    ctx.fillRect(p0.x, topY, p1.x - p0.x, hpx);
    ctx.strokeRect(p0.x, topY, p1.x - p0.x, hpx);

    const coverPx = data.materials.cover * view.scale;

    // Estribos: zona de extremos con espaciamiento calculado, zona central con espaciamiento constructivo
    const { shear } = results.struct;
    const endZoneLen = Math.min(L / 2, shear.endZoneLength_m);
    ctx.strokeStyle = '#dc2626';
    ctx.lineWidth = 1.3;
    function drawStirrupsInRange(x0, x1, spacing_m) {
      if (spacing_m <= 0) return;
      for (let x = x0; x <= x1 + 1e-6; x += spacing_m) {
        const sx = worldToScreen(originX + x, 0).x;
        ctx.strokeRect(sx - 1, topY + coverPx * 0.5, 2, hpx - coverPx);
      }
    }
    drawStirrupsInRange(0, endZoneLen, shear.s_end_cm / 100);
    drawStirrupsInRange(endZoneLen, L - endZoneLen, shear.s_mid_cm / 100);
    drawStirrupsInRange(L - endZoneLen, L, shear.s_end_cm / 100);

    // Acero longitudinal superior e inferior
    ctx.strokeStyle = '#1d4ed8';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(p0.x, topY + coverPx + 3); ctx.lineTo(p1.x, topY + coverPx + 3); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p0.x, botY - coverPx - 3); ctx.lineTo(p1.x, botY - coverPx - 3); ctx.stroke();

    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.fillStyle = '#1d4ed8';
    ctx.textAlign = 'left';
    ctx.fillText(`${results.struct.flexure.top.label} (superior)`, p0.x, topY - 8);
    ctx.fillText(`${results.struct.flexure.bottom.label} (inferior)`, p0.x, botY + 18);
    ctx.fillStyle = '#dc2626';
    ctx.fillText(`Estribos ${stirrupRebar.inches}: @${shear.s_end_cm.toFixed(0)}cm (extremos) / @${shear.s_mid_cm.toFixed(0)}cm (centro)`, p0.x, botY + 36);
  }

  /** Vista en Planta: sección transversal (b×h) a escala, con estribo,
   * barras superiores/inferiores y cotas — mismo tipo de vista que el
   * módulo de Columnas (renderPlantaCanvas), adaptado a una viga. */
  function drawCrossSection(data, results, stirrupRebar) {
    const { b, h } = data.geometry;
    const needsFit = !view.fitted;
    if (needsFit) {
      fitView(b, h, 130);
      // fitView centra el dibujo; como la leyenda solo ocupa el lado
      // derecho, lo recorremos una vez hacia la izquierda para que quepa.
      const { w: cw } = cssSize();
      const wPxPreview = b * view.scale;
      const desiredRightMargin = 190;
      const rectRight = worldToScreen(0, 0).x + wPxPreview;
      if (rectRight + desiredRightMargin > cw) {
        view.offsetX -= (rectRight + desiredRightMargin) - cw;
      }
    }
    const topLeft = worldToScreen(0, 0);
    const wPx = b * view.scale, hPx = h * view.scale;

    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(topLeft.x, topLeft.y, wPx, hPx);
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 2;
    ctx.strokeRect(topLeft.x, topLeft.y, wPx, hPx);

    const cover = data.materials.cover;
    const coverPx = cover * view.scale;
    const stX = topLeft.x + coverPx, stY = topLeft.y + coverPx;
    const stW = wPx - 2 * coverPx, stH = hPx - 2 * coverPx;

    ctx.strokeStyle = '#dc2626';
    ctx.lineWidth = 2;
    ctx.strokeRect(stX, stY, stW, stH);
    // Marca de gancho a 135° (simplificada) en la esquina superior izquierda
    ctx.beginPath();
    ctx.moveTo(stX, stY + 12); ctx.lineTo(stX + 12, stY + 12);
    ctx.moveTo(stX + 12, stY); ctx.lineTo(stX + 12, stY + 12);
    ctx.stroke();

    // Dibuja los puntos de barra de una capa, respetando hasta 2 diámetros
    // distintos (grupos) repartidos en el ancho disponible — igual criterio
    // que el módulo de Columnas para el radio del punto (proporcional al
    // diámetro real, con mínimo/máximo fijo, independiente del zoom).
    function drawBarsForLayer(layer, yPx, color) {
      const n = layer.n_bars;
      if (n <= 0) return;
      const diameters_mm = [];
      layer.groups.forEach((g) => { for (let i = 0; i < g.n; i++) diameters_mm.push(g.rebar.diameter_mm); });
      const xs = n === 1 ? [stX + stW / 2] : Array.from({ length: n }, (_, i) => stX + (stW * i) / (n - 1));
      xs.forEach((x, i) => {
        const rPx = Math.min(9, Math.max(4, (diameters_mm[i] / 15.9) * 6));
        ctx.beginPath();
        ctx.arc(x, yPx, rPx, 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.3;
        ctx.stroke();
      });
    }
    drawBarsForLayer(results.struct.flexure.top, stY, '#b45309');
    drawBarsForLayer(results.struct.flexure.bottom, stY + stH, '#1d4ed8');

    // Cotas
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 1;
    ctx.font = '12px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    const dimTopY = topLeft.y - 24;
    ctx.beginPath(); ctx.moveTo(topLeft.x, dimTopY); ctx.lineTo(topLeft.x + wPx, dimTopY); ctx.stroke();
    ctx.fillStyle = '#334155';
    ctx.fillText(`b = ${(b * 100).toFixed(0)} cm`, topLeft.x + wPx / 2, dimTopY - 8);

    const dimLeftX = topLeft.x - 24;
    ctx.beginPath(); ctx.moveTo(dimLeftX, topLeft.y); ctx.lineTo(dimLeftX, topLeft.y + hPx); ctx.stroke();
    ctx.save();
    ctx.translate(dimLeftX - 10, topLeft.y + hPx / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(`h = ${(h * 100).toFixed(0)} cm`, 0, 0);
    ctx.restore();

    // Leyenda
    const legX = topLeft.x + wPx + 26;
    ctx.textAlign = 'left';
    ctx.font = 'bold 12px Inter, sans-serif';
    ctx.fillStyle = '#b45309';
    ctx.fillText(`Superior: ${results.struct.flexure.top.label}`, legX, topLeft.y + 16);
    ctx.fillStyle = '#1d4ed8';
    ctx.fillText(`Inferior: ${results.struct.flexure.bottom.label}`, legX, topLeft.y + 38);
    ctx.fillStyle = '#dc2626';
    ctx.fillText(`Estribo: ${stirrupRebar.inches} @ ${results.struct.shear.s_end_cm.toFixed(0)}/${results.struct.shear.s_mid_cm.toFixed(0)} cm`, legX, topLeft.y + 60);
    ctx.font = '11px Inter, sans-serif';
    ctx.fillStyle = '#334155';
    ctx.fillText(`Recubrimiento: r = ${(cover * 100).toFixed(1)} cm`, legX, topLeft.y + 80);
  }

  function redraw() {
    resize();
    const { w, h } = cssSize();
    ctx.clearRect(0, 0, w, h);
    if (!lastData) return;
    if (mode === 'geometry') drawGeometry(lastData, lastResults);
    else if (mode === 'diagrams') drawDiagrams(lastData, lastResults);
    else if (mode === 'planta') drawCrossSection(lastData, lastResults, lastRebars);
    else if (mode === 'rebar') drawRebar(lastData, lastResults, lastRebars);
  }

  function render(data, results, rebars) {
    lastData = data; lastResults = results; lastRebars = rebars;
    redraw();
  }

  window.addEventListener('resize', () => { view.fitted = false; redraw(); });

  function getMode() { return mode; }

  return { render, setMode, resetView, getMode };
}
