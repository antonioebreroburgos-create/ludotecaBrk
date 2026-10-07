// /.netlify/functions/cumpleanos
// GET  ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD       → cumpleaños en ese rango (solo quien aceptó promociones) + plantillas
// POST { accion:'marcar', tipo, persona_id, anio, tutor_id } → apunta que se envió la invitación
// POST { accion:'desmarcar', tipo, persona_id, anio }        → quita esa marca
// POST { accion:'plantillas', nino, adulto, socio }          → guarda los textos (solo ADMIN)
const {
  supabase, respuesta, leerBody, requerirUsuario, hoyMadrid, texto, errorHttp, responderError
} = require('./_lib');

const CLAVES = { nino: 'plantilla_cumple_nino', adulto: 'plantilla_cumple_adulto', socio: 'texto_cumple_socio' };

function fechaReal(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function sumarDias(f, n) {
  const d = new Date(f + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function plantillas() {
  const { data, error } = await supabase.from('ajustes').select('clave, valor').in('clave', Object.values(CLAVES));
  if (error) throw error;
  const m = Object.fromEntries(data.map(a => [a.clave, a.valor]));
  return { nino: m[CLAVES.nino] || '', adulto: m[CLAVES.adulto] || '', socio: m[CLAVES.socio] || '' };
}

exports.handler = async (event) => {
  const { usuario, error: errAuth } = await requerirUsuario(event);
  if (errAuth) return errAuth;

  try {
    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      const hoy = hoyMadrid();
      const desde = fechaReal(q.desde) ? q.desde : hoy;
      const hasta = fechaReal(q.hasta) ? q.hasta : sumarDias(desde, 30);
      if (hasta < desde) throw errorHttp(400, 'La fecha final es anterior a la inicial.');
      if (sumarDias(desde, 366) < hasta) throw errorHttp(400, 'Elige como mucho un año.');
      const [rC, p] = await Promise.all([
        supabase.rpc('cumpleanos', { p_desde: desde, p_hasta: hasta }),
        plantillas()
      ]);
      if (rC.error) throw rC.error;
      return respuesta(200, { hoy, desde, hasta, cumpleanos: rC.data, plantillas: p });
    }

    if (event.httpMethod !== 'POST') return respuesta(405, { error: 'Método no permitido' });
    const body = leerBody(event);

    if (body.accion === 'marcar' || body.accion === 'desmarcar') {
      const tipo = body.tipo, id = Number(body.persona_id), anio = Number(body.anio);
      if (!['NINO', 'TUTOR'].includes(tipo) || !id || !anio) throw errorHttp(400, 'Faltan datos.');
      if (body.accion === 'marcar') {
        const { error } = await supabase.from('invitaciones_cumple').upsert(
          { tipo, persona_id: id, anio, tutor_id: Number(body.tutor_id) || null, usuario_id: usuario.id, enviado_at: new Date().toISOString() },
          { onConflict: 'tipo,persona_id,anio' });
        if (error) throw error;
      } else {
        const { error } = await supabase.from('invitaciones_cumple').delete()
          .eq('tipo', tipo).eq('persona_id', id).eq('anio', anio);
        if (error) throw error;
      }
      return respuesta(200, { ok: true });
    }

    if (body.accion === 'plantillas') {
      if (usuario.rol !== 'ADMIN') throw errorHttp(403, 'Solo el administrador puede cambiar los mensajes.');
      const filas = [];
      for (const [k, clave] of Object.entries(CLAVES)) {
        if (body[k] === undefined) continue;
        const v = k === 'socio' ? String(body[k] ?? '').slice(0, 300) : texto(body[k], 1000);
        if (k !== 'socio' && !v) throw errorHttp(400, 'El mensaje no puede quedar vacío.');
        filas.push({ clave, valor: v || '', updated_at: new Date().toISOString() });
      }
      const { error } = await supabase.from('ajustes').upsert(filas, { onConflict: 'clave' });
      if (error) throw error;
      return respuesta(200, { plantillas: await plantillas() });
    }

    throw errorHttp(400, 'Acción desconocida.');
  } catch (e) {
    return responderError(e, 'cumpleanos');
  }
};
