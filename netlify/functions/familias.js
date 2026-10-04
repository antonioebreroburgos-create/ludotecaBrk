// /.netlify/functions/familias
// GET  ?q=texto                       → niños encontrados con tutores, tarifa de hoy y si ya entraron
// POST { accion:'alta', tutor, ninos } → alta de familia nueva (o niños nuevos para un tutor existente)
// POST { accion:'vincular', nino_ids, tutor } → añade otro adulto (abuela, tío...) a esos niños
const {
  supabase, respuesta, leerBody, requerirUsuario,
  normalizarTelefono, fechaValida, texto, errorHttp, responderError
} = require('./_lib');

// Ficha completa de cada niño, lista para pintar en el móvil
async function fichas(ids) {
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
      tutores: rL.data
        .filter(l => l.nino_id === n.id && l.tutores)
        .map(l => ({ ...l.tutores, parentesco: l.parentesco, principal: l.principal }))
        .sort((a, b) => b.principal - a.principal)
    };
  }).sort((a, b) =>
    `${a.nombre} ${a.apellidos || ''}`.localeCompare(`${b.nombre} ${b.apellidos || ''}`, 'es'));
}

// Usa un tutor existente (t.id) o crea uno nuevo comprobando que el teléfono no exista ya
async function obtenerOCrearTutor(t = {}) {
  if (t.id) {
    const { data } = await supabase.from('tutores').select('id').eq('id', t.id).maybeSingle();
    if (!data) throw errorHttp(404, 'Ese adulto ya no existe.');
    return { id: data.id, creado: false };
  }
  const nombre = texto(t.nombre);
  if (!nombre) throw errorHttp(400, 'Escribe el nombre del adulto.');
  const telefono = normalizarTelefono(t.telefono);
  if (!telefono) throw errorHttp(400, 'El teléfono no es válido. Escribe los 9 números.');
  if (t.fecha_nacimiento && !fechaValida(t.fecha_nacimiento)) {
    throw errorHttp(400, 'La fecha de nacimiento del adulto no es válida.');
  }
  if (!t.consentimiento_servicio) {
    throw errorHttp(400, 'Sin el consentimiento obligatorio no se pueden guardar los datos.');
  }

  const { data: existe } = await supabase
    .from('tutores').select('id, nombre, apellidos').eq('telefono', telefono).maybeSingle();
  if (existe) {
    const quien = `${existe.nombre} ${existe.apellidos || ''}`.trim();
    throw errorHttp(409, `Ese teléfono ya es de ${quien}.`, { tutorExistente: existe });
  }

  const ahora = new Date().toISOString();
  const { data, error } = await supabase.from('tutores').insert({
    nombre,
    apellidos: texto(t.apellidos),
    telefono,
    email: texto(t.email, 120),
    fecha_nacimiento: t.fecha_nacimiento || null,
    consentimiento_servicio: true,
    consentimiento_servicio_at: ahora,
    consentimiento_marketing: !!t.consentimiento_marketing,
    consentimiento_marketing_at: t.consentimiento_marketing ? ahora : null
  }).select('id').single();
  if (error) throw error;
  return { id: data.id, creado: true };
}

exports.handler = async (event) => {
  const { error: errAuth } = await requerirUsuario(event);
  if (errAuth) return errAuth;

  try {
    // ---------- Buscar ----------
    if (event.httpMethod === 'GET') {
      const q = String(event.queryStringParameters?.q || '').trim();
      if (q.length < 2) return respuesta(200, { ninos: [] });
      const { data, error } = await supabase.rpc('buscar_ninos', { p_q: q });
      if (error) throw error;
      const ids = (data || []).map(x => typeof x === 'object' ? Object.values(x)[0] : x);
      return respuesta(200, { ninos: await fichas(ids) });
    }

    if (event.httpMethod !== 'POST') return respuesta(405, { error: 'Método no permitido' });
    const body = leerBody(event);

    // ---------- Alta de familia ----------
    if (body.accion === 'alta') {
      const lista = Array.isArray(body.ninos) ? body.ninos : [];
      if (!lista.length) throw errorHttp(400, 'Añade al menos un niño.');

      const filas = lista.map((n, i) => {
        const etiqueta = lista.length > 1 ? ` (niño ${i + 1})` : '';
        const nombre = texto(n.nombre);
        if (!nombre) throw errorHttp(400, `Falta el nombre${etiqueta}.`);
        if (!fechaValida(n.fecha_nacimiento)) throw errorHttp(400, `La fecha de nacimiento no es válida${etiqueta}.`);
        return {
          nombre,
          apellidos: texto(n.apellidos),
          fecha_nacimiento: n.fecha_nacimiento,
          observaciones: texto(n.observaciones, 300)
        };
      });

      const tutor = await obtenerOCrearTutor(body.tutor);
      try {
        const { data: nuevos, error } = await supabase.from('ninos').insert(filas).select('id');
        if (error) throw error;
        const ids = nuevos.map(n => n.id);
        const { error: e2 } = await supabase.from('nino_tutor').insert(ids.map(id => ({
          nino_id: id, tutor_id: tutor.id, parentesco: texto(body.tutor?.parentesco, 30), principal: true
        })));
        if (e2) { await supabase.from('ninos').delete().in('id', ids); throw e2; }
        return respuesta(200, { tutor_id: tutor.id, ninos: await fichas(ids) });
      } catch (e) {
        if (tutor.creado) await supabase.from('tutores').delete().eq('id', tutor.id);
        throw e;
      }
    }

    // ---------- Añadir otro adulto a unos niños ----------
    if (body.accion === 'vincular') {
      const ids = [...new Set((body.nino_ids || []).map(Number).filter(Boolean))];
      if (!ids.length) throw errorHttp(400, 'No hay niños seleccionados.');
      const tutor = await obtenerOCrearTutor(body.tutor);
      const { error } = await supabase.from('nino_tutor').upsert(
        ids.map(id => ({ nino_id: id, tutor_id: tutor.id, parentesco: texto(body.tutor?.parentesco, 30), principal: false })),
        { onConflict: 'nino_id,tutor_id', ignoreDuplicates: true }
      );
      if (error) throw error;
      return respuesta(200, { tutor_id: tutor.id, ninos: await fichas(ids) });
    }

    throw errorHttp(400, 'Acción desconocida.');
  } catch (e) {
    return responderError(e, 'familias');
  }
};
