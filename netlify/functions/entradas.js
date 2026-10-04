// /.netlify/functions/entradas
// GET                                              → tickets de hoy + tipo de día (LJ / FINDE)
// POST { tutor_id, nino_ids, metodo_pago }          → cobra la entrada y devuelve el ticket
// POST { accion:'anular', ticket_id, motivo }       → anula un ticket
const {
  supabase, respuesta, leerBody, requerirUsuario, hoyMadrid, texto, errorHttp, responderError
} = require('./_lib');

const SELECT_TICKET = `
  id, numero, fecha, creado_at, total, metodo_pago, anulado, anulado_motivo, enviado_whatsapp,
  tutores ( id, nombre, apellidos, telefono ),
  usuarios ( nombre ),
  ticket_lineas ( id, descripcion, precio, tarifa_codigo, ninos ( id, nombre, apellidos ) )
`;

function formato(t) {
  return {
    id: t.id, numero: t.numero, fecha: t.fecha, creado_at: t.creado_at,
    total: Number(t.total), metodo_pago: t.metodo_pago,
    anulado: t.anulado, anulado_motivo: t.anulado_motivo, enviado_whatsapp: t.enviado_whatsapp,
    tutor: t.tutores, usuario: t.usuarios?.nombre || null,
    lineas: (t.ticket_lineas || [])
      .sort((a, b) => a.id - b.id)
      .map(l => ({ descripcion: l.descripcion, precio: Number(l.precio), tarifa_codigo: l.tarifa_codigo, nino: l.ninos }))
  };
}

async function leerTicket(id) {
  const { data, error } = await supabase.from('tickets').select(SELECT_TICKET).eq('id', id).single();
  if (error) throw error;
  return formato(data);
}

const ERRORES_SQL = {
  SIN_NINOS: 'No hay niños seleccionados.',
  TARIFA_NO_ENCONTRADA: 'Falta una tarifa en Configuración. Avisa al administrador.',
  METODO_NO_VALIDO: 'Elige efectivo o tarjeta.'
};

exports.handler = async (event) => {
  const { usuario, error: errAuth } = await requerirUsuario(event);
  if (errAuth) return errAuth;

  try {
    // ---------- Tickets de hoy ----------
    if (event.httpMethod === 'GET') {
      const hoy = hoyMadrid();
      const [rT, rD] = await Promise.all([
        supabase.from('tickets').select(SELECT_TICKET).eq('fecha', hoy).order('creado_at', { ascending: false }),
        supabase.rpc('tipo_dia', { p_fecha: hoy })
      ]);
      if (rT.error) throw rT.error;
      if (rD.error) throw rD.error;
      return respuesta(200, { fecha: hoy, tipoDia: rD.data, tickets: rT.data.map(formato) });
    }

    if (event.httpMethod !== 'POST') return respuesta(405, { error: 'Método no permitido' });
    const body = leerBody(event);

    // ---------- Anular ----------
    if (body.accion === 'anular') {
      const id = Number(body.ticket_id);
      const motivo = texto(body.motivo, 200);
      if (!id) throw errorHttp(400, 'Falta el ticket.');
      if (!motivo || motivo.length < 3) throw errorHttp(400, 'Escribe por qué se anula.');

      const { data: t } = await supabase.from('tickets').select('id, fecha, anulado').eq('id', id).maybeSingle();
      if (!t) throw errorHttp(404, 'El ticket no existe.');
      if (t.anulado) throw errorHttp(400, 'Este ticket ya estaba anulado.');
      if (t.fecha !== hoyMadrid() && usuario.rol !== 'ADMIN') {
        throw errorHttp(403, 'Solo se pueden anular tickets de hoy. Pídeselo al administrador.');
      }

      const { error } = await supabase.from('tickets')
        .update({ anulado: true, anulado_motivo: `${motivo} (${usuario.nombre})`, anulado_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
      return respuesta(200, { ticket: await leerTicket(id) });
    }

    // ---------- Cobrar ----------
    const tutorId = Number(body.tutor_id);
    const ninoIds = [...new Set((body.nino_ids || []).map(Number).filter(Boolean))];
    if (!tutorId) throw errorHttp(400, 'Elige quién trae a los niños.');
    if (!ninoIds.length) throw errorHttp(400, 'No hay niños seleccionados.');

    const { data: ticketId, error } = await supabase.rpc('crear_ticket_entrada', {
      p_tutor_id: tutorId,
      p_ninos: ninoIds,
      p_metodo: body.metodo_pago || null,
      p_usuario_id: usuario.id
    });
    if (error) {
      const clave = Object.keys(ERRORES_SQL).find(k => (error.message || '').includes(k));
      if (clave) throw errorHttp(400, ERRORES_SQL[clave]);
      throw error;
    }
    return respuesta(200, { ticket: await leerTicket(ticketId) });
  } catch (e) {
    return responderError(e, 'entradas');
  }
};
