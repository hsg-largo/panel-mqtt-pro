/**
 * main.js — IIoT Dashboard
 *
 * Responsabilidades:
 *  1. Gestionar autenticación y renderizar la UI según el rol del usuario.
 *  2. Conectar al broker MQTT vía WebSocket.
 *  3. Suscribirse a tópicos de sensores ADC y renderizar gráficas en tiempo real.
 *  4. Publicar comandos ON/OFF a los GPIO de la ESP32 #2 (solo rol admin).
 */

import { login, logout, getSession, hasRole } from './auth.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURACIÓN DEL BROKER
// Cambia la IP por la de tu servidor EMQX cuando migres de red.
// ═══════════════════════════════════════════════════════════════════════════════

const BROKER_URL = 'ws://192.168.1.147:8083/mqtt';

const BROKER_OPTIONS = {
  clientId:        'web_dashboard_' + Math.random().toString(16).substring(2, 10),
  username:        'web_dashboard',
  password:        'web_dashboard',
  protocolVersion: 5,
  clean:           true,
  connectTimeout:  5000,
  reconnectPeriod: 2000,
};

// ═══════════════════════════════════════════════════════════════════════════════
// DEFINICIÓN DE SENSORES (Telemetría ADC — ESP32 #1)
// ═══════════════════════════════════════════════════════════════════════════════

const SENSORS = [
  { id: 'esp32_ch0', label: 'ESP32 #1 — Canal 0', topic: 'esp32/adc/ch0', color: '#3d7eff', unit: 'raw', maxValue: 4095 },
  { id: 'esp32_ch3', label: 'ESP32 #1 — Canal 3', topic: 'esp32/adc/ch3', color: '#2dd4a0', unit: 'raw', maxValue: 4095 },
  { id: 'esp32_ch6', label: 'ESP32 #1 — Canal 6', topic: 'esp32/adc/ch6', color: '#f05c5c', unit: 'raw', maxValue: 4095 },
];

// ═══════════════════════════════════════════════════════════════════════════════
// DEFINICIÓN DE ACTUADORES (GPIO — ESP32 #2)
// Solo accesibles con rol 'admin'.
// retain: true → el broker recuerda el último estado y lo entrega a la ESP32
//                al reconectarse, sin necesidad de volver a pulsar el botón.
// ═══════════════════════════════════════════════════════════════════════════════

