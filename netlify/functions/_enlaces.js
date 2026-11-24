// Utilidades compartidas de los enlaces que se envían a clientes por WhatsApp
// y de las fichas de niños (las usan enlaces.js y publico.js)
const crypto = require('crypto');
const { supabase, errorHttp } = require('./_lib');

// El código del enlace solo lo conoce quien recibe el WhatsApp: en la base de datos
// se guarda su huella (hash), así que si alguien viera la tabla no podría usarlo.
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

// Dirección pública de la app (Netlify la pone en process.env.URL)
function baseUrl(event) {
  if (process.env.URL) return process.env.URL.replace(/\/$/, '');
  const host = event.headers['x-forwarded-host'] || event.headers.host;
  return `https://${host}`;
}

// Crea un enlace y devuelve { id, token, url }
async function nuevoEnlace(event, { tipo, telefono = null, fiestaId = null, caducaAt, usuarioId, visible = false }) {
  const token = crypto.randomBytes(18).toString('base64url');
  const { data, error } = await supabase.from('enlaces').insert({
    token_hash: hashToken(token), tipo, telefono, fiesta_id: fiestaId,
    caduca_at: caducaAt, creado_por: usuarioId,
    token_visible: visible ? token : null      // solo el cartel: su QR va impreso en un papel público
  }).select('id').single();
  if (error) throw error;
  return { id: data.id, token, url: `${baseUrl(event)}/registro.html?t=${token}` };
}

// Busca un enlace por su código y dice si se puede usar
async function leerEnlace(token) {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(String(token || ''))) throw errorHttp(404, 'Este enlace no es válido.');
  const { data, error } = await supabase.from('enlaces').select('*').eq('token_hash', hashToken(token)).maybeSingle();
  if (error) throw error;
  if (!data) throw errorHttp(404, 'Este enlace no es válido.');
  let estado = 'OK';
  if (data.anulado) estado = 'ANULADO';
  else if (data.tipo === 'REGISTRO' && data.usado_at) estado = 'USADO';
  else if (new Date(data.caduca_at) < new Date()) estado = 'CADUCADO';
  return { enlace: data, estado };
}

// Ficha de cada niño lista para pintar en el móvil (igual que en familias.js)
async function fichasNinos(ids) {
  if (!ids.length) return [];
  const [rN, rL, rI] = await Promise.all([
    supabase.from('ninos').select('id, nombre, apellidos, fecha_nacimiento, observaciones').in('id', ids),
    supabase.from('nino_tutor').select('nino_id, parentesco, principal, tutores(id, nombre, apellidos, telefono)').in('nino_id', ids),
    supabase.rpc('info_entrada_hoy', { p_ids: ids })
  ]);
  for (const r of [rN, rL, rI]) if (r.error) throw r.error;
  const info = new Map(rI.data.map(i => [i.nino_id, i]));
  return rN.data.map(n => {
    const i = info.get(n.id) || {};
    return {
      ...n,
      es_socio: !!i.es_socio,
      tarifa_codigo: i.tarifa_codigo,
      tarifa_nombre: i.tarifa_nombre,
      precio: Number(i.precio ?? 0),
      entrada_hoy: i.entrada_hoy || null,
      numero_pulsera: i.numero_pulsera || null,
      socio_hasta: i.socio_hasta || null,
      tutores: rL.data
        .filter(l => l.nino_id === n.id && l.tutores)
        .map(l => ({ ...l.tutores, parentesco: l.parentesco, principal: l.principal }))
        .sort((a, b) => b.principal - a.principal)
    };
  }).sort((a, b) => `${a.nombre} ${a.apellidos || ''}`.localeCompare(`${b.nombre} ${b.apellidos || ''}`, 'es'));
}

module.exports = { hashToken, baseUrl, nuevoEnlace, leerEnlace, fichasNinos };
