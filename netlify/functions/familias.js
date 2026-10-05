// /.netlify/functions/familias
// GET  ?q=texto                       → niños encontrados con tutores, tarifa de hoy y si ya entraron
// POST { accion:'alta', tutor, ninos } → alta de familia nueva (o niños nuevos para un tutor existente)
// POST { accion:'vincular', nino_ids, tutor } → añade otro adulto (abuela, tío...) a esos niños
// GET  ?id=N                                  → ficha completa del niño (datos, adultos, socio, visitas)
// POST { accion:'editar_nino', id, ... }       → corrige datos del niño
// POST { accion:'editar_tutor', id, nino_id, ... } → corrige datos de un adulto
// POST { accion:'desvincular', nino_id, tutor_id } → quita un adulto de un niño
const {
  supabase, respuesta, leerBody, requerirUsuario,
  normalizarTelefono, fechaValida, texto, errorHttp, responderError, hoyMadrid
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
      numero_pulsera: i.numero_pulsera || null,
      socio_hasta: i.socio_hasta || null,
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

// Todo lo que muestra la pantalla de ficha
async function fichaCompleta(id) {
  if (!id) throw errorHttp(400, 'Falta el niño.');
  const [rN, rL, rM, rP, rT, rV] = await Promise.all([
    supabase.from('ninos').select('id, nombre, apellidos, fecha_nacimiento, observaciones, numero_pulsera').eq('id', id).maybeSingle(),
    supabase.from('nino_tutor').select('parentesco, principal, tutores(id, nombre, apellidos, telefono, email, fecha_nacimiento, consentimiento_marketing)').eq('nino_id', id),
    supabase.from('membresias').select('id, fecha_alta, fecha_caducidad, activo').eq('nino_id', id).order('fecha_alta', { ascending: false }),
    supabase.rpc('periodo_cuota', { p_nino_id: id }),
    supabase.from('tarifas').select('codigo, nombre, precio').in('codigo', ['CUOTA_SOCIO', 'REPOSICION_PULSERA']),
    supabase.from('ticket_lineas').select('descripcion, precio, tickets!inner(fecha, creado_at, anulado)')
      .eq('nino_id', id).eq('tickets.anulado', false).order('id', { ascending: false }).limit(8)
  ]);
  for (const r of [rN, rL, rM, rP, rT, rV]) if (r.error) throw r.error;
  if (!rN.data) throw errorHttp(404, 'Ese niño ya no existe.');

  const hoy = hoyMadrid();
  const activas = rM.data.filter(m => m.activo);
  const vigente = activas.find(m => m.fecha_alta <= hoy && m.fecha_caducidad >= hoy);
  const futuras = activas.filter(m => m.fecha_caducidad >= hoy);
  const pasadas = activas.filter(m => m.fecha_caducidad < hoy);
  const periodo = Array.isArray(rP.data) ? rP.data[0] : rP.data;
  const precio = c => Number(rT.data.find(t => t.codigo === c)?.precio ?? 0);

  return {
    hoy,
    nino: rN.data,
    tutores: rL.data.filter(l => l.tutores)
      .map(l => ({ ...l.tutores, parentesco: l.parentesco, principal: l.principal }))
      .sort((a, b) => b.principal - a.principal),
    socio: {
      es_socio: !!vigente,
      hasta: futuras.length ? futuras.map(m => m.fecha_caducidad).sort().pop() : null,
      caducado_el: !futuras.length && pasadas.length ? pasadas.map(m => m.fecha_caducidad).sort().pop() : null,
      periodos: rM.data,
      proxima_cuota: periodo,
      precio_cuota: precio('CUOTA_SOCIO'),
      precio_reposicion: precio('REPOSICION_PULSERA')
    },
    visitas: rV.data.map(v => ({ fecha: v.tickets.fecha, creado_at: v.tickets.creado_at, descripcion: v.descripcion, precio: Number(v.precio) }))
  };
}

exports.handler = async (event) => {
  const { error: errAuth } = await requerirUsuario(event);
  if (errAuth) return errAuth;

  try {
    // ---------- Ficha completa ----------
    if (event.httpMethod === 'GET' && event.queryStringParameters?.id) {
      return respuesta(200, await fichaCompleta(Number(event.queryStringParameters.id)));
    }

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

    // ---------- Editar niño ----------
    if (body.accion === 'editar_nino') {
      const id = Number(body.id);
      const nombre = texto(body.nombre);
      if (!id) throw errorHttp(400, 'Falta el niño.');
      if (!nombre) throw errorHttp(400, 'El nombre no puede quedar vacío.');
      if (!fechaValida(body.fecha_nacimiento)) throw errorHttp(400, 'La fecha de nacimiento no es válida.');
      const pulsera = texto(body.numero_pulsera, 30);
      if (pulsera) {
        const { data: otro } = await supabase.from('ninos').select('id, nombre')
          .ilike('numero_pulsera', pulsera).neq('id', id).maybeSingle();
        if (otro) throw errorHttp(409, `Esa pulsera ya es de ${otro.nombre}.`);
      }
      const { error } = await supabase.from('ninos').update({
        nombre, apellidos: texto(body.apellidos), fecha_nacimiento: body.fecha_nacimiento,
        observaciones: texto(body.observaciones, 300), numero_pulsera: pulsera
      }).eq('id', id);
      if (error) throw error;
      return respuesta(200, await fichaCompleta(id));
    }

    // ---------- Editar adulto ----------
    if (body.accion === 'editar_tutor') {
      const id = Number(body.id), ninoId = Number(body.nino_id);
      const nombre = texto(body.nombre);
      const telefono = normalizarTelefono(body.telefono);
      if (!id) throw errorHttp(400, 'Falta el adulto.');
      if (!nombre) throw errorHttp(400, 'El nombre no puede quedar vacío.');
      if (!telefono) throw errorHttp(400, 'El teléfono no es válido. Escribe los 9 números.');
      if (body.fecha_nacimiento && !fechaValida(body.fecha_nacimiento)) {
        throw errorHttp(400, 'La fecha de nacimiento del adulto no es válida.');
      }
      const { data: otro } = await supabase.from('tutores').select('id, nombre, apellidos')
        .eq('telefono', telefono).neq('id', id).maybeSingle();
      if (otro) throw errorHttp(409, `Ese teléfono ya es de ${`${otro.nombre} ${otro.apellidos || ''}`.trim()}.`);

      const { data: actual } = await supabase.from('tutores').select('consentimiento_marketing').eq('id', id).maybeSingle();
      if (!actual) throw errorHttp(404, 'Ese adulto ya no existe.');
      const marketing = !!body.consentimiento_marketing;
      const cambios = {
        nombre, apellidos: texto(body.apellidos), telefono,
        email: texto(body.email, 120), fecha_nacimiento: body.fecha_nacimiento || null,
        consentimiento_marketing: marketing
      };
      // La fecha del consentimiento solo cambia cuando cambia la decisión
      if (marketing !== actual.consentimiento_marketing) {
        cambios.consentimiento_marketing_at = new Date().toISOString();
      }
      const { error } = await supabase.from('tutores').update(cambios).eq('id', id);
      if (error) throw error;
      if (ninoId && body.parentesco !== undefined) {
        const { error: e2 } = await supabase.from('nino_tutor')
          .update({ parentesco: texto(body.parentesco, 30) }).eq('nino_id', ninoId).eq('tutor_id', id);
        if (e2) throw e2;
      }
      return respuesta(200, ninoId ? await fichaCompleta(ninoId) : { ok: true });
    }

    // ---------- Quitar un adulto de un niño ----------
    if (body.accion === 'desvincular') {
      const ninoId = Number(body.nino_id), tutorId = Number(body.tutor_id);
      const { data: enlaces } = await supabase.from('nino_tutor').select('tutor_id, principal').eq('nino_id', ninoId);
      if (!enlaces || enlaces.length < 2) throw errorHttp(400, 'Un niño tiene que tener al menos un adulto.');
      const quitado = enlaces.find(e => e.tutor_id === tutorId);
      if (!quitado) throw errorHttp(404, 'Ese adulto no está en esta ficha.');
      const { error } = await supabase.from('nino_tutor').delete().eq('nino_id', ninoId).eq('tutor_id', tutorId);
      if (error) throw error;
      // Si era el principal, pasa a serlo otro (para los listados de cumpleaños)
      if (quitado.principal) {
        const otro = enlaces.find(e => e.tutor_id !== tutorId);
        await supabase.from('nino_tutor').update({ principal: true }).eq('nino_id', ninoId).eq('tutor_id', otro.tutor_id);
      }
      return respuesta(200, await fichaCompleta(ninoId));
    }

    throw errorHttp(400, 'Acción desconocida.');
  } catch (e) {
    return responderError(e, 'familias');
  }
};
