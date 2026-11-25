// /.netlify/functions/fiestas   (personal: administrador, monitora y camarero)
// GET                                   → fiestas desde hace 7 días en adelante, con nº de invitados
// GET  ?id=N                            → una fiesta con sus invitados
// POST { accion:'crear', ... }          → crea la fiesta y el enlace para el organizador (mensaje de WhatsApp)
// POST { accion:'editar', id, ... }     → cambia los datos de la fiesta
// POST { accion:'enlace', id }          → anula el enlace anterior y crea uno nuevo
// POST { accion:'anular', id }          → anula la fiesta y sus enlaces
// POST { accion:'llegada', invitado_id, ha_llegado }   → marca si un invitado ha llegado
// POST { accion:'invitado', fiesta_id, nombre, edad, avisos, relacion } → el personal añade un invitado
// POST { accion:'quitar_invitado', invitado_id }        → el personal quita un invitado
// POST { accion:'relacion', invitado_id, relacion }      → HIJO (del organizador) o REPRESENTADO (lo trae él)
// POST { accion:'ficha', invitado_id, nino_id|null }     → enlaza el invitado con la ficha de un niño cliente
const {
  supabase, respuesta, leerBody, requerirUsuario, normalizarTelefono, hoyMadrid, texto, errorHttp, responderError
} = require('./_lib');
const { nuevoEnlace } = require('./_enlaces');

