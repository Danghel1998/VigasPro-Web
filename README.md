# VigasPro - Software de Diseño de Vigas de Concreto Armado

**VigasPro** es una aplicación de ingeniería estructural para el análisis y
dimensionamiento de **vigas rectangulares de concreto armado simplemente
apoyadas** según los estándares de la normativa **E.060** y **ACI 318**.

---

## 🚀 Características Principales

### 1. 📐 Modelado de Geometría y Cargas
- Luz libre ($L$), ancho ($b$) y peralte total ($h$) de la sección.
- Carga distribuida (muerta + viva), con opción de incluir el peso propio
  automáticamente ($\gamma_c \cdot b \cdot h$).
- Hasta 2 cargas puntuales opcionales, con posición configurable.

### 2. ➡️ Análisis Estático
- Combinación de cargas $U = 1.4D + 1.7L$ (E.060).
- Diagramas de momento flector $M(x)$ y fuerza cortante $V(x)$ por
  superposición directa de reacciones (viga estáticamente determinada).

### 3. 🏗️ Diseño Estructural (E.060 / ACI 318)
- **Flexión**: acero requerido por el método de resistencia última, cuantías
  mínima y máxima, aviso si se requiere doble refuerzo.
- **Cortante**: capacidad del concreto $V_c$, acero de corte $V_s$ y
  espaciamiento de estribos por zonas (extremos / centro de luz).
- **Deflexión**: verificación de peralte mínimo $L/16$ para elementos que no
  soportan tabiquería susceptible a dañarse.
- Selección automática de diámetros comerciales y cuadro de habilitación de
  acero (barras + estribos, con longitud total y peso).

### 4. 📊 Visualizador Gráfico 2D
- Renderizado interactivo en HTML5 Canvas con **Pan** y **Zoom**.
- Tres modos: (1) Geometría y cargas, (2) Diagramas M(x)/V(x), (3) Despiece
  de armadura longitudinal y estribos.

### 5. 📑 Memoria de Cálculo Detallada
- Reporte paso a paso con fórmulas renderizadas mediante **KaTeX**.
- Impresión / guardado en PDF, exportación del plano a PNG, y guardado de
  proyectos en formato JSON.

---

## ⚠️ Alcance (MVP)

Esta primera versión cubre **vigas de un solo tramo, simplemente apoyadas,
con refuerzo simple** (sin doble refuerzo ni vigas continuas). Si el diseño
requiere doble refuerzo o excede la capacidad a cortante, la app lo señala
explícitamente en el banner de estado y en la memoria de cálculo.

---

## 💻 Instrucciones de Uso

### Opción A (Recomendada - Con servidor local automático):
1. Haz doble clic en **`iniciar_app.bat`** (o ejecuta `python server.py`).
2. Se abrirá automáticamente la aplicación en `http://localhost:8100`.

### Opción B (Directa en Navegador):
1. Abre directamente **`index.html`** en cualquier navegador moderno.

---

## 📁 Estructura del Proyecto

```
VigasPro-Web/
├── index.html                  # Interfaz de usuario principal
├── server.py                   # Servidor web local en Python
├── iniciar_app.bat             # Lanzador con doble clic para Windows
├── README.md
├── css/
│   └── styles.css              # Estilos y reglas de impresión PDF
└── js/
    ├── constants.js            # Tabla de aceros, datos por defecto y presets
    ├── engine/
    │   ├── loadAnalysis.js     # Combinación de cargas y diagramas M(x)/V(x)
    │   ├── concreteDesign.js   # Flexión, cortante y cuantías (E.060/ACI 318)
    │   └── rebarSchedule.js    # Cuadro de habilitación de acero
    ├── visualizer/
    │   └── beamCanvas.js       # Motor gráfico 2D Canvas interactivo
    └── ui/
        └── uiController.js     # Controlador reactivo y sincronización de datos
```
