// /.netlify/functions/enlaces   (personal: administrador, monitora y camarero)
// POST { accion:'registro', telefono }   → crea un enlace de registro de 24 h y devuelve el mensaje de WhatsApp
// GET  ?llegadas=1                        → familias registradas hoy con el enlace que esperan a que se les cobre
// POST { accion:'descartar', id }         → quita una llegada de la lista (no vino, se cobró aparte...)
const {
  supabase, respuesta, leerBody, requerirUsuario, normalizarTelefono, hoyMadrid, errorHttp, responderError
} = require('./_lib');
const { nuevoEnlace, fichasNinos } = require('./_enlaces');

const HORAS_VALIDEZ_REGISTRO = 24;

async function llegadasPendientes() {
  const { data, error } = await supabase.from('llegadas')
    .select('id, created_at, nino_ids, tutores ( id, nombre, apellidos, telefono )')
    .eq('fecha', hoyMadrid()).eq('estado', 'PENDIENTE').order('created_at');
  if (error) throw error;
  const ids = [...new Set(data.flatMap(l => l.nino_ids))];
  const fichas = new Map((await fichasNinos(ids)).map(f => [f.id, f]));
  return data.map(l => ({
    id: l.id, created_at: l.created_at, tutor: l.tutores,
    ninos: l.nino_ids.map(id => fichas.get(Number(id))).filter(Boolean)
  }));
}

exports.handler = async (event) => {
  const { usuario, error: errAuth } = await requerirUsuario(event);
  if (errAuth) return errAuth;

  try {
    if (event.httpMethod === 'GET') {
      if (event.queryStringParameters?.llegadas) return respuesta(200, { llegadas: await llegadasPendientes() });
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
