// Utilidades compartidas por todas las funciones de la Ludoteca
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const SECRET = process.env.AUTH_SECRET;

// El día de la ludoteca termina a las 6:00 de la mañana (hora de España):
// lo que pasa entre las 00:00 y las 6:00 cuenta como el día anterior.
// OJO: la misma hora está en index.html (HORA_CAMBIO_DIA) y en la función hoy() de Supabase.
const HORA_CAMBIO_DIA = 6;

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
    exp: finJornadaMs()          // la sesión dura hasta que termina la jornada (6:00)
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

// ---------- Datos ----------
// "Hoy" de la ludoteca en formato YYYY-MM-DD: la fecha de España, pero hasta las 6:00
// sigue siendo el día anterior (los fines de semana se cierra después de medianoche)
function horaEspana(fecha) {
  return Number(fecha.toLocaleString('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hourCycle: 'h23' }));
}
function hoyMadrid() {
  const ahora = new Date();
  const fecha = ahora.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
  if (horaEspana(ahora) >= HORA_CAMBIO_DIA) return fecha;
  const d = new Date(fecha + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Momento (en ms) en que termina la jornada actual: las 6:00 del día siguiente, hora de España
function finJornadaMs() {
  const d = new Date(hoyMadrid() + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), HORA_CAMBIO_DIA);
  // t son las 6:00 en UTC; se corrige con el desfase de España (1 h en invierno, 2 h en verano)
  t -= (horaEspana(new Date(t)) - HORA_CAMBIO_DIA) * 3600 * 1000;
  return t;
}

// '617 79 62 60' → '+34617796260'. Devuelve null si no es válido.
function normalizarTelefono(t) {
  let d = String(t || '').replace(/[^\d+]/g, '');
  if (d.startsWith('00')) d = '+' + d.slice(2);
  if (/^[6789]\d{8}$/.test(d)) d = '+34' + d;
  return /^\+\d{9,15}$/.test(d) ? d : null;
}

// Fecha YYYY-MM-DD real, no futura y posterior a 1900
function fechaValida(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d) || d.toISOString().slice(0, 10) !== s) return false;
  return s >= '1900-01-01' && s <= hoyMadrid();
}

function texto(s, max = 80) {
  const t = String(s ?? '').trim();
  return t ? t.slice(0, max) : null;
}

// Error con código HTTP para lanzar desde la lógica y responder en el catch
function errorHttp(status, mensaje, extra = {}) {
  const e = new Error(mensaje); e.status = status; e.extra = extra; return e;
}

function responderError(e, contexto) {
  if (e.status) return respuesta(e.status, { error: e.message, ...e.extra });
  if (e.code === '23505') return respuesta(409, { error: 'Ese dato ya está registrado.' });
  console.error(contexto, e);
  return respuesta(500, { error: 'Error del servidor. Inténtalo de nuevo.' });
}

module.exports = {
  supabase, respuesta, leerBody,
  pinValido, hashPin, verificarPin, pinEnUso,
  crearToken, requerirUsuario, ipCliente,
  hoyMadrid, normalizarTelefono, fechaValida, texto, errorHttp, responderError
};
