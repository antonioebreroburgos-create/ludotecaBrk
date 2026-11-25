// /.netlify/functions/enlaces   (personal: administrador, monitora y camarero)
// POST { accion:'registro', telefono }   → crea un enlace de registro de 24 h y devuelve el mensaje de WhatsApp
// GET  ?llegadas=1                        → familias registradas hoy con el enlace que esperan a que se les cobre
// POST { accion:'descartar', id }         → quita una llegada de la lista (no vino, se cobró aparte...)
// POST { accion:'pantalla' }              → QR de alta para enseñar en el móvil del personal (vale 10 minutos)
// GET  ?cartel=1                           → QR del cartel de alta (solo ADMIN)
// POST { accion:'cartel_nuevo' }          → crea un QR de cartel nuevo y anula el anterior (solo ADMIN)
const {
  supabase, respuesta, leerBody, requerirUsuario, normalizarTelefono, hoyMadrid, errorHttp, responderError
} = require('./_lib');
const { nuevoEnlace, fichasNinos, baseUrl } = require('./_enlaces');

const HORAS_VALIDEZ_REGISTRO = 24;
const MINUTOS_VALIDEZ_PANTALLA = 10;

async function cartelActual(event) {
  const { data, error } = await supabase.from('enlaces')
    .select('id, token_visible, created_at').eq('tipo', 'CARTEL').eq('anulado', false)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!data?.token_visible) return null;
  const { count } = await supabase.from('altas_publicas').select('id', { count: 'exact', head: true }).eq('enlace_id', data.id);
  return { url: `${baseUrl(event)}/registro.html?t=${data.token_visible}`, creado: data.created_at, altas: count || 0 };
}

async function llegadasPendientes() {
  const { data, error } = await supabase.from('llegadas')
    .select('id, created_at, nino_ids, origen, tutores ( id, nombre, apellidos, telefono )')
    .eq('fecha', hoyMadrid()).eq('estado', 'PENDIENTE').order('created_at');
  if (error) throw error;
  const ids = [...new Set(data.flatMap(l => l.nino_ids))];
  const fichas = new Map((await fichasNinos(ids)).map(f => [f.id, f]));
  return data.map(l => ({
    id: l.id, created_at: l.created_at, tutor: l.tutores, origen: l.origen,
    ninos: l.nino_ids.map(id => fichas.get(Number(id))).filter(Boolean)
  }));
}

exports.handler = async (event) => {
  const { usuario, error: errAuth } = await requerirUsuario(event);
  if (errAuth) return errAuth;

  try {
    if (event.httpMethod === 'GET') {
      if (event.queryStringParameters?.llegadas) return respuesta(200, { llegadas: await llegadasPendientes() });
      if (event.queryStringParameters?.cartel) {
        if (usuario.rol !== 'ADMIN') throw errorHttp(403, 'Solo el administrador gestiona el cartel.');
        return respuesta(200, { cartel: await cartelActual(event) });
      }
      throw errorHttp(400, 'Consulta no válida.');
    }
    if (event.httpMethod !== 'POST') return respuesta(405, { error: 'Método no permitido' });
    const body = leerBody(event);

    if (body.accion === 'registro') {
      const telefono = normalizarTelefono(body.telefono);
      if (!telefono) throw errorHttp(400, 'El teléfono no es válido. Escribe los 9 números.');
      const caducaAt = new Date(Date.now() + HORAS_VALIDEZ_REGISTRO * 3600 * 1000).toISOString();
      const { url } = await nuevoEnlace(event, { tipo: 'REGISTRO', telefono, caducaAt, usuarioId: usuario.id });
      const mensaje = [
        '¡Hola! 👋 Bienvenidos a la *Ludoteca de Restaurante Brooklyn*.',
        '',
        'Para que los peques puedan entrar, rellena aquí vuestros datos (es un momento):',
        url,
        '',
        'El enlace vale 24 horas. Cuando lo envíes, avisa al personal y os cobramos la entrada. 🎈'
      ].join('\n');
      return respuesta(200, { telefono, url, mensaje });
    }

    if (body.accion === 'pantalla') {
      const caducaAt = new Date(Date.now() + MINUTOS_VALIDEZ_PANTALLA * 60e3).toISOString();
      const { url } = await nuevoEnlace(event, { tipo: 'PANTALLA', caducaAt, usuarioId: usuario.id });
      return respuesta(200, { url, caduca_at: caducaAt });
    }

    if (body.accion === 'cartel_nuevo') {
      if (usuario.rol !== 'ADMIN') throw errorHttp(403, 'Solo el administrador gestiona el cartel.');
      await supabase.from('enlaces').update({ anulado: true }).eq('tipo', 'CARTEL').eq('anulado', false);
      await nuevoEnlace(event, { tipo: 'CARTEL', caducaAt: '2100-01-01T00:00:00Z', usuarioId: usuario.id, visible: true });
      return respuesta(200, { cartel: await cartelActual(event) });
    }

    if (body.accion === 'descartar') {
      const id = Number(body.id);
      if (!id) throw errorHttp(400, 'Falta la llegada.');
      const { error } = await supabase.from('llegadas')
        .update({ estado: 'DESCARTADA', resuelta_at: new Date().toISOString(), resuelta_por: usuario.id })
        .eq('id', id).eq('estado', 'PENDIENTE');
      if (error) throw error;
      return respuesta(200, { llegadas: await llegadasPendientes() });
    }

    throw errorHttp(400, 'Acción desconocida.');
  } catch (e) {
    return responderError(e, 'enlaces');
  }
};
