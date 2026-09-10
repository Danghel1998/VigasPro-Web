/**
 * Vista 3D interactiva (Three.js) del detalle de armaduras de la viga —
 * mismo estilo "ligero" que el módulo de Columnas (ColumnasPro): concreto
 * en caja semitransparente + aristas, barras longitudinales como cilindros,
 * y estribos como polilíneas cerradas (no tubos sólidos), lo que mantiene
 * la escena liviana y rápida de renderizar. Usa el THREE global cargado por
 * <script> clásico en index.html (r128 + OrbitControls), no ES modules.
 */
export function createBeam3D(container) {
  let scene, camera, renderer, controls, group;
  let ready = false;

  function ensureInit() {
    if (ready) return;
    const width = container.clientWidth || 600;
    const height = container.clientHeight || 400;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a);

    camera = new THREE.PerspectiveCamera(45, width / Math.max(1, height), 0.1, 100);
    camera.position.set(3, 2, 4);

    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const d1 = new THREE.DirectionalLight(0xffffff, 0.8);
    d1.position.set(5, 10, 7);
    scene.add(d1);
    const d2 = new THREE.DirectionalLight(0xffffff, 0.4);
    d2.position.set(-5, -5, -5);
    scene.add(d2);

    scene.add(new THREE.GridHelper(10, 20, 0x3b82f6, 0x334155));

    group = new THREE.Group();
    scene.add(group);

    (function animate() {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    })();

    ready = true;
  }

  function resize() {
    if (!ready) return;
    const width = container.clientWidth || 600;
    const height = container.clientHeight || 400;
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  }

  function resetCamera(L) {
    if (!camera || !controls) return;
    camera.position.set(L * 0.35 + 1.5, 1.6, 2.6);
    controls.target.set(L / 2, 0, 0);
    controls.update();
  }

  /**
   * @param {object} data Estado de la app (geometry, materials)
   * @param {object} struct Resultado del motor de diseño — struct.flexure.top/bottom
   *   traen `.groups` (hasta 2 diámetros distintos por capa, igual que Columnas) y shear.*
   */
  function update(data, struct) {
    ensureInit();
    while (group.children.length > 0) group.remove(group.children[0]);

    const { L, b, h } = data.geometry;
    const cover = data.materials.cover;

    // Concreto: caja semitransparente + aristas (viga horizontal a lo largo de X)
    const concGeo = new THREE.BoxGeometry(L, h, b);
    const concMat = new THREE.MeshStandardMaterial({
      color: 0x94a3b8, transparent: true, opacity: 0.30, roughness: 0.5, metalness: 0.1,
    });
    const concMesh = new THREE.Mesh(concGeo, concMat);
    concMesh.position.set(L / 2, 0, 0);
    group.add(concMesh);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(concGeo),
      new THREE.LineBasicMaterial({ color: 0x38bdf8, linewidth: 1.5 })
    );
    edges.position.copy(concMesh.position);
    group.add(edges);

    const halfH = Math.max(0.02, h / 2 - cover);
    const halfB = Math.max(0.02, b / 2 - cover);

    // Barras longitudinales de una capa, respetando hasta 2 diámetros
    // distintos (grupos) repartidos en el ancho disponible.
    function addLongBarsForLayer(layer, yPos) {
      const n = layer.n_bars;
      if (n <= 0) return;
      const diameters_m = [];
      layer.groups.forEach((g) => { for (let i = 0; i < g.n; i++) diameters_m.push(g.rebar.diameter_m); });
      const mat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, metalness: 0.8, roughness: 0.2 });
      const zs = n <= 1 ? [0] : Array.from({ length: n }, (_, i) => -halfB + (2 * halfB * i) / (n - 1));
      zs.forEach((z, i) => {
        const rRad = Math.max(0.006, diameters_m[i] / 2);
        const geo = new THREE.CylinderGeometry(rRad, rRad, L + 0.1, 12);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.z = Math.PI / 2; // cilindro por defecto a lo largo de Y -> lo alineamos con X
        mesh.position.set(L / 2, yPos, z);
        group.add(mesh);
      });
    }

    addLongBarsForLayer(struct.flexure.top, halfH);
    addLongBarsForLayer(struct.flexure.bottom, -halfH);

    // Estribos: polilíneas cerradas (plano Y-Z) espaciadas a lo largo de X,
    // más cerrados en zonas de extremo y más abiertos al centro.
    const stMat = new THREE.LineBasicMaterial({ color: 0xef4444, linewidth: 2 });
    const { s_end_cm, s_mid_cm, endZoneLength_m } = struct.shear;
    const sEnd = Math.max(0.03, s_end_cm / 100);
    const sMid = Math.max(0.03, s_mid_cm / 100);
    const endZone = Math.min(L / 2, endZoneLength_m);

    const xs = [];
    let x = 0.03;
    while (x <= endZone) { xs.push(x); x += sEnd; }
    while (x < L - endZone) { xs.push(x); x += sMid; }
    x = Math.max(x, L - endZone);
    while (x <= L - 0.03) { xs.push(x); x += sEnd; }

    xs.forEach((xPos) => {
      const pts = [
        new THREE.Vector3(xPos, halfH, halfB), new THREE.Vector3(xPos, halfH, -halfB),
        new THREE.Vector3(xPos, -halfH, -halfB), new THREE.Vector3(xPos, -halfH, halfB),
        new THREE.Vector3(xPos, halfH, halfB),
      ];
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), stMat));
    });

    resize();
    resetCamera(L);
  }

  function snapshot() {
    if (!ready || !renderer) return '';
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/png');
  }

  return { ensureInit, update, resize, resetCamera, snapshot };
}
