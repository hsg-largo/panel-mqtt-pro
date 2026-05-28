/**
 * auth.js — Módulo de autenticación y control de acceso por roles
 *
 * Roles disponibles:
 *  - 'viewer'  → solo lectura (gráficas de sensores)
 *  - 'admin'   → lectura + control de actuadores
 *
 * NOTA DE SEGURIDAD:
 *  Las credenciales aquí son validación client-side, adecuada para
 *  entornos de red local / industrial sin exposición pública.
 *  Para producción en internet, reemplazar por autenticación server-side
 *  con JWT o sesiones firmadas.
 */

// ─── USUARIOS REGISTRADOS ─────────────────────────────────────────────────────
const USERS = [
  { username: 'admin', password: 'admin123', role: 'admin'  },
  { username: 'user',  password: 'user123',  role: 'viewer' },
];

// Clave usada para persistir la sesión en sessionStorage
// (sessionStorage se borra al cerrar la pestaña, más seguro que localStorage)
const SESSION_KEY = 'iiot_session';

// ─── API PÚBLICA ──────────────────────────────────────────────────────────────

/**
 * Intenta autenticar con las credenciales dadas.
 * @param {string} username
 * @param {string} password
 * @returns {{ ok: boolean, user?: { username: string, role: string }, error?: string }}
 */
export function login(username, password) {
  const user = USERS.find(
    u => u.username === username.trim() && u.password === password
  );
  if (!user) {
    return { ok: false, error: 'Credenciales incorrectas.' };
  }
  const session = { username: user.username, role: user.role };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return { ok: true, user: session };
}

/**
 * Cierra la sesión activa y limpia el almacenamiento.
 */
export function logout() {
  sessionStorage.removeItem(SESSION_KEY);
}

/**
 * Devuelve la sesión activa, o null si no hay ninguna.
 * @returns {{ username: string, role: string } | null}
 */
export function getSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Comprueba si el usuario activo tiene un rol específico.
 * @param {'admin'|'viewer'} role
 * @returns {boolean}
 */
export function hasRole(role) {
  const session = getSession();
  return session?.role === role;
}