const ACTUATORS = [
  { id: 'gpio12', label: 'GPIO 12', topic: 'esp32/actuator/gpio12' },
  { id: 'gpio14', label: 'GPIO 14', topic: 'esp32/actuator/gpio14' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTES DE RENDERIZADO
// ═══════════════════════════════════════════════════════════════════════════════

/** Muestras en el buffer circular (~5 s a 62.5 Hz). */
const HISTORY_SIZE = 320;

// ═══════════════════════════════════════════════════════════════════════════════
// ESTRUCTURAS DE DATOS
// ═══════════════════════════════════════════════════════════════════════════════

/** Map<topic, sensor> para lookup O(1) en el hot-path de 186 msg/s. */
const SENSOR_MAP = new Map(SENSORS.map(s => [s.topic, s]));

/**
 * Estado por sensor.
 * Float64Array: buffer de memoria fija → el GC nunca lo recolecta.
 */
const sensorState = {};
SENSORS.forEach(s => {
  sensorState[s.id] = {
    config:    s,
    data:      new Float64Array(HISTORY_SIZE),
    writeIdx:  0,
    filled:    false,
    lastValue: 0,
    fps:       0,
    frameAcc:  0,
    fpsTimer:  performance.now(),
  };
});

/** Estado lógico de cada actuador (feedback inmediato sin esperar broker). */
const actuatorState = {};
ACTUATORS.forEach(a => { actuatorState[a.id] = false; });

// ═══════════════════════════════════════════════════════════════════════════════
// REFERENCIAS DOM
// ═══════════════════════════════════════════════════════════════════════════════

// — Login
const loginScreen    = document.getElementById('login-screen');
const inputUsername  = document.getElementById('input-username');
const inputPassword  = document.getElementById('input-password');
const btnLogin       = document.getElementById('btn-login');
const loginError     = document.getElementById('login-error');
const loginErrorText = document.getElementById('login-error-text');

// — Dashboard
const dashboard       = document.getElementById('dashboard');
const statusBadge     = document.getElementById('status-badge');
const statusText      = document.getElementById('status-text');
const sessionUsername = document.getElementById('session-username');
const sessionRole     = document.getElementById('session-role');
const btnLogout       = document.getElementById('btn-logout');
const actuatorGrid    = document.getElementById('actuator-grid');
const actuatorLocked  = document.getElementById('actuator-locked');
const chartsGrid      = document.getElementById('charts-grid');

// ═══════════════════════════════════════════════════════════════════════════════
// AUTENTICACIÓN Y CONTROL DE VISTAS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Muestra el dashboard para el usuario de la sesión dada.
 * Aplica las restricciones de rol antes de revelar la UI.
 * @param {{ username: string, role: string }} session
 */
function showDashboard(session) {
  // Actualizar chip de sesión en el header
  sessionUsername.textContent = session.username;
  sessionRole.textContent     = session.role === 'admin' ? 'Admin' : 'Viewer';
  sessionRole.className       = 'role-badge ' + session.role;

  // Aplicar permisos de rol en los actuadores
  if (session.role === 'admin') {
    actuatorLocked.style.display = 'none';
    actuatorGrid.style.display   = 'grid';
  } else {
    // Viewer: ocultar controles, mostrar aviso
    actuatorLocked.style.display = 'flex';
    actuatorGrid.style.display   = 'none';
  }

  // Revelar dashboard y ocultar login
  loginScreen.classList.add('hidden');
  // Esperar a que termine la animación de salida del login para eliminarlo del flujo
  loginScreen.addEventListener('animationend', () => {
    loginScreen.style.display = 'none';
  }, { once: true });

  dashboard.classList.add('visible');
}

/** Vuelve a la pantalla de login limpiando el estado de la sesión. */
function showLogin() {
  logout();

  dashboard.classList.remove('visible');
  loginScreen.style.display = '';
  loginScreen.classList.remove('hidden');
  inputUsername.value = '';
  inputPassword.value = '';
  inputUsername.focus();
  hideLoginError();
}

function showLoginError(msg) {
  loginErrorText.textContent = msg;
  loginError.classList.add('visible');
}

function hideLoginError() {
  loginError.classList.remove('visible');
}

// ── Manejador del formulario de login ─────────────────────────────────────────

function handleLogin() {
  const username = inputUsername.value;
  const password = inputPassword.value;
  hideLoginError();

  if (!username || !password) {
    showLoginError('Por favor completa todos los campos.');
    return;
  }

  const result = login(username, password);
  if (!result.ok) {
    showLoginError(result.error);
    inputPassword.value = '';
    inputPassword.focus();
    return;
  }

  showDashboard(result.user);
}

// Disparar con botón o tecla Enter
btnLogin.addEventListener('click', handleLogin);
inputPassword.addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });
inputUsername.addEventListener('keydown', e => { if (e.key === 'Enter') inputPassword.focus(); });
btnLogout.addEventListener('click', showLogin);

// ── Restaurar sesión si el usuario ya estaba autenticado (recarga de página) ──
const existingSession = getSession();
if (existingSession) {
  showDashboard(existingSession);
} else {
  inputUsername.focus();
}

// ═══════════════════════════════════════════════════════════════════════════════
// PANEL DE ACTUADORES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Genera las tarjetas de control de GPIO y registra el listener delegado.
 * Llamado una sola vez al cargar la página (independientemente del rol;
 * la visibilidad se controla en showDashboard).
 */
function buildActuatorPanel() {
  ACTUATORS.forEach(a => {
    const card = document.createElement('div');
    card.className = 'actuator-card';
    card.id        = 'acard-' + a.id;
    card.innerHTML = `
      <div class="actuator-meta">
        <span class="actuator-topic">${a.topic}</span>
        <span class="actuator-name">${a.label}</span>
      </div>
      <span class="actuator-status off" id="astat-${a.id}">OFF</span>
      <div class="actuator-btns">
        <button class="btn-act btn-on"  data-id="${a.id}" data-val="1" disabled>ON</button>
        <button class="btn-act btn-off" data-id="${a.id}" data-val="0" disabled>OFF</button>
      </div>
    `;
    actuatorGrid.appendChild(card);
  });

  // Event delegation: un solo listener para todos los botones
  actuatorGrid.addEventListener('click', e => {
    const btn = e.target.closest('.btn-act');
    if (!btn || btn.disabled) return;

    // Verificar rol en tiempo de ejecución (doble comprobación de seguridad)
    if (!hasRole('admin')) return;

    const { id, val } = btn.dataset;
    const actuator = ACTUATORS.find(a => a.id === id);
    if (!actuator) return;

    const isOn = val === '1';
    client.publish(actuator.topic, isOn ? '1' : '0', { qos: 0, retain: true });

    // Feedback inmediato sin esperar confirmación del broker
    actuatorState[id] = isOn;
    updateActuatorUI(id, isOn);
  });
}

/**
 * Actualiza visualmente el badge y la tarjeta de un actuador.
 * @param {string}  id   ID del actuador (ej. 'gpio12')
 * @param {boolean} isOn
 */