function fechaReal(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function sumarDias(f, n) {
  const d = new Date(f + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const fechaLarga = f => new Date(f + 'T12:00:00Z').toLocaleDateString('es-ES',
  { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).replace(',', '');

function datosFiesta(body, nueva) {
  const hoy = hoyMadrid();
  if (!fechaReal(body.fecha)) throw errorHttp(400, 'Elige la fecha de la fiesta.');
  if (nueva && body.fecha < hoy) throw errorHttp(400, 'La fecha de la fiesta ya ha pasado.');
  if (body.fecha > sumarDias(hoy, 366)) throw errorHttp(400, 'La fecha está demasiado lejos.');
  const hora = String(body.hora || '').trim();
  if (hora && !/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) throw errorHttp(400, 'La hora no es válida.');
  const cumpleanero = texto(body.cumpleanero);
  const organizador = texto(body.organizador_nombre);
  const telefono = normalizarTelefono(body.organizador_telefono);
  if (!cumpleanero) throw errorHttp(400, 'Escribe el nombre del niño o niña que cumple años.');
  if (!organizador) throw errorHttp(400, 'Escribe el nombre del organizador.');
  if (!telefono) throw errorHttp(400, 'El teléfono del organizador no es válido.');
  let previstos = null;
  if (body.ninos_previstos !== '' && body.ninos_previstos !== null && body.ninos_previstos !== undefined) {
    previstos = Number(body.ninos_previstos);
    if (!Number.isInteger(previstos) || previstos < 1 || previstos > 200) throw errorHttp(400, 'El número de niños no es válido.');
  }
  return {
    fecha: body.fecha, hora: hora || null, cumpleanero, organizador_nombre: organizador,
    organizador_apellidos: texto(body.organizador_apellidos),
    organizador_telefono: telefono, ninos_previstos: previstos, observaciones: texto(body.observaciones, 300)
  };
}

async function detalle(id) {
  const [rF, rI] = await Promise.all([
    supabase.from('fiestas').select('*').eq('id', id).maybeSingle(),
    supabase.from('fiesta_invitados')
      .select('id, nombre, edad, avisos, es_cumpleanero, ha_llegado, relacion, nino_id, ninos ( id, nombre, apellidos, fecha_nacimiento, observaciones )')
      .eq('fiesta_id', id).order('orden').order('id')
  ]);
  for (const r of [rF, rI]) if (r.error) throw r.error;
  if (!rF.data) throw errorHttp(404, 'Esa fiesta no existe.');
  return { ...rF.data, invitados: rI.data.map(({ ninos, ...i }) => ({ ...i, ficha: ninos || null })) };
}

// Enlace nuevo para el organizador: vale hasta que termina el día de la fiesta
async function enlaceOrganizador(event, fiesta, usuarioId) {
  await supabase.from('enlaces').update({ anulado: true }).eq('fiesta_id', fiesta.id).eq('anulado', false);
  const { data: caduca, error } = await supabase.rpc('fin_jornada', { p_fecha: fiesta.fecha });
  if (error) throw error;
  const { url } = await nuevoEnlace(event, { tipo: 'FIESTA', fiestaId: fiesta.id, caducaAt: caduca, usuarioId });
  const mensaje = [
    `¡Hola ${fiesta.organizador_nombre}! 🎉`,
    '',
    `Para la fiesta de cumpleaños de *${fiesta.cumpleanero}* en Restaurante Brooklyn, el ${fechaLarga(fiesta.fecha)}${fiesta.hora ? ` a las ${fiesta.hora}` : ''}, apunta aquí a los niños que vienen (nombre, edad, si alguno tiene alergias y cuáles son tus hijos):`,
    url,
    '',
    'Puedes entrar y cambiar la lista las veces que quieras hasta el mismo día. ¡Gracias! 🎂'
  ].join('\n');
  return { url, mensaje, telefono: fiesta.organizador_telefono };
}

exports.handler = async (event) => {
  const { usuario, error: errAuth } = await requerirUsuario(event);
  if (errAuth) return errAuth;

  try {
    if (event.httpMethod === 'GET') {
      // Privacidad: los invitados de fiestas de hace más de 30 días se borran solos
      await supabase.rpc('limpiar_invitados_antiguos');
      const id = Number(event.queryStringParameters?.id);
      if (id) return respuesta(200, { hoy: hoyMadrid(), fiesta: await detalle(id) });

      const desde = sumarDias(hoyMadrid(), -7);
      const [rF, rI] = await Promise.all([
        supabase.from('fiestas').select('id, fecha, hora, cumpleanero, organizador_nombre, organizador_apellidos, ninos_previstos, anulada')
          .gte('fecha', desde).order('fecha').order('hora'),
        supabase.from('fiesta_invitados').select('fiesta_id, ha_llegado, fiestas!inner(fecha)').gte('fiestas.fecha', desde)
      ]);
      for (const r of [rF, rI]) if (r.error) throw r.error;
      const cuenta = new Map();
      rI.data.forEach(i => {
        const c = cuenta.get(i.fiesta_id) || { invitados: 0, llegados: 0 };
        c.invitados++; if (i.ha_llegado) c.llegados++;
        cuenta.set(i.fiesta_id, c);
      });
      return respuesta(200, {
        hoy: hoyMadrid(),
        fiestas: rF.data.map(f => ({ ...f, ...(cuenta.get(f.id) || { invitados: 0, llegados: 0 }) }))
      });
    }

    if (event.httpMethod !== 'POST') return respuesta(405, { error: 'Método no permitido' });
    const body = leerBody(event);

    if (body.accion === 'crear') {
      const fila = datosFiesta(body, true);
      const { data, error } = await supabase.from('fiestas').insert({ ...fila, creado_por: usuario.id }).select('*').single();
      if (error) throw error;
      // El cumpleañero queda ya apuntado el primero de la lista
      await supabase.from('fiesta_invitados').insert({ fiesta_id: data.id, nombre: fila.cumpleanero, es_cumpleanero: true, relacion: 'HIJO', orden: 0 });
      const enlace = await enlaceOrganizador(event, data, usuario.id);
      return respuesta(200, { fiesta: await detalle(data.id), enlace });
    }

    if (body.accion === 'editar') {
      const id = Number(body.id);
      const actual = await detalle(id);
      const fila = datosFiesta(body, false);
      const { error } = await supabase.from('fiestas').update(fila).eq('id', id);
      if (error) throw error;
      // Si cambia la fecha, el enlace tiene que valer hasta el nuevo día
      let enlace = null;
      if (fila.fecha !== actual.fecha) enlace = await enlaceOrganizador(event, { ...actual, ...fila }, usuario.id);
      return respuesta(200, { fiesta: await detalle(id), enlace });
    }

    if (body.accion === 'enlace') {
      const fiesta = await detalle(Number(body.id));
      if (fiesta.anulada) throw errorHttp(400, 'Esta fiesta está anulada.');
      return respuesta(200, { enlace: await enlaceOrganizador(event, fiesta, usuario.id) });
    }

    if (body.accion === 'anular') {
      const id = Number(body.id);
      const { error } = await supabase.from('fiestas').update({ anulada: true }).eq('id', id);
      if (error) throw error;
      await supabase.from('enlaces').update({ anulado: true }).eq('fiesta_id', id);
      return respuesta(200, { fiesta: await detalle(id) });
    }

    if (body.accion === 'llegada') {
      const id = Number(body.invitado_id);
      const { data, error } = await supabase.from('fiesta_invitados')
        .update({ ha_llegado: !!body.ha_llegado }).eq('id', id).select('fiesta_id').single();
      if (error) throw error;
      return respuesta(200, { fiesta: await detalle(data.fiesta_id) });
    }

    if (body.accion === 'invitado') {
      const fiestaId = Number(body.fiesta_id);
      const nombre = texto(body.nombre);
      if (!nombre) throw errorHttp(400, 'Escribe el nombre del niño.');
      let edad = null;
      if (body.edad !== '' && body.edad !== null && body.edad !== undefined) {
        edad = Number(body.edad);
        if (!Number.isInteger(edad) || edad < 0 || edad > 17) throw errorHttp(400, 'La edad no es válida.');
      }
      const { error } = await supabase.from('fiesta_invitados').insert({
        fiesta_id: fiestaId, nombre, edad, avisos: texto(body.avisos, 200), orden: 999, ha_llegado: !!body.ha_llegado,
        relacion: body.relacion === 'HIJO' ? 'HIJO' : 'REPRESENTADO'
      });
      if (error) throw error;
      return respuesta(200, { fiesta: await detalle(fiestaId) });
    }

    if (body.accion === 'quitar_invitado') {
      const id = Number(body.invitado_id);
      const { data, error } = await supabase.from('fiesta_invitados').delete().eq('id', id).select('fiesta_id').single();
      if (error) throw error;
      return respuesta(200, { fiesta: await detalle(data.fiesta_id) });
    }

    if (body.accion === 'relacion') {
      const id = Number(body.invitado_id);
      const relacion = body.relacion === 'HIJO' ? 'HIJO' : 'REPRESENTADO';
      const { data, error } = await supabase.from('fiesta_invitados').update({ relacion }).eq('id', id).select('fiesta_id').single();
      if (error) throw error;
      return respuesta(200, { fiesta: await detalle(data.fiesta_id) });
    }

    if (body.accion === 'ficha') {
      const id = Number(body.invitado_id);
      const ninoId = body.nino_id ? Number(body.nino_id) : null;
      if (ninoId) {
        const { data: n } = await supabase.from('ninos').select('id').eq('id', ninoId).maybeSingle();
        if (!n) throw errorHttp(404, 'Ese niño ya no existe.');
      }
      const { data, error } = await supabase.from('fiesta_invitados').update({ nino_id: ninoId }).eq('id', id).select('fiesta_id').single();
      if (error) throw error;
      return respuesta(200, { fiesta: await detalle(data.fiesta_id) });
    }

    throw errorHttp(400, 'Acción desconocida.');
  } catch (e) {
    return responderError(e, 'fiestas');
  }
};
