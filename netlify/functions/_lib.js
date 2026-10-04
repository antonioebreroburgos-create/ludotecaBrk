// Utilidades compartidas por todas las funciones de la Ludoteca
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const SECRET = process.env.AUTH_SECRET;
const DURACION_SESION_HORAS = 16;   // una jornada: cada día se vuelve a meter el PIN

// ---------- Respuestas ----------
function respuesta(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function leerBody(event) {
  try { return JSON.parse(event.body || '{}'); } catch { return {}; }
}

// ---------- PIN ----------
function pinValido(pin) {
  return /^\d{4,6}$/.test(String(pin || ''));
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verificarPin(pin, guardado) {
  const [salt, hash] = String(guardado || '').split(':');
  if (!salt || !hash) return false;
  const calculado = crypto.scryptSync(String(pin), salt, 32);
  const original = Buffer.from(hash, 'hex');
  return original.length === calculado.length && crypto.timingSafeEqual(original, calculado);
}

// Devuelve true si algún usuario activo (distinto de excluirId) ya usa ese PIN
async function pinEnUso(pin, excluirId = null) {
  const { data } = await supabase.from('usuarios').select('id, pin_hash').eq('activo', true);
  return (data || []).some(u => u.id !== excluirId && verificarPin(pin, u.pin_hash));
}

// ---------- Token de sesión (firmado con AUTH_SECRET) ----------
function crearToken(usuario) {
  const payload = {
    id: usuario.id,
    nombre: usuario.nombre,
    rol: usuario.rol,
    exp: Date.now() + DURACION_SESION_HORAS * 3600 * 1000
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const firma = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${firma}`;
}

function leerToken(token) {
  const [data, firma] = String(token || '').split('.');
  if (!data || !firma) return null;
  const esperada = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  const a = Buffer.from(firma), b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch { return null; }
}

// Comprueba token + que el usuario siga activo + rol permitido.
// Uso: const { usuario, error } = await requerirUsuario(event, ['ADMIN']); if (error) return error;
async function requerirUsuario(event, rolesPermitidos = null) {
  const cabecera = event.headers.authorization || event.headers.Authorization || '';
  const payload = leerToken(cabecera.replace(/^Bearer\s+/i, ''));
  if (!payload) return { error: respuesta(401, { error: 'La sesión ha caducado. Vuelve a entrar con tu PIN.' }) };

  const { data: u } = await supabase
    .from('usuarios').select('id, nombre, rol, activo').eq('id', payload.id).maybeSingle();
  if (!u || !u.activo) return { error: respuesta(401, { error: 'Este usuario está desactivado.' }) };
  if (rolesPermitidos && !rolesPermitidos.includes(u.rol)) {
    return { error: respuesta(403, { error: 'Tu usuario no tiene permiso para esta acción.' }) };
  }
  return { usuario: u };
}

function ipCliente(event) {
  return event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || 'desconocida';
}

module.exports = {
  supabase, respuesta, leerBody,
  pinValido, hashPin, verificarPin, pinEnUso,
  crearToken, requerirUsuario, ipCliente
};