function updateActuatorUI(id, isOn) {
  const stat = document.getElementById('astat-' + id);
  const card = document.getElementById('acard-' + id);
  if (!stat || !card) return;
  stat.textContent = isOn ? 'ON' : 'OFF';
  stat.className   = 'actuator-status ' + (isOn ? 'on' : 'off');
  card.classList.toggle('is-on', isOn);
}

/**
 * Habilita o deshabilita los botones de actuadores.
 * Se llama junto con setStatus() para bloquear controles si el broker cae.
 * @param {boolean} enabled
 */
function setActuatorButtonsEnabled(enabled) {
  actuatorGrid.querySelectorAll('.btn-act').forEach(btn => {
    btn.disabled = !enabled;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TARJETAS DE SENSORES
// ═══════════════════════════════════════════════════════════════════════════════

SENSORS.forEach(sensor => {
  const card = document.createElement('div');
  card.className = 'sensor-card';
  card.id        = 'card-' + sensor.id;
  card.innerHTML = `
    <div class="card-header">
      <span class="card-title">${sensor.label}</span>
      <div class="card-stats">
        <span class="stat-chip"      id="val-${sensor.id}">— ${sensor.unit}</span>
        <span class="stat-chip fps-chip" id="fps-${sensor.id}">— fps</span>
      </div>
    </div>
    <canvas id="canvas-${sensor.id}" class="sensor-canvas"
            aria-label="Gráfica ${sensor.label}"></canvas>
    <div class="axis-labels">
      <span class="axis-y-max">${sensor.maxValue}</span>
      <span class="axis-y-min">0</span>
      <span class="axis-x-label">← ${(HISTORY_SIZE / 62.5).toFixed(1)} s</span>
    </div>
  `;
  chartsGrid.appendChild(card);
});

// ═══════════════════════════════════════════════════════════════════════════════
// CANVAS — INICIALIZACIÓN Y REDIMENSIONADO
// ═══════════════════════════════════════════════════════════════════════════════

/** Map<sensorId, { canvas, ctx, cssW, cssH }> */
const canvasMap = {};

/**
 * Inicializa cada canvas con sus dimensiones reales escaladas por devicePixelRatio.
 * Se llama en 'load' y en 'resize'.
 */
function initCanvases() {
  SENSORS.forEach(sensor => {
    const canvas = document.getElementById('canvas-' + sensor.id);
    const dpr    = window.devicePixelRatio || 1;
    const rect   = canvas.getBoundingClientRect();
    canvas.width  = rect.width  * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    canvasMap[sensor.id] = { canvas, ctx, cssW: rect.width, cssH: rect.height };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// RENDERIZADO DE GRÁFICAS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Cache de LinearGradient por canvas.
 * Crearlos dentro del rAF genera un objeto nuevo a 60/s → presión en el GC.
 * La clave incluye H para invalidar si el canvas cambia de tamaño.
 */
const gradientCache = {};

function getGradient(ctx, H, color, id) {
  const key = id + H;
  if (!gradientCache[key]) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, color + '44');
    g.addColorStop(1, color + '00');
    gradientCache[key] = g;
  }
  return gradientCache[key];
}

/** Dibuja un sensor en su canvas. Llamado desde renderLoop() en cada vsync. */
function drawSensor(state) {
  const id  = state.config.id;
  const map = canvasMap[id];
  if (!map) return;

  const { ctx, cssW: W, cssH: H } = map;
  const isDark     = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const BG         = isDark ? '#0d1018' : '#eef0f7';
  const GRID_COLOR = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
  const LINE_COLOR = state.config.color;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // Grilla horizontal
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth   = 0.5;
  for (let i = 1; i < 5; i++) {
    const y = (H / 5) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  const count    = state.filled ? HISTORY_SIZE : state.writeIdx;
  if (count < 2) return;

  const maxVal   = state.config.maxValue;
  const stepX    = W / (HISTORY_SIZE - 1);
  const startIdx = state.filled ? state.writeIdx : 0;

  // Área rellena bajo la curva
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const bufIdx = state.filled ? (startIdx + i) % HISTORY_SIZE : i;
    const x = i * stepX;
    const y = H - (state.data[bufIdx] / maxVal) * H;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.lineTo((count - 1) * stepX, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fillStyle = getGradient(ctx, H, LINE_COLOR, id);
  ctx.fill();

  // Línea principal
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const bufIdx = state.filled ? (startIdx + i) % HISTORY_SIZE : i;
    const x = i * stepX;
    const y = H - (state.data[bufIdx] / maxVal) * H;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = LINE_COLOR;
  ctx.lineWidth   = 1.5;
  ctx.lineJoin    = 'round';
  ctx.stroke();

  // Punto del último valor
  const lastBufIdx = state.filled
    ? (state.writeIdx === 0 ? HISTORY_SIZE - 1 : state.writeIdx - 1)
    : Math.max(0, state.writeIdx - 1);
  const lastX = (count - 1) * stepX;
  const lastY = H - (state.data[lastBufIdx] / maxVal) * H;

  ctx.beginPath();
  ctx.arc(lastX, lastY, 3.5, 0, Math.PI * 2);
  ctx.fillStyle   = LINE_COLOR;
  ctx.fill();
  ctx.strokeStyle = isDark ? '#0d1018' : '#eef0f7';
  ctx.lineWidth   = 1.5;
  ctx.stroke();
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTUALIZACIÓN DE ETIQUETAS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Cache de strings para evitar writes al DOM cuando el valor no cambió.
 * A 60 rAF/s, tocar el DOM innecesariamente fuerza reflows.
 */
const _labelCache = {};

function updateLabels(state) {
  const id  = state.config.id;
  const val = state.lastValue + ' ' + state.config.unit;
  const fps = state.fps.toFixed(0) + ' fps';

  if (_labelCache[id + 'v'] !== val) {
    const el = document.getElementById('val-' + id);
    if (el) el.textContent = val;
    _labelCache[id + 'v'] = val;
  }
  if (_labelCache[id + 'f'] !== fps) {
    const el = document.getElementById('fps-' + id);
    if (el) el.textContent = fps;
    _labelCache[id + 'f'] = fps;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOOP DE RENDER (requestAnimationFrame)
// ═══════════════════════════════════════════════════════════════════════════════

/** Dibuja todos los sensores en cada vsync. No crea objetos → cero GC por frame. */
function renderLoop() {
  SENSORS.forEach(s => {
    drawSensor(sensorState[s.id]);
    updateLabels(sensorState[s.id]);
  });
  requestAnimationFrame(renderLoop);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLIENTE MQTT
// ═══════════════════════════════════════════════════════════════════════════════

const client = mqtt.connect(BROKER_URL, BROKER_OPTIONS);

/** Actualiza el badge de conexión y el estado de los botones de actuadores. */
function setStatus(connected) {
  if (connected) {
    statusBadge.className  = 'status-dot connected';
    statusText.textContent = 'Conectado al broker';
  } else {
    statusBadge.className  = 'status-dot disconnected';
    statusText.textContent = 'Desconectado del broker';
  }
  setActuatorButtonsEnabled(connected);
}

// ── Eventos de conexión ───────────────────────────────────────────────────────

client.on('connect', () => {
  console.log('[MQTT] Conectado al broker');
  setStatus(true);

  const sensorTopics = SENSORS.map(s => s.topic);
  client.subscribe(sensorTopics, { qos: 0 }, (err) => {
    if (err) console.error('[MQTT] Error al suscribir sensores:', err);
    else     console.log('[MQTT] Suscrito a:', sensorTopics.join(', '));
  });
});

client.on('close',      () => { console.warn('[MQTT] Conexión cerrada');     setStatus(false); });
client.on('disconnect', () => { console.warn('[MQTT] Desconectado');         setStatus(false); });
client.on('error',  err => { console.error('[MQTT]', err.message);          setStatus(false); });

// ── Recepción de mensajes de sensores ─────────────────────────────────────────

client.on('message', (topic, rawMessage) => {
  const sensor = SENSOR_MAP.get(topic);   // O(1), sin closures ni allocations
  if (!sensor) return;

  const state = sensorState[sensor.id];
  if (!state) return;

  const value = parseInt(rawMessage, 10);
  if (isNaN(value)) return;

  // Escribir en el buffer circular tipado
  state.data[state.writeIdx] = value;
  state.writeIdx = (state.writeIdx + 1) % HISTORY_SIZE;
  if (state.writeIdx === 0) state.filled = true;

  state.lastValue = value;

  // FPS muestreado cada 500 ms para reducir el coste de performance.now()
  state.frameAcc++;
  const now     = performance.now();
  const elapsed = now - state.fpsTimer;
  if (elapsed >= 500) {
    state.fps      = (state.frameAcc / elapsed) * 1000;
    state.frameAcc = 0;
    state.fpsTimer = now;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// INICIO
// ═══════════════════════════════════════════════════════════════════════════════

window.addEventListener('load', () => {
  buildActuatorPanel();
  initCanvases();
  requestAnimationFrame(renderLoop);
});

// Redimensionado: invalidar cache de gradientes y reescalar canvas
window.addEventListener('resize', () => {
  Object.keys(gradientCache).forEach(k => delete gradientCache[k]);
  initCanvases();
});